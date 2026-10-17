# Hosting the dashboard publicly, on the instance

> Deployment-specific values appear as `<placeholders>` — `<infra-repo>`,
> `<region>`, `<host>`. This repository is public, so the real values are kept
> in an untracked `DEPLOYMENT.local.md` and in the private infrastructure
> repository rather than here.

A plan, not a record: none of this is implemented. It replaces the SSH tunnel
described in [aws-shared-ec2.md](./aws-shared-ec2.md#how-the-dashboard-is-reached)
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
  runs five other bots, and the security group is shared, so Caddy on 80/443 is the
  first shared ingress on it and opening those ports affects every tenant.
  Caddy's package, systemd unit, Caddyfile and the 80/443 rules therefore live
  in `<infra-repo>`
  (`tickets.tf` and the bootstrap script), not in this repo's deploy. The
  practical consequence: **this repo's `deploy.yml` never touches Caddy**, and
  a second bot wanting TLS adds a site block rather than a second proxy.
  Prefer a `conf.d` include per bot over one monolithic Caddyfile, so the bots
  stay independently deployable.

## Code changes

Three. The first is done, the other two are configuration rather than code.

### 1. Secure cookies — done

`src/routes/auth/callback.js` and `logout.js` hardcoded `secure: false`, and
`login.js` set the `oauth2-state` cookie with no `secure` flag at all. All
three now call `useSecureCookies()` from `src/lib/misc.js`, which derives it
from `HTTP_EXTERNAL`:

```js
module.exports.useSecureCookies = () => (process.env.HTTP_EXTERNAL ?? '').startsWith('https://');
```

Derived rather than simply set to `true`, because both deployments are
legitimate and each fails silently the wrong way round: without the flag a
public dashboard sends its session cookie over the internet in the clear, and
with it hardcoded the tunnel cannot log in at all, because a `Secure` cookie
is never sent over plain HTTP. It lives in one place because getting it right
in two of three call sites is the likely mistake.

`login.js` keeps `sameSite: 'lax'`, which is deliberate: that cookie has to
survive the cross-site redirect back from Discord.

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
in `<infra-repo>`, not here:

| Variable | Now | Becomes |
|---|---|---|
| `HTTP_EXTERNAL` | `http://localhost:8169` | `https://<host>` |
| `HTTP_TRUST_PROXY` | `false` | `true` |
| `HTTP_HOST` | `127.0.0.1` | unchanged — deliberately |
| `HTTP_PORT` | `8169` | unchanged |
| `HTTP_INTERNAL` | empty | unchanged — must stay empty |
| `HTTP_RATE_LIMIT` | unset (300) | raise if administrators share an address |

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

- **Rate limiting — done.** `@fastify/rate-limit`, configured in
  `src/lib/ratelimit.js`: 300 requests per minute per address by default,
  tunable with `HTTP_RATE_LIMIT`, with `/status` exempt so health polling
  cannot lock itself out.

  The hook order is the whole point and the obvious configuration is wrong.
  With `global: true` the plugin's hook runs **after** a route's own
  `onRequest` hooks, so `fastify.authenticate` answers `401` first and the
  limiter never counts the request — leaving an unauthenticated flood against
  the API completely unlimited, which is the one case it exists for. It is
  therefore registered with `global: false` and added as an instance-level
  hook, which runs first. `scripts/check-ratelimit.js` pins that, and fails if
  it is ever reverted.

  The cost of that ordering is the key: `req.user` does not exist yet, so
  counting is per address, not per user. Administrators behind one address
  share an allowance — which is what `HTTP_RATE_LIMIT` is for. It also means
  `HTTP_TRUST_PROXY` must be true behind Caddy, or every request appears to
  come from the proxy and shares a single bucket.
- **Security headers**, covered by the Caddyfile above — still to do.

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
| Does Caddy belong to this bot or the instance? | The instance — `<infra-repo>` |
| HTTP-01 or DNS-01? | HTTP-01, so port 80 stays open |
| Public panel, or keep the tunnel? | Public — other people need to administer the bot |
| Who counts as an admin? | `ManageGuild`, or a role named "admin"; `SUPER` stays empty |

## Who can get in

This is the part that matters most once the panel is public, and it is already
built: there are **no dashboard accounts**. Identity is a Discord login, and
authority is read from Discord at request time.

| Level | Who | Source |
|---|---|---|
| 4 OPERATOR | the `SUPER` env list | `src/client.js:82` |
| 3 GUILD_OWNER | the guild's owner | Discord |
| 2 GUILD_ADMIN | has `ManageGuild`, **or holds a role named "admin"** | Discord |
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
- **`SUPER` is global and bypasses every guild check**, so it stays empty.
  See [The `SUPER` list](#the-super-list) — including the one step that is
  still outstanding on the instance.
- **`INVALIDATE_TOKENS`** invalidates every issued session at once
  (`src/http.js:37`), which is the lever to pull if a session is suspected
  leaked. Worth knowing it exists *before* needing it.

Level 1 confers **nothing** in the dashboard, despite the name. Staff powers
are Discord-side — claim, close, move, transcript — and go through `isStaff`
in the command handlers, not the HTTP API. Every ticket-data route is `isAdmin`
(level ≥ 2); the only non-admin ticket route is
`api/guilds/[guild]/tickets/@me.js`, which returns the caller's own tickets and
gates on `isMember`, so it is open to any guild member rather than to staff
specifically.

## The `SUPER` list

**Decided: `SUPER` stays empty, and `ManageGuild` is the admin threshold.**

`SUPER` is a comma-separated list of Discord user IDs that `src/client.js`
reads into `client.supers`. It is the only identity that outranks a guild
owner: `getPrivilegeLevel` returns 4 for it unconditionally, and `isStaff`
returns true for it in every guild, bypassing the per-guild permission checks
entirely. It is also not a secret — it is a user ID, so possession of the
account is all it takes. Nothing in the codebase requires level 4: `isAdmin`
gates on `>= 2`, and the two slash commands that consult `supers` fall through
to their normal checks when it is empty.

Three of the four things that needed fixing are done:

- **Upstream's default, which was somebody else's account, is gone.**
  `scripts/preinstall.js` hardcoded `SUPER: '319467558166069248'` — inherited
  from upstream, not an account we control — and `preinstall` writes its
  defaults into a `.env` it generates. It is now `''`. The deployed instance
  was never affected: the deploy runs `bun install` with `CI=true`, which makes
  `preinstall` exit before writing, and it only ever writes when `.env` is
  absent, which the deploy separately asserts it is not.
- **It is validated.** `src/env.js` was `SUPER: () => true`, so anything
  passed. It now requires empty or a comma-separated list of 17–20 digit
  snowflakes, and fails startup otherwise.
- **It is parsed properly.** `(process.env.SUPER ?? '').split(',')` yielded
  `['']` when unset and did not trim, so `SUPER=111, 222` silently granted only
  the first. It now trims, drops empties, and logs a warning naming anyone it
  does grant — so a non-empty list is visible in `journalctl` rather than only
  in a file nobody reads.

`scripts/check-privileges.js` pins all of this, and runs as part of
`bun run test`.

### Still to do, on the instance

The deployed value is seeded by the infra bootstrap, so none of the above
changes it. It is not visible from this repo:

```
sudo grep '^SUPER=' /opt/tickets-bot/app/.env || echo 'SUPER not set'
```

Unset or empty is the intended state. If it holds anything, clear it there and
in `<infra-repo>` so the next bootstrap does not put it back.

## The "admin" role

A role whose **name** is exactly `admin` — case-insensitive, trimmed — also
reaches level 2, so its holders can administer the bot through the dashboard.
This exists so administration can be delegated without handing out
`ManageGuild`, which carries a great deal else.

The match is exact, so `Administrator`, `admin-helper`, `non-admin` and
`server admin` do **not** qualify. That is deliberate and tested; a substring
match would hand admin to roles nobody meant to privilege.

**Know what this costs.** Role names are not access-controlled the way
permissions are. Anyone who can create or rename a role — `ManageRoles`, which
is weaker than `ManageGuild` — can grant themselves bot administration by
naming a role "admin". On a server where `ManageRoles` is handed out more
freely than `ManageGuild`, this is a privilege escalation path that did not
exist before. It is a deliberate trade, not an oversight, but it is worth
re-checking who holds `ManageRoles` before the dashboard is public.

It is currently a constant (`ADMIN_ROLE_NAME` in `src/lib/users.js`), not a
setting. Making it configurable per guild would mean a column, a migration and
a dashboard field; worth doing only if a second name is ever wanted.

Note the asymmetry: an "admin" role grants dashboard administration but **not**
staff powers in Discord. `isStaff` checks `ManageGuild` and the categories'
staff roles, and is unchanged — so an "admin" role holder can edit categories
in the dashboard but cannot claim or close a ticket unless that role is also
listed as a category staff role.

## The rest of the public surface

Going public exposes more than the settings pages. Every route was checked;
these are the ones that are not `isAdmin`:

| Route | Gate | Exposes |
|---|---|---|
| `/status` | none | Gateway ping and shard status |
| `/api/client` | none | Aggregate stats: ticket, guild, category and tag counts, total members, archived message count, average rating and response times |
| `/api/locales` | none | Translation strings |
| `/api/guilds`, `/api/admin/guilds` | authenticated | Only guilds where the caller is owner or has `ManageGuild`, so nothing leaks |
| `/api/guilds/:guild` | member | Guild name, icon, the caller's own privilege level |
| `/api/guilds/:guild/tickets/@me` | member | The caller's own tickets |
| `/api/users/@me/key` | authenticated | Mints an API token for the caller — see below |

`/api/client` is the one to think about: no per-ticket content, but it is
business telemetry — how many tickets exist, how fast they are answered, how
they are rated — readable by anyone who finds the hostname.

It cannot simply be blocked at Caddy: the dashboard's own root layout fetches
it from the browser, so denying it breaks the dashboard. The choices are to
accept the exposure, or to put it behind `fastify.authenticate` and have the
layout handle a 401 — a change in both repos, which is why this is a decision
rather than a line in the Caddyfile. `/status` has no such constraint and can
be blocked or left; it reveals only gateway ping and shard state.

**API keys deserve a decision.** Any authenticated user can mint themselves a
token from `/api/users/@me/key`, and that token carries `service: true`, which
skips the OAuth re-consent check in `isAdmin`. It does **not** skip the
privilege check — `getPrivilegeLevel(guildMember) >= 2` still runs
(`src/http.js:103`), so a non-admin gains nothing. But the token is signed
with no `expiresAt`, and `authenticate` only rejects a token whose `expiresAt`
is in the past (`src/http.js:36`), so **it never expires**; the only revocation
is moving `INVALIDATE_TOKENS`, which revokes everyone's. Setting
`PUBLIC_BOT=true` disables the endpoint outright, at the cost of disabling API
keys for you too.

## Multiple administrators at once

New with this change, and not currently handled: the category editor PATCHes
the whole category object, so two admins editing the same category will have
the last save win silently. The interim transcripts page avoided this by
sending only changed rows; the forked dashboard does not. Not a blocker — a
small team rarely collides — but if it bites, the fix is to send only dirty
fields rather than to add locking.
