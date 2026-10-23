<div align="center">

![bots](https://img.shields.io/badge/dynamic/json?color=5865F2&label=bots&query=combined.active.count&url=https%3A%2F%2Fstats.discordtickets.app%2Fapi%2Fv4%2Fcurrent&logo=discord&logoColor=white&style=for-the-badge)
![tickets](https://img.shields.io/badge/dynamic/json?color=5865F2&label=tickets&query=combined.total.tickets&url=https%3A%2F%2Fstats.discordtickets.app%2Fapi%2Fv4%2Fcurrent&logo=discord&logoColor=white&style=for-the-badge)
[![GitHub stars](https://img.shields.io/github/stars/discord-tickets/bot?style=for-the-badge)](https://github.com/discord-tickets/bot/stargazers)
[![Codacy](https://img.shields.io/codacy/grade/b974eb5f984c40868e07d82c968bd02d?logo=codacy&amp;style=for-the-badge)](https://app.codacy.com/gh/discord-tickets/bot/dashboard)
[![All Contributors](https://img.shields.io/github/all-contributors/discord-tickets/bot?color=ee8449&style=for-the-badge)](https://github.com/discord-tickets/bot/blob/main/CONTRIBUTORS.md)
[![Discord](https://img.shields.io/discord/451745464480432129?label=discord&amp;color=7289DA&amp;style=for-the-badge)](https://lnk.earth/discord)

<br>

![Discord Tickets](https://static.eartharoid.me/discord-tickets/logo/wordmark/gradient-by-eartharoid.png)

**A free alternative to the premium and white-label plans of other ticket management bots.**

<br>
<a
  href="https://www.producthunt.com/posts/discord-tickets?utm_source=badge-featured&utm_medium=badge&utm_souce=badge-discord&#0045;tickets"
  target="_blank">
<img
	src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=321112&theme=light"
	alt="Discord&#0032;Tickets - A&#0032;free&#0032;ticketing&#0032;solution | Product Hunt"
	style="width: 250px; height: 54px;"
	width="250"
	height="54"
  />
</a>

<br>

---

[![BisectHosting](https://www.bisecthosting.com/partners/custom-banners/41ca8074-184e-4ad1-a44d-77750ee8bfb9.webp)](https://bisecthosting.com/discordtickets)

<a href="https://bisecthosting.com/discordtickets">Partnered with BisectHosting</a>
<br>
<sub>for affordable bot hosting</sub>

---

<br>
</div>

> [!NOTE]
> **This is a modified fork, maintained by Joe McMahon.**
>
> It tracks the upstream project and adds features and fixes for a
> self-hosted deployment. See [Fork modifications](#-fork-modifications) for
> what differs. Everything else, including the documentation linked below,
> refers to the upstream project.

## 📖 Contents

- [📖 Contents](#-contents)
- [🔧 Fork modifications](#-fork-modifications)
- [✨ Features](#-features)
  - [Want to learn more?](#want-to-learn-more)
- [⚡ Getting started](#-getting-started)
- [🤑 Sponsors](#-sponsors)
- [🎖️ Contributors](#️-contributors)
  - [💻 Contributing](#-contributing)
    - [🌎 Translating](#-translating)
- [😕 Support](#-support)
- [⭐ Star History](#-star-history)
- [🥱 License](#-license)


## 🔧 Fork modifications

Changes in this fork that are not in the upstream project. Deployment-specific
values — hostnames, account identifiers, infrastructure names — are kept out of
this repository; they live in the private infrastructure repository and in the
environment.

### Tickets

- **Move button on the opening message.** Staff can move a ticket to another
  category from the ticket itself, rather than only through `/move`. Both paths
  share one implementation, so both also refresh the pinned opening message for
  the new category, ping the roles that are now responsible, and record the
  change in the log channel. Off by default: it needs a server setting plus a
  per-category toggle, mirroring how the claim button works.
- **Claim lockdown is optional per category.** Claiming a ticket normally hides
  it from the category's staff roles, leaving it to the claimer. A category can
  turn that off so its claimed tickets stay visible to all of its staff. On by
  default, which keeps the upstream behaviour.

### Transcripts and storage

- **Transcript channel on close.** Closed tickets' transcripts can be posted to
  a channel, set per category with a server-wide fallback.
- **Optional object storage.** Transcripts and archived attachments can be
  mirrored to S3-compatible storage, with presigned links; local storage
  remains the default. Member avatars are mirrored too, so transcripts keep
  rendering after an avatar changes.
- **Messages from departed members are archived**, rather than being dropped
  when the member can no longer be fetched.

### Dashboard

- **A forked dashboard** adds four settings the stock one has no inputs for:
  a category's transcript channel, whether its tickets may be moved, and
  whether claiming locks its tickets down, plus the server-wide move-button
  toggle.
- **Administration can be delegated without `Manage Server`.** A role named
  `admin` also grants dashboard access. Note the trade: role names are not
  access-controlled the way permissions are, so anyone able to create or rename
  roles can grant themselves access this way.
- **Optional public hosting.** The dashboard can be served over HTTPS by a
  reverse proxy on the host instead of only through an SSH tunnel. The bot
  stays bound to loopback either way.

### Security and robustness

- **Admin API request bodies are validated** against JSON schemas, so unknown
  fields never reach the database layer.
- **Session cookies are `Secure`** when the dashboard is served over HTTPS,
  derived from its configured URL so a tunnelled deployment still works.
- **Request rate limiting**, configurable, applied before authentication so
  unauthenticated traffic is limited too.
- **No cross-server superuser by default.** `Manage Server` is the
  administrative threshold.
- **Clearer panel errors.** A failed panel names the step and the cause —
  including which channel permissions the bot is missing — instead of logging a
  bare API rejection.
- The bot **exits on a failed Discord login** rather than idling, and a
  rate-limited server list is handled instead of throwing.
- **Anonymous statistics reporting is disabled.**

### Deployment

- A **GitHub Actions deploy** to a self-hosted instance, documented in
  [`docs/`](docs/). The bot is stopped before database migrations run.

## ✨ Features

- 📖 [**Documentation**](https://discordtickets.app/getting-started/) - comprehensive documentation and guides to help you get started
- ⚙️ **Simple settings** - configure your bot with the included and easy-to-use dashboard
- 🎨 **Highly customisable** - tweak features, colours, messages, and more to your liking
- 🛸 **Modern features** - including slash commands, buttons, select menus, and modals
- 🤖 **Automation** - ease your staff team's workload with configurable automation
  - 🏷️ [**Tags**](https://v4--discordtickets.netlify.app/features/#tags) - resolve members' problems without escalating to tickets
  - 🎫 **Tickets** - close inactive tickets automatically
- 📜 **Archiving** - store messages in the database and view transcripts later
- ❓ **Context** - ask for a topic or up to 5 custom questions before creating a ticket, and see references to a message or previous ticket at a glance
- 🗃️ **Organisation** - claim, release, move and transfer tickets between members and categories
- 🌎 [**Internationalisation**](#-translating) - available in more than 10 languages
- ⏱️ **Statistics** - analyse your staff members' performance
- 🪓 **Battle-tested** - trusted by thousands of servers, with over [half a million tickets](https://stats.discordtickets.app/) created since 2019
- 🐳 [**Docker**](https://discordtickets.app/self-hosting/installation/docker/) - reliable and quick deployment with Docker

[*...and more!*](https://discordtickets.app/features/)

### Want to learn more?

**Visit [the website](https://discordtickets.app/) for more features, details, and screenshots**,
or skip to the [full feature tour](https://discordtickets.app/features/).

## ⚡ Getting started

> *🙏 Please read the [documentation](https://discordtickets.app/self-hosting/installation/) before you start.*

There are 3 ways to get started with Discord Tickets:

- ☁️ [Add the public bot](https://discordtickets.app/public/) - instant setup, but branded *(great for testing)*
- 😴 [Get a managed bot](https://discordtickets.app/managed/) - your own bot, hosted by me *(easy and cheap)*
- 🧑‍💻 [Install your own bot](https://discordtickets.app/self-hosting/) - host it yourself *(experience recommended)*

**[Read the documentation](https://discordtickets.app/getting-started/)** for more information.

> This button is here because it looks nice, but I will cry if you click it before reading the [documentation](https://discordtickets.app/getting-started/). :)

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template/eB6TkX?referralCode=Z3aYd2)

<!-- [![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/discord-tickets/bot) -->

## 🤑 Sponsors

Discord Tickets is made possible by these awesome people and organisations:

![Sponsors](https://cdn.jsdelivr.net/gh/eartharoid/sponsors/sponsorkit/sponsors-wide.svg)

Please consider sponsoring the project if it adds value to your business/community.

**[Sponsor on GitHub](https://github.com/discord-tickets/bot/?sponsor=1)**, or

[![Donate at ko-fi](https://www.ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/eartharoid)

> [!IMPORTANT]
> **Ko-fi members are not listed.**
> Sponsor through GitHub or a linked Patreon account to be listed above.
> [Create a free organisation](https://github.com/account/organizations/new?plan=free)
> to show your business or community's logo.

## 🎖️ Contributors

<!-- [![Contributors](https://contrib.rocks/image?repo=discord-tickets/bot)](https://github.com/discord-tickets/bot/graphs/contributors) -->

Discord Tickets is made possible by all of the people listed in [CONTRIBUTORS.md](https://github.com/discord-tickets/bot/blob/main/CONTRIBUTORS.md).


### 💻 Contributing

If you want to help translate, suggest a feature, submit a bug report,
or contribute in any other way, please read the [contributing guidelines](https://github.com/discord-tickets/.github/blob/main//CONTRIBUTING.md).

> **Note**
> You can add yourself to the list of contributors [here](https://github.com/discord-tickets/bot/issues/new/choose).

#### 🌎 Translating

[![Translation status](https://hosted.weblate.org/widgets/discord-tickets/-/open-graph.png)](https://hosted.weblate.org/engage/discord-tickets/)

## 😕 Support

[![Discord](https://discordapp.com/api/guilds/451745464480432129/widget.png?style=banner4)](https://lnk.earth/discord)

## ⭐ Star History

<a href="https://star-history.dera.page/#discord-tickets/bot">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://star-history.dera.page/svg?repos=discord-tickets/bot&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://star-history.dera.page/svg?repos=discord-tickets/bot" />
   <img alt="Star History Chart" src="https://star-history.dera.page/svg?repos=discord-tickets/bot" />
 </picture>
</a>

## 🥱 License

Discord Tickets by eartharoid™️ is licensed under the [GPLv3 license](https://github.com/discord-tickets/bot/blob/main/LICENSE).

This is not an official Discord product. It is not affiliated with nor endorsed by Discord Inc.

© 2023 Isaac Saunders
