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
| `DISCORD_SECRET` | OAuth2 client secret — required by `src/env.js` even though the dashboard is only reachable over an SSH tunnel; it is what logs you into it |

`ENCRYPTION_KEY` is **not** a GitHub secret. See above.

## Object storage: transcripts, attachments and avatars

These live in [`src/lib/storage.js`](../src/lib/storage.js) and are
**off unless `S3_BUCKET` is set**, so a self-hoster with no AWS account is
unaffected and this stays mergeable with upstream. Every call site treats
storage as fallible and degrades rather than failing the interaction — the bot
staying available matters more than an object reaching S3.

**Transcripts.** `/transcript` renders the whole ticket in memory and sends it
as a Discord attachment, which fails outright once a busy ticket renders past
Discord's upload limit. With a bucket configured it uploads instead and replies
with a presigned link; any failure falls back to the attachment.

**Attachments.** Archived messages previously stored only Discord's CDN URL for
each attachment, and those URLs expire — so old transcripts quietly rot.
Attachments are now mirrored into the bucket and the key recorded as `s3Key`
alongside the original URL.

**Avatars.** Same idea, different failure mode. An avatar URL is unsigned and
does not expire, but the hash stops resolving the moment the member changes
their picture or deletes the account — so the archive does not rot on a timer,
it rots when someone changes their profile, and nothing signals that. This
replaces the standing upstream `// TODO: save avatar in user/avatars/`.

`TicketArchiver.saveAvatar` mirrors the image and records the key in the
existing `ArchivedUser.avatar` column, marked with an `s3:` prefix;
[`src/lib/avatars.js`](../src/lib/avatars.js) encodes and decodes that. Reusing
the column avoids a migration in all three provider directories that would
collide with upstream's own migrations later, and costs nothing, because a
mirrored key ends in `<hash>.webp` — `decodeAvatar` returns both the key and
the hash, for values of either form.

Three details worth knowing:

- Avatars are content-addressed, so one object serves every ticket and message
  that member appears in. An `ArchivedUser` row is upserted *per message*,
  so without the `keyv` dedup cache the archiver would re-upload the same image
  on every message.
- They are mirrored at 128px. An archive thumbnail has no use for the 1024px
  original.
- `member.avatar` is the per-guild avatar and `member.user.avatar` the global
  one, and they live at different CDN paths. Storing only the hash — as this
  did before — left no way to tell which of the two it was, so the URL now
  comes from `displayAvatarURL()`, which resolves it.

Members on a *default* avatar have no hash and are skipped: those are a fixed
set of six images shared by every such user.

### Rendering: where the mirroring pays off

Mirroring bytes is only half the job — the transcript has to *use* them.
[`src/lib/transcript.js`](../src/lib/transcript.js) resolves an archived
ticket's media when a transcript is rendered: a mirrored attachment or avatar
becomes a presigned URL, and anything unmirrored keeps its original Discord
URL. Every path falls back, so a transcript is never worse than it was before
mirroring existed.

This moved the attachment and embed lines out of the transcript worker and
into the main thread, because presigning needs the S3 client and the worker is
a separate thread that exists to offload decryption. The worker now leaves
`message.text` holding just the message body; the tails are appended in the
same order and count it used to produce.

It also sets `avatarUrl` on every archived user, which is what finally gives
the avatar data a consumer — the shipped
`src/user/templates/transcript.md.mustache` now links each participant's
avatar as it was at the time.

> **Updating an existing install's template.** `src/index.js` copies
> `src/user/` into `./user/` with `force: false`, so a deployment that already
> has `user/templates/transcript.md.mustache` keeps its own copy and will not
> pick up the `{{ #avatarUrl }}` line. Copy it across by hand, or delete the
> file and let the bot restore it on next boot. `avatarUrl` is set either way;
> only the shipped template's use of it is new.

