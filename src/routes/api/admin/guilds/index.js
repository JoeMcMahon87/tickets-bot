const { PermissionsBitField } = require('discord.js');
const { iconURL } = require('../../../../lib/misc');
const ms = require('ms');

module.exports.get = fastify => ({
	handler: async (req, res) => {
		const { client } = req.routeOptions.config;

		// Discord rate-limits `/users/@me/guilds` tightly — roughly one
		// request per second per token — and the dashboard asks for this twice
		// while loading. The second call then came back as a rate-limit object
		// rather than an array, and `guilds.filter` threw a TypeError that
		// surfaced as a 500 with no useful message.
		//
		// Caching the list per user removes the duplicate call, and keeps a
		// usable answer for a minute when Discord does push back.
		const cacheKey = `cache/user-guilds:${req.user.id}`;
		let guilds = await client.keyv.get(cacheKey);

		if (!guilds) {
			const response = await fetch(
				'https://discordapp.com/api/users/@me/guilds',
				{ headers: { 'Authorization': `Bearer ${req.user.accessToken}` } },
			);

			if (!response.ok) {
				const detail = await response.text().catch(() => '');
				client.log.warn(
					'Discord returned %d for /users/@me/guilds: %s',
					response.status,
					detail.slice(0, 200),
				);
				const rateLimited = response.status === 429;
				return res.code(rateLimited ? 429 : 502).send({
					error: rateLimited ? 'Too Many Requests' : 'Bad Gateway',
					message: rateLimited
						? 'Discord is rate limiting this request; try again in a moment.'
						: 'Discord could not be reached to list your servers.',
					statusCode: rateLimited ? 429 : 502,
				});
			}

			guilds = await response.json();

			// Anything other than an array means Discord answered with
			// something that is not the guild list. It must never reach
			// `.filter()`, which is what produced the original 500.
			if (!Array.isArray(guilds)) {
				client.log.warn(
					'Unexpected /users/@me/guilds response: %s',
					JSON.stringify(guilds).slice(0, 200),
				);
				return res.code(502).send({
					error: 'Bad Gateway',
					message: 'Discord returned an unexpected response while listing your servers.',
					statusCode: 502,
				});
			}

			await client.keyv.set(cacheKey, guilds, ms('1m'));
		}

		// Only the Discord list is cached, never this mapping: `added` is read
		// from the live cache, so inviting the bot shows up immediately.
		return res.send(
			guilds
				.filter(guild => guild.owner || new PermissionsBitField(guild.permissions.toString()).has(PermissionsBitField.Flags.ManageGuild))
				.map(guild => ({
					added: client.guilds.cache.has(guild.id),
					id: guild.id,
					logo: iconURL(
						client.guilds.cache.get(guild.id) ||
						{
							client,
							icon: guild.icon,
							id: guild.id,
						},
					),
					name: guild.name,
				})),
		);
	},
	onRequest: [fastify.authenticate],
});
