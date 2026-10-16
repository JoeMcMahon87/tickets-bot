# Hosting the dashboard publicly, on the instance

A plan, not a record: none of this is implemented. It replaces the SSH tunnel
described in [aws-shared-ec2.md](./aws-shared-ec2.md#the-dashboard-is-never-exposed-publicly)
with a real hostname and real TLS, terminated by Caddy on the instance itself.

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
- **A decision about the shared instance.** This box also runs
  LizardsColosseum, GronkGameBot, Innkeeper, daggerheart-support-bot and
  runescribe, and the security group is shared. Caddy on 80/443 would be the
  first shared ingress on it, and opening those ports affects every tenant,
  not just this bot. If another bot later wants TLS, Caddy becomes shared
  infrastructure with a shared config — which argues for putting it in
  `DiscordBotInfrastructure` from the start rather than treating it as part of
  this deploy.

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

Caddy obtains and renews the certificate itself. Two details worth deciding
before the security group changes:

- **TLS-ALPN-01** issuance needs only 443. **HTTP-01** needs 80. Caddy will
  use either, so 443 alone can suffice — but port 80 is still wanted for the
  HTTP→HTTPS redirect, which is what people get when they type the hostname.
- **DNS-01** via Route 53 avoids opening 80 at all, at the cost of giving
  Caddy an IAM role with `route53:ChangeResourceRecordSets` on that zone.

The headers above are the cheapest part of the hardening and belong in Caddy
rather than the app, since the app serves the dashboard through SvelteKit's
handler and would have to inject them per-response.

## Security group and DNS

- Open **443** (and **80** unless using DNS-01) to `0.0.0.0/0` on the shared
  group, in `tickets.tf` rather than by hand, so it survives the next
  `terraform apply`. The doc's existing warning applies: confirm that adding
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

The dashboard stops being unreachable-by-default, and two gaps that are
irrelevant on loopback stop being irrelevant:

- **No rate limiting.** `src/http.js` registers no `@fastify/rate-limit`.
  Authentication is Discord OAuth, so there is no password to brute-force, but
  `/auth/login` and the admin API become publicly reachable endpoints. Caddy
  can do this, or the plugin can, and the plugin is better placed to exempt
  authenticated admins.
- **No security headers**, covered by the Caddyfile above.

Already in decent shape, and worth noting because it carries the weight here:
every admin route is behind `fastify.authenticate` plus
`getPrivilegeLevel`/`isAdmin` against the caller's Discord guild permissions,
and every write endpoint validates its body against `src/schemas/`, so an
authenticated non-admin cannot reach them and unknown keys never reach Prisma.
`INVALIDATE_TOKENS` invalidates every issued session if one leaks.

## Rollback

Keeping the tunnel working costs nothing and is the rollback: the tunnel is
unaffected by any of this as long as the localhost redirect URI stays
registered and the cookie `secure` flag is derived from `HTTP_EXTERNAL` rather
than hardcoded `true`. To back out, point `HTTP_EXTERNAL` back at
`http://localhost:8169`, set `HTTP_TRUST_PROXY=false`, stop Caddy and close
443. No data or schema is involved.

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

## Decisions still open

1. Does Caddy belong to this bot or to the shared instance? Recommended:
   shared, in `DiscordBotInfrastructure`, because the security group and port
   80/443 are shared and a second bot wanting TLS is likely.
2. HTTP-01 (open port 80) or DNS-01 (IAM role, no port 80)?
3. Is a public admin panel actually wanted, versus the tunnel? The tunnel is a
   genuinely strong posture, and it is the only control that currently makes an
   unauthenticated attack on the dashboard impossible rather than merely
   unsuccessful.