**What presigned links in a transcript do and do not buy.** The URLs written
into a given transcript *file* expire, exactly as the Discord URLs they
replace did. The difference is that the objects behind them do not: a
transcript regenerated six months later still has working links, whereas
Discord's copy is long gone. Durability is in the bucket, not in the file.

The dashboard still builds its avatar URLs from the logged-in user and the
bot rather than from `archivedUsers`, so nothing there changes; the ticket
export API returns the raw field, which an export consumer can resolve with
`decodeAvatar` plus `storage.presign`.

That needed no Prisma migration: the attachment list already lives inside the
encrypted JSON blob in `archivedMessages.content`, so adding a field is a
change to the blob's shape, not the schema. The stored shape is otherwise
untouched (`toJSON()` is what `JSON.stringify` called anyway), which matters
because rows written before this change will not have the field.

Two safeguards exist because the shared instance is memory-constrained and a
mirrored object is buffered in full:

- `S3_MAX_ATTACHMENT_SIZE` (default 8 MiB) — larger attachments keep their
  Discord URL. The cap is enforced three times: against the size Discord
  declares, against `Content-Length`, and against the bytes actually received,
  since the first two can lie.
- At most two mirrors run at once, so a burst of messages cannot decide the
  worst-case footprint.

### Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `S3_BUCKET` | — | Enables storage. Unset means everything stays local. |
| `S3_REGION` | `AWS_REGION` | Bucket region. |
| `S3_ENDPOINT` | — | For S3-compatible stores (MinIO, R2); forces path-style addressing. |
| `S3_PREFIX` | — | Key prefix. Multi-segment values keep their slashes. |
| `S3_URL_EXPIRY` | `86400` | Presigned link lifetime, seconds. Clamped to 604800 (the SigV4 maximum). |
| `S3_ARCHIVE_ATTACHMENTS` | `true` when a bucket is set | `false` keeps transcripts but stops mirroring attachments. |
| `S3_ARCHIVE_AVATARS` | `true` when a bucket is set | `false` stores the bare avatar hash, as before this feature. |
| `S3_MAX_ATTACHMENT_SIZE` | `8388608` | Largest attachment mirrored, bytes. |

The bucket uses one prefix per concern, and the lifecycle rules in
`tickets.tf` are written against exactly these names, so the two must agree:
`db-dumps/` (Glacier IR at 30d, expire 365d), `transcripts/` (expire 30d —
they can always be re-rendered), and `attachments/` and `avatars/` (never
expired, because they are the only durable copy).

