# Hosting the dashboard publicly, on the instance

A plan, not a record: none of this is implemented. It replaces the SSH tunnel
described in [aws-shared-ec2.md](./aws-shared-ec2.md#the-dashboard-is-never-exposed-publicly)
with a real hostname and real TLS, terminated by Caddy on the instance itself.

**Why:** other people need to administer the bot, and a tunnel cannot be
delegated — it needs an SSH key on the shared instance, which is a far larger
grant than "can edit ticket categories". A public panel authenticated by
Discord is the smaller privilege, not the larger one. That reframes the
trade-off below: the tunnel is not being given up for convenience, it is being
given up because it is the wrong tool for more than one administrator.

## Why not CloudFront

The earlier CloudFront revision was dropped because CloudFront can only reach
this origin over plain HTTP — the instance has no certificate for its
`compute.amazonaws.com` name, and CloudFront rejects self-signed origin
certificates — so session cookies would have crossed the public internet in
the clear. Fixing that means giving the origin a real certificate on a real
domain, at which point the certificate alone is sufficient and CloudFront is
no longer doing anything the dashboard needs. It caches nothing here: every
route is dynamic and cookie-authenticated, and a cache policy that got it
wrong would serve one admin's logged-in page to another visitor.

CloudFront is worth revisiting only for what it uniquely offers — hiding the
origin IP, WAF, DDoS absorption — none of which are the reason for wanting a
public dashboard.

## The shape of it

```
          443 ──▶ Caddy (instance) ──▶ 127.0.0.1:8169 (bot)
browser ──┤        TLS terminates here
           80 ──▶ Caddy, redirect to 443
```

**The bot keeps its loopback bind.** This is the main advantage over every
proxy-in-front-of-EC2 arrangement, CloudFront included: `HTTP_HOST` stays
`127.0.0.1`, the bot never listens on a public interface, and the only process
accepting outside connections is Caddy. The security control that matters most
today survives the change intact.

## Prerequisites

- **A domain**, with a record you can point at the instance's Elastic IP.
  Any registrar; Route 53 is convenient but not required (~$0.50/mo for a
  hosted zone if you use it).
- **Caddy belongs to the instance, not to this bot** (decided). This box also
  runs LizardsColosseum, GronkGameBot, Innkeeper, daggerheart-support-bot and
  runescribe, and the security group is shared, so Caddy on 80/443 is the
  first shared ingress on it and opening those ports affects every tenant.
  Caddy's package, systemd unit, Caddyfile and the 80/443 rules therefore live
  in [DiscordBotInfrastructure](https://github.com/JoeMcMahon87/DiscordBotInfrastructure)
  (`tickets.tf` and the bootstrap script), not in this repo's deploy. The
  practical consequence: **this repo's `deploy.yml` never touches Caddy**, and
  a second bot wanting TLS adds a site block rather than a second proxy.
  Prefer a `conf.d` include per bot over one monolithic Caddyfile, so the bots
  stay independently deployable.

## Code changes

Three, all small, and the first is not optional — the cookies are currently
hardcoded insecure, which is harmless on loopback and wrong the moment the
dashboard is reachable over HTTPS.

### 1. Secure cookies

`src/routes/auth/callback.js:69` and `src/routes/auth/logout.js:19` both set
`secure: false`. Derive it instead, so the tunnel keeps working for anyone
who still uses it:

```js
secure: process.env.HTTP_EXTERNAL.startsWith('https'),
```

`src/routes/auth/login.js:14` sets the `oauth2-state` cookie with no `secure`
flag at all; it needs the same treatment. Keep its `sameSite: 'lax'` — that is
deliberate, and `Strict` would break the cross-site redirect back from Discord.
The `token` cookie's `sameSite: 'Strict'` is fine as it is, because the
callback sets it on its own response and then meta-refreshes to an internal
URL.

A `scripts/check-*.js` case asserting the flag follows `HTTP_EXTERNAL` would
match how the rest of this repo is tested, and would stop the flag silently
regressing to `false`.

### 2. Trust the proxy

`src/http.js:1` reads `HTTP_TRUST_PROXY`. It must be `true`, or
`X-Forwarded-Proto` and `-For` are ignored and every request appears to arrive
from `127.0.0.1` over HTTP. Trusting *all* proxies is safe in this topology
precisely because the bot is on loopback: nothing but Caddy can reach it.

### 3. Nothing for `ORIGIN`, but check it

`src/http.js:8` sets `ORIGIN` from `HTTP_INTERNAL || HTTP_EXTERNAL`, and
SvelteKit's adapter-node uses it for CSRF origin checks. Setting
`HTTP_EXTERNAL` to the public URL is enough **provided `HTTP_INTERNAL` stays
empty**. If it is ever set to the loopback URL, form POSTs from the dashboard
start failing as cross-origin.

## Environment

Seeded in `/opt/tickets-bot/app/.env` by the infra bootstrap, so these change
in `DiscordBotInfrastructure`, not here:

| Variable | Now | Becomes |
|---|---|---|
| `HTTP_EXTERNAL` | `http://localhost:8169` | `https://<host>` |
| `HTTP_TRUST_PROXY` | `false` | `true` |
| `HTTP_HOST` | `127.0.0.1` | unchanged — deliberately |
| `HTTP_PORT` | `8169` | unchanged |
| `HTTP_INTERNAL` | empty | unchanged — must stay empty |

`HTTP_EXTERNAL` is not only the OAuth `redirect_uri`. It is also the link the
bot gives people in `src/listeners/client/messageCreate.js:41` and
`src/routes/api/admin/guilds/[guild]/panels.js:154`, so changing it changes
user-facing messages — which is the point, since a `localhost` link in a
Discord message is useless to anyone.

## Caddy

Amazon Linux 2023 has no Caddy package; use the official static `arm64`
binary (the instance is `aarch64`) and a systemd unit, which is also what
makes it reproducible from the bootstrap script.

```
# /etc/caddy/Caddyfile
<host> {
	encode zstd gzip
	reverse_proxy 127.0.0.1:8169

	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options "nosniff"
		Referrer-Policy "same-origin"
		X-Frame-Options "DENY"
	}
}
```

Caddy obtains and renews the certificate itself, using **HTTP-01** (decided).
That means:

- **Port 80 must stay open permanently**, not just for the first issuance.
  Certificates renew roughly every 60 days, and a renewal that cannot complete
  is a silent problem until the certificate expires. Caddy will serve the
  HTTP→HTTPS redirect on the same port, which is what people get when they
  type the hostname — so 80 earns its place twice.
- No IAM role is needed, which is the reason to prefer it here: DNS-01 would
  have required giving Caddy `route53:ChangeResourceRecordSets` on the zone,
  and a credential on the box is a worse thing to own than an open port 80
  that only ever serves a redirect and a challenge response.
- Worth an alert either way: certificate expiry is the most likely way this
  setup breaks months later, with no deploy to correlate it with.

The headers above are the cheapest part of the hardening and belong in Caddy
rather than the app, since the app serves the dashboard through SvelteKit's
handler and would have to inject them per-response.

## Security group and DNS

- Open **443 and 80** to `0.0.0.0/0` on the shared group, in `tickets.tf`
  rather than by hand, so it survives the next `terraform apply`. Both stay
  open permanently: 80 for HTTP-01 renewals and the redirect. The doc's existing warning applies: confirm that adding
  an inline `ingress` block does not churn the shared group.
- **8169 stays closed.** It is never reachable from outside; Caddy talks to it
  over loopback.
- An **A record** for the hostname pointing at the Elastic IP. The address is
  already static, which is what makes this simple.
- SSH stays restricted to `admin_cidr` plus the deploy's temporary runner-IP
  rule. Nothing about this change touches that.

## Discord application

Add `https://<host>/auth/callback` to the OAuth2 redirect URIs. Keep
`http://localhost:8169/auth/callback` registered if you want the tunnel to
keep working as a fallback — Discord allows several, and `localhost` is its
documented exemption from the HTTPS requirement.

## Before it goes public

The dashboard stops being unreachable-by-default. Two gaps that are irrelevant
on loopback become prerequisites, not nice-to-haves:

- **Rate limiting.** `src/http.js` registers no `@fastify/rate-limit`, and it
  is not a dependency. There is no password to brute-force — authentication is
  Discord OAuth — but `/auth/login` and every API route become publicly
  reachable, and an unauthenticated flood currently meets no limit at all on a
  2-vCPU box shared with five other bots. Caddy can do this, but the plugin is
  better placed because it can key on the authenticated user and exempt
  admins.
- **Security headers**, covered by the Caddyfile above.

The authorisation model itself needs no work — see
[Who can get in](#who-can-get-in). It is the reason this is tractable: the
panel is public, but authority still comes from Discord on every request.

## Rollback

Keeping the tunnel working costs nothing and is the rollback: the tunnel is
unaffected by any of this as long as the localhost redirect URI stays
registered and the cookie `secure` flag is derived from `HTTP_EXTERNAL` rather
than hardcoded `true`. To back out, point `HTTP_EXTERNAL` back at
`http://localhost:8169`, set `HTTP_TRUST_PROXY=false`, stop Caddy and close
80/443. No data or schema is involved.

Note what a rollback costs now that delegation is the point: it takes the
other administrators' access away with it, since the tunnel needs an SSH key
they do not have. Treat it as an incident measure, not a routine one — and
prefer narrowing the security group to known source addresses over reverting
to the tunnel outright.

## Cost

| Item | Cost |
|---|---|
| Domain | ~$12–15/yr |
| Route 53 hosted zone | ~$0.50/mo, and only if you use Route 53 |
| Caddy, Let's Encrypt certificates | free |
| Extra AWS charges | none — no ALB, no CloudFront, no new instance |

Caddy's own footprint is a few tens of MB of RSS, which is worth a glance
against the memory headroom item in
[aws-shared-ec2.md](./aws-shared-ec2.md#still-to-do) before committing: that
box is a 2-vCPU `t4g.small` already running six bots, and its free memory has
not yet been measured on the real instance.

## Decisions

| Question | Decision |
|---|---|
| Does Caddy belong to this bot or the instance? | The instance — `DiscordBotInfrastructure` |
| HTTP-01 or DNS-01? | HTTP-01, so port 80 stays open |
| Public panel, or keep the tunnel? | Public — other people need to administer the bot |

## Who can get in

This is the part that matters most once the panel is public, and it is already
built: there are **no dashboard accounts**. Identity is a Discord login, and
authority is read from Discord at request time.

| Level | Who | Source |
|---|---|---|
| 4 OPERATOR | the `SUPER` env list | `src/client.js:82` |
| 3 GUILD_OWNER | the guild's owner | Discord |
| 2 GUILD_ADMIN | has `ManageGuild` | Discord |
| 1 GUILD_STAFF | holds a category staff role | the bot's own settings |
| 0 / -1 | everyone else | — |

Every admin route is gated by `fastify.authenticate` and then `isAdmin`
(`src/http.js:74`), which requires level ≥ 2 — so `ManageGuild`, guild owner,
or a super. It additionally requires the session to carry the
`applications.commands.permissions.update` scope, replying `401` with
`elevate: 'admin'` when it does not, which is what drives the dashboard's
re-consent prompt. Every write endpoint then validates its body against
`src/schemas/`, so unknown keys never reach Prisma.

Three consequences worth being deliberate about:

- **Granting and revoking access is a Discord action**, not a dashboard one.
  Someone gains admin by getting `ManageGuild` in the server and loses it by
  having it removed. There is no invite flow to build and no credential to
  leak — and offboarding someone from Discord offboards them from the panel.
  This is the strongest argument that a public panel is a *smaller* grant than
  an SSH key.
- **`SUPER` is global and bypasses every guild check.** It should name the
  fewest possible people. Audit it before going public; it is set from the
  environment, so it is as sensitive as any secret in `.env`.
- **`INVALIDATE_TOKENS`** invalidates every issued session at once
  (`src/http.js:37`), which is the lever to pull if a session is suspected
  leaked. Worth knowing it exists *before* needing it.

Only `ManageGuild` holders can change settings, but **level 1 staff can read
ticket data** through the non-admin API, which is a wider audience than the
tunnel ever exposed. That is the intended design, not a flaw — just worth
knowing that "public" now includes everyone holding a staff role.

## Multiple administrators at once

New with this change, and not currently handled: the category editor PATCHes
the whole category object, so two admins editing the same category will have
the last save win silently. The interim transcripts page avoided this by
sending only changed rows; the forked dashboard does not. Not a blocker — a
small team rarely collides — but if it bites, the fix is to send only dirty
fields rather than to add locking.
