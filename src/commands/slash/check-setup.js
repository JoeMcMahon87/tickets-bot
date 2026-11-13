const { SlashCommand } = require('@eartharoid/dbf');
const {
	MessageFlags,
	PermissionsBitField,
} = require('discord.js');
const ExtendedEmbedBuilder = require('../../lib/embed');
const {
	LOG_CHANNEL,
	TICKET_CATEGORY,
	TRANSCRIPT_CHANNEL,
	checkGuild,
} = require('../../lib/channel-health');

/**
 * Discord allows 25 fields on an embed. One is kept back to say how many
 * problems did not fit, because silently truncating the list would be worse
 * than a short report that admits it is short.
 */
const MAX_PROBLEM_FIELDS = 24;

/** The order problems are listed in: where a ticket dies first comes first. */
const KIND_ORDER = [TICKET_CATEGORY, LOG_CHANNEL, TRANSCRIPT_CHANNEL];

module.exports = class CheckSetupSlashCommand extends SlashCommand {
	constructor(client, options) {
		const name = 'check-setup';
		super(client, {
			...options,
			description: client.i18n.getMessage(null, `commands.slash.${name}.description`),
			descriptionLocalizations: client.i18n.getAllMessages(`commands.slash.${name}.description`),
			dmPermission: false,
			name,
			nameLocalizations: client.i18n.getAllMessages(`commands.slash.${name}.name`),
		});
	}

	/**
	 * Group problems by the channel they are about, keeping `botPublic` apart.
	 *
	 * The admin acts per channel -- they open one channel's permissions and fix
	 * everything wrong with it -- so the report is grouped the same way rather
	 * than listing one permission per line.
	 */
	groupByChannel(problems) {
		const groups = new Map();
		const loose = [];

		for (const problem of problems) {
			if (!problem.channelId) {
				loose.push(problem);
				continue;
			}
			const key = `${problem.kind}:${problem.channelId}`;
			if (!groups.has(key)) {
				groups.set(key, {
					channelId: problem.channelId,
					kind: problem.kind,
					names: problem.names,
					problems: [],
				});
			}
			groups.get(key).problems.push(problem);
		}

		return {
			groups: [...groups.values()].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)),
			loose,
		};
	}

	/** The heading for a group: what the channel is, and what points at it. */
	fieldName(getMessage, group) {
		const kind = getMessage(`commands.slash.check-setup.kinds.${group.kind}`);
		if (group.names.length === 0) return kind;
		return `${kind} — ${group.names.join(', ')}`;
	}

	/**
	 * What the run looked at, as a sentence.
	 *
	 * Each count is a separate message so its own plural form applies; one
	 * sentence with three numbers in it cannot be pluralised in a language that
	 * agrees differently with each.
	 */
	summarise(getMessage, targets) {
		const prefix = 'commands.slash.check-setup.summary';
		const counted = kind => targets.filter(target => target.kind === kind).length;
		const parts = [
			[TICKET_CATEGORY, 'categories'],
			[LOG_CHANNEL, 'log'],
			[TRANSCRIPT_CHANNEL, 'transcripts'],
		].map(([kind, key]) => {
			const count = counted(kind);
			return getMessage(`${prefix}.${key}`, count, count);
		});
		return getMessage(`${prefix}.checked`, { targets: parts.join(', ') });
	}

	/** One line per problem, in the words an admin can act on. */
	fieldValue(getMessage, group) {
		const prefix = 'commands.slash.check-setup.problems';
		const missing = group.problems
			.filter(problem => problem.id.endsWith('MissingPermission'))
			.map(problem => problem.permission);
		const lines = [];

		if (group.problems.some(problem => problem.id === 'channelMissing')) {
			lines.push(getMessage(`${prefix}.channel_missing`, { channel: group.channelId }));
		}

		const wrongType = group.problems.find(problem => problem.id === 'channelWrongType');
		if (wrongType) {
			lines.push(getMessage(`${prefix}.channel_wrong_type`, {
				channel: group.channelId,
				expected: getMessage(`commands.slash.check-setup.expected.${wrongType.expected}`),
			}));
		}

		if (missing.length > 0) {
			lines.push(getMessage(`${prefix}.missing_permissions`, {
				channel: group.channelId,
				permissions: missing.map(permission => `\`${permission}\``).join(', '),
			}));
		}

		for (const problem of group.problems.filter(p => p.id === 'missingOptionalPermission')) {
			lines.push(getMessage(`${prefix}.missing_optional_permission`, {
				feature: getMessage(`commands.slash.check-setup.features.${problem.feature}`),
				permission: `\`${problem.permission}\``,
			}));
		}

		return lines.join('\n');
	}

	/**
	 * @param {import("discord.js").ChatInputCommandInteraction} interaction
	 */
	async run(interaction) {
		/** @type {import("client")} */
		const client = this.client;

		await interaction.deferReply({ flags: MessageFlags.Ephemeral });

		const settings = await client.prisma.guild.findUnique({ where: { id: interaction.guild.id } }) ??
			await client.prisma.guild.create({ data: { id: interaction.guild.id } });
		const getMessage = client.i18n.getLocale(settings.locale);
		const footer = {
			iconURL: interaction.guild.iconURL(),
			text: settings.footer,
		};

		// Reading another server's permissions is harmless, but the report
		// names channels a non-admin has no business enumerating.
		const isAdmin = client.supers.includes(interaction.user.id) ||
			interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild);
		if (!isAdmin) {
			return await interaction.editReply({
				embeds: [
					new ExtendedEmbedBuilder(footer)
						.setColor(settings.errorColour)
						.setTitle(getMessage('commands.slash.check-setup.not_admin.title'))
						.setDescription(getMessage('commands.slash.check-setup.not_admin.description')),
				],
			});
		}

		const categories = await client.prisma.category.findMany({ where: { guildId: interaction.guild.id } });
		const {
			problems, targets,
		} = checkGuild({
			categories,
			config: client.config,
			guild: interaction.guild,
			isBotPublic: process.env.PUBLIC_BOT !== 'true' && client.application.botPublic,
			log: client.log,
			settings,
		});

		const summary = this.summarise(getMessage, targets);

		// A clean run has to say something. The usual reason for running this is
		// a suspicion that a permission is missing, and silence does not answer
		// it -- naming what was checked does.
		if (problems.length === 0) {
			return await interaction.editReply({
				embeds: [
					new ExtendedEmbedBuilder(footer)
						.setColor(settings.successColour)
						.setTitle(getMessage('commands.slash.check-setup.ok.title'))
						.setDescription(`${getMessage('commands.slash.check-setup.ok.description')}\n\n${summary}`),
				],
			});
		}

		const {
			groups, loose,
		} = this.groupByChannel(problems);
		const fields = groups.slice(0, MAX_PROBLEM_FIELDS).map(group => ({
			name: this.fieldName(getMessage, group),
			value: this.fieldValue(getMessage, group),
		}));

		if (groups.length > MAX_PROBLEM_FIELDS) {
			const extra = groups.length - MAX_PROBLEM_FIELDS;
			fields.push({
				name: getMessage('commands.slash.check-setup.truncated.title'),
				value: getMessage('commands.slash.check-setup.truncated.description', extra, extra),
			});
		}

		const description = [
			getMessage('commands.slash.check-setup.problems_found.description'),
			summary,
			...loose
				.filter(problem => problem.id === 'botPublic')
				.map(() => getMessage('commands.slash.check-setup.problems.bot_public')),
		].join('\n\n');

		return await interaction.editReply({
			embeds: [
				new ExtendedEmbedBuilder(footer)
					.setColor(settings.errorColour)
					.setTitle(getMessage('commands.slash.check-setup.problems_found.title'))
					.setDescription(description)
					.addFields(fields),
			],
		});
	}
};