Four checks run as part of `npm test`, all with `fetch` or `presign` stubbed
and no real bucket involved: `check-avatars.js` (the column encoding),
`check-storage.js` (key building, size caps, the concurrency gate),
`check-archiver.js` (`saveAvatar`'s fallbacks and its dedup cache) and
`check-transcript.js` (media resolution and its fallbacks). `check-archiver.js`
loads the archiver with `src/lib/threads` stubbed out of the require cache,
since requiring it for real spawns five worker pools.

## Transcript archive channel

Closed tickets can have their transcript posted to a channel. It is resolved
per ticket, category first:

1. the ticket's **category** `transcriptChannel`, set on the page below;
2. otherwise `transcripts.onClose` in `user/config.yml`, the server-wide
   fallback;
3. otherwise nothing is posted.

### Per category

Set it in the dashboard, under **Settings → Categories → _category_ →
Transcript channel**. The empty option means "use the server-wide channel".

This was originally a page of our own at `/transcripts/:guild`, because
`@discord-tickets/settings` publishes only its build output and its category
editor could not be taught a new field. The dashboard is now forked, so the
field lives where it belongs and that page is gone — see
[The dashboard is a fork](#the-dashboard-is-a-fork) for how it is built
and installed.

The field itself is `Category.transcriptChannel`, added by the migration
`20261014150000_category_transcript_channel` in all three provider
directories. That was the first schema change in this fork; everything before
it was deliberately shaped to avoid one. It was unavoidable here — there was
no existing column to reuse, and the value genuinely belongs per category —
but it does mean a conflict is possible if upstream ever adds a migration with
an overlapping timestamp.

A channel the bot can no longer see stays visible in the picker, marked, so a
save cannot silently clear it.

### Server-wide fallback

In `user/config.yml`:

```yaml
transcripts:
  onClose: "123456789012345678"      # the same channel for every guild
  # or, keyed by guild ID:
  # onClose:
  #   "987654321098765432": "123456789012345678"
```

**Quote the ID.** A bare Discord ID parses as a YAML number, and a snowflake
is past the point where a double holds one exactly — so the value read back is
not the ID that was typed, and the channel can never resolve. The bot detects
that case and warns rather than searching for a channel that cannot exist.

The bot needs View Channel, Send Messages, Embed Links and Attach Files in
that channel. `null` (the default) posts nothing, so this is off unless asked
for.

The transcript is **attached as a file**, not linked — a presigned link
expires, which would leave an archive channel full of dead URLs within a day.
A transcript over 8 MiB cannot be attached; those fall back to a presigned
link when object storage is configured, and otherwise to a note pointing at
`/transcript`.

This setting lives in `config.yml` rather than the database because the
dashboard is a separate published package that cannot be taught a new field —
a per-guild column would be unreachable from the UI and settable only by hand
in SQL. The trade-off is that changing it means editing the file on the
instance; `user/` is runtime state that deploys never overwrite.

Rendering moved out of the `/transcript` command into
[`src/lib/tickets/transcript.js`](../src/lib/tickets/transcript.js) so the
close path reuses it rather than carrying a second copy of the query,
decryption hand-off, media resolution and template render. The command now
delegates to it. Posting happens last in `finallyClose`, unawaited and with
its own error handling: the ticket is already closed by then, and rendering a
transcript must not be able to interrupt that.

## Anonymous stats reporting is off

`stats: false` in `src/user/config.yml`. Upstream posts anonymous usage figures
to its Houston service on boot and every 12 hours; this fork does not.

It was also failing on every run here with `the response couldn't be parsed:
res.json is not a function` — immediately after upstream's own handler logs
`The following error is not important and can be safely ignored` — so its only
visible effect was a stack trace in the journal twice a day.

Nothing else changes: the averages in the bot's presence and in transcripts
come from `src/lib/stats.js` and its worker pool, which are not gated on this
setting.

**An existing install keeps its own value.** `src/index.js` copies
`src/user/` with `force: false`, so a deployment that already has
`user/config.yml` is unaffected by the shipped default. To turn it off on a
running instance:

```
sudo -u tickets-bot sed -i 's/^stats: true$/stats: false/' \
  /opt/tickets-bot/app/user/config.yml
sudo systemctl restart tickets-bot
```

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

## The dashboard is a fork

`@discord-tickets/settings` is not installed from npm. It resolves to
`github:JoeMcMahon87/portal#build` — the `build` branch of our fork of
[discord-tickets/portal](https://github.com/discord-tickets/portal), which
holds two fields the stock dashboard has no inputs for:

| Field | Where | Column |
| --- | --- | --- |
| Transcript channel | Categories → _category_ | `Category.transcriptChannel` |
| Moving | Categories → _category_ | `Category.moving` |
| Move (button) | General settings → Buttons | `Guild.moveButton` |

The published package ships only its build output, so the source could not be
patched in place; and the bot host has no frontend toolchain, so the fork is
**built in its own CI** and the SvelteKit output committed to the `build`
branch by `.github/workflows/build-branch.yml`. That branch is a build
artefact: it is rewritten from scratch on every push to the fork's `main`, and
its history is not meaningful.

Because the dependency keeps its original **name**, `src/http.js` is unchanged
— it still imports `@discord-tickets/settings/build/handler.js`. Nothing on
the instance builds the dashboard, and `bun install --production` pulls a
ready-made artefact.

Two consequences worth remembering:

- **An upstream dashboard release is not picked up automatically.** Merge
  `upstream/main` into the fork, let CI republish `build`, then re-pin here
  with:

  ```
  bun update @discord-tickets/settings
  ```

  Not `bun install` — that is a no-op. The lockfile records a commit, and a
  pinned commit still satisfies `#build`, so a plain install reports "no
  changes" however far the branch has moved.
- **The fork pins a commit, not a tag.** `bun.lock` records the exact `build`
  branch commit, so a deploy is reproducible even though the branch moves —
  but the publish workflow force-pushes `build`, which leaves the previous
  commit unreferenced. Re-pin promptly after republishing: the running
  instance is unaffected, but a fresh `--frozen-lockfile` deploy against an
  orphaned commit can fail to resolve it.

The fork is based on upstream's `v2.5.5` commit, matching the `~2.5.4` that
was previously resolved from npm, so nothing but these fields changed.

## The dashboard is never exposed publicly

`src/http.js` serves a SvelteKit settings dashboard, and it cannot simply be
switched off: there is **no settings slash command** — the 16 slash commands
are all ticket operations — so categories, panels and staff roles exist only
there, and without a category the bot cannot open a ticket at all.

What it does not need is a public address. It binds to `127.0.0.1`
(`HTTP_HOST=127.0.0.1`), nothing in the security group opens its port, and you
reach it over an SSH tunnel when a guild needs configuring:

```
ssh -i <key> -L 8169:127.0.0.1:8169 ec2-user@<ec2-host>
# then open http://localhost:8169
```

Discord exempts `http://localhost` from its HTTPS requirement for OAuth
redirect URIs, so login works through the tunnel.
`http://localhost:8169/auth/callback` is the only redirect that needs
registering in the Discord application, and `HTTP_EXTERNAL` is set to
`http://localhost:8169` to match. SSH comes from the `admin_cidr` the shared
security group already allows. `HTTP_TRUST_PROXY` is `false`, since nothing
sits in front of it.

An earlier revision put a CloudFront distribution in front of it for free TLS
and a public hostname. That was dropped: CloudFront can only reach this origin
over plain HTTP — the instance has no certificate for its
`compute.amazonaws.com` name, and CloudFront rejects self-signed origin
certificates — so dashboard session cookies would have crossed the public
internet in the clear. A tunnel avoids that completely and costs nothing. If
the dashboard ever needs to be genuinely public, the way to do it is a domain
plus either TLS terminated on the instance (Caddy/Let's Encrypt, origin
`https-only`) or an ALB holding an ACM certificate (~$16/mo).

[public-dashboard.md](./public-dashboard.md) plans the first of those, which
also keeps the bot on its loopback bind — Caddy is then the only process
listening publicly. It is a plan; none of it is implemented.

## Still to do

1. **Memory headroom.** `src/lib/threads.js` eagerly spawns five reusable
   worker pools at module load, each sized from `cpus().length`. On a 2-vCPU
   `t4g.small` already running five Python bots that is tight — the bootstrap
   sets `CPU_LIMIT=1` (read at `src/lib/threads.js:33`) and adds a 2 GB
   swapfile. Check actual free memory on the box; budget a bump to
   `t4g.medium` (~$27/mo) if it is thin. This is the one assumption behind the
   cost estimate below that has not been verified on the real instance.
2. **Prisma on ARM64.** Engines resolve `linux-arm64-openssl-3.0.x`
   automatically when generated on the instance, which is what the deploy
   does. If `prisma generate` ever moves to the x86 runner, `binaryTargets`
   must be set explicitly in the schema.
3. **`terraform plan` has not been run** — it needs real credentials. It is
   worth reading before the first apply, in particular to confirm that adding
   an inline `ingress` block does not churn the shared security group.

## Cost

Marginal cost of adding this bot to the existing fleet, assuming the shared
instance has headroom: roughly **$0–1/month** — S3 pennies at this volume,
no CloudFront, no load balancer, no database instance, and $0 additional
compute (or +$14/mo if the instance is bumped to `t4g.medium`). Figures are
approximate; check current `eu-west-3` pricing.
