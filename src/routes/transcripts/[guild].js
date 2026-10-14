/**
 * A small admin page for setting each category's transcript channel.
 *
 * The stock dashboard (`@discord-tickets/settings`) publishes only its build
 * output, so its category editor cannot be taught a new field without forking
 * and rebuilding that package on every release. This page is served by our
 * own fastify instance instead, on the same origin and behind the same login,
 * and drives the existing category API rather than adding write paths of its
 * own.
 *
 * Served at /transcripts/:guild. Log in to the dashboard first; the session
 * cookie is what authorises both this page and the PATCH calls it makes.
 */

const { ChannelType } = require('discord.js');

/** Escape a value for interpolation into HTML. */
function esc(value) {
	return String(value ?? '').replace(/[&<>"']/g, c => ({
		'"': '&quot;',
		'&': '&amp;',
		'\'': '&#39;',
		'<': '&lt;',
		'>': '&gt;',
	}[c]));
}

const STYLE = `
	:root { color-scheme: light dark; --fg: #1a1d21; --bg: #f7f8fa; --card: #fff; --line: #d8dde4; --accent: #5865f2; --muted: #666e7a; }
	@media (prefers-color-scheme: dark) {
		:root { --fg: #e6e9ee; --bg: #16181d; --card: #1e2126; --line: #333841; --accent: #818cf8; --muted: #949cab; }
	}
	* { box-sizing: border-box; }
	body { background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, sans-serif; margin: 0; padding: 32px 20px 64px; }
	main { margin: 0 auto; max-width: 760px; }
	h1 { font-size: 22px; margin: 0 0 6px; }
	p.lede { color: var(--muted); margin: 0 0 24px; }
	table { background: var(--card); border: 1px solid var(--line); border-collapse: collapse; border-radius: 6px; width: 100%; }
	th, td { border-bottom: 1px solid var(--line); padding: 12px 14px; text-align: left; }
	tr:last-child td { border-bottom: 0; }
	th { font-size: 12px; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
	select { background: var(--bg); border: 1px solid var(--line); border-radius: 4px; color: var(--fg); max-width: 100%; padding: 7px 8px; width: 280px; }
	button { background: var(--accent); border: 0; border-radius: 5px; color: #fff; cursor: pointer; font: inherit; font-weight: 600; margin-top: 20px; padding: 10px 18px; }
	button:disabled { opacity: .55; cursor: default; }
	#status { margin-top: 14px; min-height: 1.5em; }
	#status.ok { color: #1a7f5a; }
	#status.err { color: #b3261e; }
	@media (prefers-color-scheme: dark) { #status.ok { color: #5fd3a3; } #status.err { color: #ef8b84; } }
	code { background: var(--bg); border-radius: 3px; padding: 1px 4px; }
`;

module.exports.get = fastify => ({
	handler: async (req, res) => {
		/** @type {import('client')} */
		const client = req.routeOptions.config.client;
		const guildId = req.params.guild;
		/** @type {import('discord.js').Guild} */
		const guild = client.guilds.cache.get(guildId);

		const categories = await client.prisma.category.findMany({
			orderBy: { name: 'asc' },
			select: {
				emoji: true,
				id: true,
				name: true,
				transcriptChannel: true,
			},
			where: { guildId },
		});

		const channels = [...guild.channels.cache.values()]
			.filter(channel => channel.type === ChannelType.GuildText)
			.sort((a, b) => a.name.localeCompare(b.name));

		const rows = categories.map(category => {
			const options = [
				'<option value="">(none — do not post)</option>',
				...channels.map(channel =>
					`<option value="${esc(channel.id)}"${channel.id === category.transcriptChannel ? ' selected' : ''}>#${esc(channel.name)}</option>`,
				),
			];
			// A channel that has since been deleted, or that the bot can no
			// longer see, would otherwise vanish from the select and be
			// silently cleared on the next save.
			if (category.transcriptChannel && !channels.some(c => c.id === category.transcriptChannel)) {
				options.push(`<option value="${esc(category.transcriptChannel)}" selected>${esc(category.transcriptChannel)} (not visible to the bot)</option>`);
			}
			return `<tr>
				<td>${esc(category.emoji)} ${esc(category.name)}</td>
				<td><select data-category="${esc(category.id)}" data-original="${esc(category.transcriptChannel ?? '')}">${options.join('')}</select></td>
			</tr>`;
		});

		const body = categories.length
			? `<table>
					<thead><tr><th>Category</th><th>Transcript channel</th></tr></thead>
					<tbody>${rows.join('')}</tbody>
				</table>
				<button id="save" type="button">Save changes</button>
				<div id="status" role="status"></div>`
			: '<p>This server has no ticket categories yet. Create one in the dashboard first.</p>';

		// Only changed rows are sent, so a save cannot overwrite a field that
		// someone else edited in the meantime.
		const script = `
			const saveButton = document.getElementById('save');
			const status = document.getElementById('status');
			saveButton?.addEventListener('click', async () => {
				const changed = [...document.querySelectorAll('select')]
					.filter(select => select.value !== select.dataset.original);
				if (!changed.length) {
					status.className = '';
					status.textContent = 'Nothing to save.';
					return;
				}
				saveButton.disabled = true;
				status.className = '';
				status.textContent = 'Saving ' + changed.length + '...';
				const failures = [];
				for (const select of changed) {
					try {
						const response = await fetch(
							'/api/admin/guilds/' + ${JSON.stringify(guildId)} + '/categories/' + select.dataset.category,
							{
								body: JSON.stringify({ transcriptChannel: select.value || null }),
								credentials: 'same-origin',
								headers: { 'content-type': 'application/json' },
								method: 'PATCH',
							},
						);
						if (!response.ok) {
							const detail = await response.json().catch(() => ({}));
							failures.push(select.dataset.category + ': ' + (detail.message || response.status));
						} else {
							select.dataset.original = select.value;
						}
					} catch (error) {
						failures.push(select.dataset.category + ': ' + error.message);
					}
				}
				saveButton.disabled = false;
				if (failures.length) {
					status.className = 'err';
					status.textContent = 'Failed: ' + failures.join('; ');
				} else {
					status.className = 'ok';
					status.textContent = 'Saved. New tickets closed in these categories will post there.';
				}
			});
		`;

		return res.type('text/html; charset=utf-8').send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Transcript channels · ${esc(guild.name)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
	<h1>Transcript channels</h1>
	<p class="lede">
		When a ticket in one of these categories is closed, its transcript is posted
		to the channel chosen here. A category set to <em>none</em> falls back to
		<code>transcripts.onClose</code> in <code>config.yml</code>, and posts
		nothing if that is unset too.
	</p>
	${body}
</main>
<script>${script}</script>
</body>
</html>`);
	},
	onRequest: [fastify.authenticate, fastify.isAdmin],
});
