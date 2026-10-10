# Deploying on the shared Discord-bots AWS infrastructure

This fork is deployed onto the shared ARM64 EC2 instance managed by
[DiscordBotInfrastructure](https://github.com/JoeMcMahon87/DiscordBotInfrastructure),
alongside the other bots on that box (LizardsColosseum, GronkGameBot,
Innkeeper, daggerheart-support-bot, runescribe). It runs as the `tickets-bot`
systemd service from `/opt/tickets-bot`, deployed by
[`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) on every push
to `main`.

## Why the bot is not on Lambda

Worth stating up front, because "Discord bot on AWS" usually means Lambda +
API Gateway, and that cannot work for this codebase:

- `src/client.js` requests the `MessageContent`, `GuildMembers` and
  `GuildPresences` gateway intents and uses `shards: 'auto'`. The bot needs a
  persistent WebSocket with heartbeats.
- Discord's HTTP-interactions transport (the Lambda-compatible one) delivers
  only slash-command and component payloads. It never delivers `messageCreate`,
  `channelDelete` or `guildMemberRemove` — and ticket transcripts are built
  entirely from `messageCreate` (`src/listeners/client/messageCreate.js`).
- `awaitMessageComponent` collectors, the `keyv` cache and
  `TicketManager.$stale` are all live in-process state.
- `handleStaleTickets` needs a logged-in client (`client.channels.fetch`,
  `client.application.commands.cache`).

An always-on container (Fargate, App Runner) *would* work but costs 3–5× the
shared `t4g.small`, which already runs the rest of the fleet. So the gateway
process stays on EC2, and serverless is used for the parts that are genuinely
bursty: object storage, backups, CDN and secrets.

## Database: SQLite on the instance volume

`DB_PROVIDER=sqlite`, with the database at `/opt/tickets-bot/app/user/database.db`
on the instance's encrypted gp3 root volume.

This is already a first-class path in the codebase — `scripts/postinstall.js`
selects the SQLite schema and migrations, `src/lib/middleware/prisma-sqlite.js`
rewrites the queries that need it, and `src/client.js` enables WAL mode and a
6-hourly `PRAGMA optimize`.

DynamoDB was considered and rejected: there are ~154 `client.prisma.*` call
sites using relational features Dynamo has no equivalent for (7-way `include`
joins to build a transcript, `@@unique([guildId, number])` ticket numbering,
cascade deletes across five archive tables, full-table aggregations in
`src/lib/stats.js`). It would be a fork-wide rewrite that permanently ends the
ability to merge upstream `4.0.x` fixes, and it would not save money — at this
volume the database cost is a rounding error either way.

Aurora DSQL was also rejected: it is genuinely serverless and scales to zero,
but the schema depends on foreign keys and `@default(autoincrement())`, neither
of which DSQL supports. Aurora Serverless v2 at its 0.5-ACU floor is ~$44/mo
and would never idle down, because the bot queries continuously.

**Durability trade-off:** the bot and its data share one EBS volume, so losing
the instance costs up to a day of tickets. If that is unacceptable, RDS
`db.t4g.micro` MySQL is ~$17/mo and needs no code change — just
`DB_PROVIDER=mysql` and a `DB_CONNECTION_URL`. Nightly dumps to S3
(below) are the cheaper mitigation.

## `ENCRYPTION_KEY` must never change

Ticket topics, archived message content, usernames, close reasons and feedback
comments are all encrypted at rest with `ENCRYPTION_KEY` (`src/lib/crypto.js`).
If that value changes, **every existing archive becomes permanently
unreadable** — there is no recovery.

Two things in this repo make that an easy mistake to trip over:

- `scripts/preinstall.js` generates a *fresh* random `ENCRYPTION_KEY` and
  writes a new `.env` whenever `.env` is absent and `ENCRYPTION_KEY` is unset.
- A naive deploy that rewrites `.env` from CI secrets would overwrite the key
  on every run.

So the deploy workflow deliberately:

1. sets `CI=true` for both `bun install` and the explicit `postinstall` run, which
   makes `preinstall` exit early instead of writing a `.env`;
2. **refuses to deploy** if `/opt/tickets-bot/app/.env` is missing, empty, or has
   no non-empty `ENCRYPTION_KEY=` line;
3. injects only `DISCORD_TOKEN` and `DISCORD_SECRET` — the rotatable
   credentials — and leaves every other line of `.env` untouched.

The key is seeded once, by the infrastructure bootstrap, from an SSM Parameter
Store `SecureString`. Standard-tier Parameter Store is free, and it means the
key survives both instance replacement and loss of the GitHub repository.

## Required GitHub secrets

The first five are shared across all the bot repos on this instance; run
`print-github-secrets.sh` in DiscordBotInfrastructure after `terraform apply`
to get them.

| Secret | Purpose |
|---|---|
| `EC2_HOST` | Elastic IP of the shared instance |
| `EC2_SECURITY_GROUP_ID` | Security group the deploy temporarily opens for SSH |
| `EC2_SSH_KEY` | Private key for `ec2-user` |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | Deployer IAM user (open/close SSH only) |
| `AWS_REGION` | Region of the shared instance |
| `DISCORD_TOKEN` | Bot token — specific to this repo |
| `DISCORD_SECRET` | OAuth2 client secret, for the dashboard login — specific to this repo |

`ENCRYPTION_KEY` is **not** a GitHub secret. See above.

## Backups

[`scripts/backup-s3.sh`](../scripts/backup-s3.sh) runs the repo's own
`scripts/dump.mjs` (a logical JSON dump, restorable with `scripts/restore.mjs`
and portable across providers), uploads it to S3, and prunes local copies. It is
driven by a systemd timer on the instance rather than a Lambda, because a Lambda
cannot reach a SQLite file on an EBS volume.

Bucket lifecycle rules handle expiry and the Glacier transition, so the script
only prunes locally. Configuration comes from `.env`:

```
BACKUP_BUCKET=<from terraform output tickets_backup_bucket>
BACKUP_PREFIX=db-dumps   # optional
BACKUP_KEEP=7            # optional, days of local dumps to keep
```

## Still to do on the infrastructure side

These belong in DiscordBotInfrastructure, not here:

1. **A Node.js variant of `setup_bot`.** The current helper in `user_data.sh`
   is Python-only — it hardcodes `python3.12 -m venv`. This bot needs
   `nodejs22` (in the AL2023 repos) plus `bun` (the repo ships `bun.lock` and
   no `package-lock.json`, so `npm ci` cannot work), and a unit with
   `ExecStart=/usr/bin/node src/`, `WorkingDirectory=/opt/tickets-bot/app`.
2. **`tickets.tf`** — notably smaller than `lizards.tf` since there is no
   DynamoDB table: an S3 bucket (backups + transcripts) with lifecycle rules, a
   CloudFront distribution for the dashboard, SSM parameters for
   `ENCRYPTION_KEY`, and an IAM policy addition on the existing
   `shared_bots_ec2` role.
3. **Dashboard ingress.** `src/http.js` serves a SvelteKit dashboard, and
   Discord OAuth needs a public HTTPS `HTTP_EXTERNAL`, but the shared security
   group currently has *no* 443 ingress. CloudFront gives free TLS and is
   effectively free at this volume; restrict the SG's 443 ingress to the
   `com.amazonaws.global.cloudfront.origin-facing` managed prefix list. An ALB
   would be ~$16/mo for the same job.
4. **Memory headroom.** `src/lib/threads.js` eagerly spawns five reusable
   worker pools at module load, each sized from `cpus().length`. On a 2-vCPU
   `t4g.small` already running five Python bots that is tight — set
   `CPU_LIMIT=1` in `.env` (read at `src/lib/threads.js:33`) and add swap.
   Check actual free memory on the box before committing; budget a bump to
   `t4g.medium` (~$27/mo) if it is thin.
5. **A `tickets-backup.timer`** unit invoking `scripts/backup-s3.sh` daily.
6. **Prisma on ARM64.** Engines resolve `linux-arm64-openssl-3.0.x`
   automatically when generated on the instance, which is what the deploy does.
   If `prisma generate` ever moves to the x86 runner, `binaryTargets` must be
   set explicitly in the schema.

## Cost

Marginal cost of adding this bot to the existing fleet, assuming the shared
instance has headroom: roughly **$0–2/month** (S3 and CloudFront pennies at
this volume; $0 additional compute, or +$14/mo if the instance is bumped to
`t4g.medium`). Figures are approximate — check current `eu-west-3` pricing.
