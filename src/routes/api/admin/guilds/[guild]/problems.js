const {
	DASHBOARD_PROBLEM_IDS,
	checkGuild,
} = require('../../../../../lib/channel-health');

module.exports.get = fastify => ({
	handler: async req => {
		/** @type {import('client')} */
		const client = req.routeOptions.config.client;
		const id = req.params.guild;
		const guild = client.guilds.cache.get(id);
		const settings = await client.prisma.guild.findUnique({ where: { id } }) ??
			await client.prisma.guild.create({ data: { id } });
		const categories = await client.prisma.category.findMany({ where: { guildId: id } });

		const { problems } = checkGuild({
			categories,
			config: client.config,
			guild,
			isBotPublic: process.env.PUBLIC_BOT !== 'true' && client.application.botPublic,
			log: client.log,
			settings,
		});

		// The dashboard renders by problem ID and prints the raw object for an ID
		// it does not know, so the fuller report -- ticket categories, transcript
		// channels, deleted channels -- is held back until it learns them. Those
		// problems are not lost: `/check-setup` shows all of them in Discord.
		return problems.filter(problem => DASHBOARD_PROBLEM_IDS.includes(problem.id));
	},
	onRequest: [fastify.authenticate, fastify.isAdmin],
});
