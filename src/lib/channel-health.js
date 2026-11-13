/**
 * What the bot can and cannot do in the channels a guild has configured.
 *
 * A misconfigured ticket bot fails at the worst moment -- a member clicks a
 * panel button and gets nothing, or a ticket closes and the transcript never
 * arrives -- and the only trace is a `Missing Permissions` rejection in the
 * log. The settings themselves look fine in the dashboard, because what is
 * wrong is not the stored ID but the bot's permissions in the channel it
 * points at.
 *
 * This module answers that question ahead of time for every channel a guild
 * has configured: the log channel, each category's Discord category, and the
 * transcript channel each category resolves to. It is the single place the
 * required permissions are written down, used by both ``/check-setup`` and the
 * dashboard's problems endpoint, so the two cannot drift apart.
 *
 * It is I/O-free: callers pass in the guild row, the category rows and
 * whether the bot is public, and the only Discord access is reading the
 * channel cache and the bot's own permissions.
 */

const {
	ChannelType, PermissionsBitField,
} = require('discord.js');
const { resolveTranscriptTarget } = require('./transcript');

const { Flags } = PermissionsBitField;

/** The three kinds of configured channel, as problem and message keys. */
const LOG_CHANNEL = 'logChannel';
const TICKET_CATEGORY = 'ticketCategory';
const TRANSCRIPT_CHANNEL = 'transcriptChannel';

/**
 * What each kind of configured channel has to be, and what the bot needs in it.
 *
 * `expects` is the sort of channel the ID should point at, because a category
 * ID pasted into the log channel field stores perfectly cleanly and fails only
 * when used. `optional` permissions are wanted by one feature rather than by
 * ticketing itself, and are reported apart: a guild that never pins is not
 * misconfigured, and an error it is meant to ignore trains an admin to ignore
 * the whole report.
 *
 * A fourth kind of channel is a new entry here, never a new branch below.
 */
const REQUIREMENTS = {
	// `EmbedLinks` is the one that catches people out: every log entry is an
	// embed, so the send fails even though the bot can clearly talk there.
	[LOG_CHANNEL]: {
		expects: 'text',
		id: 'logChannelMissingPermission',
		optional: [],
		required: ['ViewChannel', 'SendMessages', 'EmbedLinks'],
	},
	// `ManageChannels` creates and later deletes the ticket channel, and
	// `ManageRoles` writes the per-user and per-staff-role overwrites. The four
	// message permissions are needed for a subtler reason: Discord refuses an
	// overwrite granting a permission the bot does not itself hold, so a
	// category where the bot cannot `AttachFiles` fails at channel creation
	// rather than at the first upload.
	[TICKET_CATEGORY]: {
		expects: 'category',
		id: 'ticketCategoryMissingPermission',
		optional: [{
			feature: 'pin',
			permission: 'ManageMessages',
		}],
		required: [
			'ViewChannel',
			'ManageChannels',
			'ManageRoles',
			'SendMessages',
			'EmbedLinks',
			'AttachFiles',
			'ReadMessageHistory',
		],
	},
	// `AttachFiles` on top of the log channel's set, because a transcript is
	// posted as an attachment rather than a link -- see `postClosedTranscript`.
	[TRANSCRIPT_CHANNEL]: {
		expects: 'text',
		id: 'transcriptChannelMissingPermission',
		optional: [],
		required: ['ViewChannel', 'SendMessages', 'EmbedLinks', 'AttachFiles'],
	},
};

/**
 * Problem IDs the dashboard knows how to render.
 *
 * The dashboard lives in another repository and renders by ID, falling back to
 * printing the raw object for anything it does not recognise. New IDs are
 * therefore filtered out of the endpoint's response until it learns them --
 * see ``routes/api/admin/guilds/[guild]/problems.js``.
 */
const DASHBOARD_PROBLEM_IDS = ['botPublic', 'logChannelMissingPermission'];

/**
 * Which of a set of permissions the bot lacks in a channel.
 *
 * @param {?import('discord.js').PermissionsBitField} permissions the bot's
 *   effective permissions in the channel. Null is treated as "everything is
 *   missing", which is what a channel the bot cannot see looks like.
 * @param {string[]} names the permissions to look for
 * @returns {string[]} the absent ones, in the order given
 */
function missingPermissions(permissions, names) {
	if (!permissions) return [...names];
	return names.filter(name => !permissions.has(Flags[name]));
}

/**
 * Whether a channel is the sort of thing a setting expects.
 *
 * A category is text-based in discord.js' sense, so it has to be excluded
 * explicitly -- otherwise a category ID in the log channel field passes.
 *
 * @param {string} expects `category` or `text`, from the requirements
 * @param {import('discord.js').GuildBasedChannel} channel
 * @returns {boolean}
 */
function suits(expects, channel) {
	if (expects === 'category') return channel.type === ChannelType.GuildCategory;
	return channel.isTextBased() && channel.type !== ChannelType.GuildCategory;
}

/**
 * Every channel a guild has configured, deduplicated.
 *
 * Several categories commonly share one transcript channel -- and all of them
 * share it when the fallback in `config.yml` is used -- so targets are keyed
 * by kind and channel, and the categories pointing at each are collected into
 * its label. Reporting the same channel five times would bury the other
 * problems.
 *
 * @param {object} options
 * @param {object[]} options.categories the guild's category rows
 * @param {object} options.config the client config, for the transcript fallback
 * @param {string} options.guildId
 * @param {{warn: function}?} [options.log]
 * @param {object} options.settings the guild row
 * @returns {{channelId: string, kind: string, names: string[]}[]}
 */
function configuredChannels({
	categories,
	config,
	guildId,
	log,
	settings,
}) {
	const targets = new Map();
	const add = (kind, channelId, name) => {
		if (!channelId) return;
		const key = `${kind}:${channelId}`;
		const existing = targets.get(key);
		if (existing) {
			if (name && !existing.names.includes(name)) existing.names.push(name);
			return;
		}
		targets.set(key, {
			channelId: String(channelId),
			kind,
			names: name ? [name] : [],
		});
	};

	add(LOG_CHANNEL, settings.logChannel);

	for (const category of categories) {
		add(TICKET_CATEGORY, category.discordCategory, category.name);
		add(TRANSCRIPT_CHANNEL, resolveTranscriptTarget({
			category,
			config,
			guildId,
			log,
		}), category.name);
	}

	return [...targets.values()];
}

/**
 * Everything wrong with a guild's channel configuration.
 *
 * @param {object} options
 * @param {object[]} options.categories the guild's category rows
 * @param {object} options.config the client config
 * @param {import('discord.js').Guild} options.guild
 * @param {boolean} [options.isBotPublic] whether anyone can add this bot to
 *   their own server, which is a problem for a self-hosted instance but not a
 *   channel one -- the caller decides, because it depends on an env var
 * @param {{warn: function}?} [options.log]
 * @param {object} options.settings the guild row
 * @returns {{problems: object[], targets: object[]}} the targets are every
 *   channel that was checked, so a clean run can say what it looked at
 */
function checkGuild({
	categories,
	config,
	guild,
	isBotPublic = false,
	log,
	settings,
}) {
	const targets = configuredChannels({
		categories,
		config,
		guildId: guild.id,
		log,
		settings,
	});
	const problems = [];

	for (const target of targets) {
		const channel = guild.channels.cache.get(target.channelId);

		// A deleted channel whose ID is still stored: permissionsIn would throw
		// on it, and "missing every permission" would be a misleading way to
		// report a channel that is simply not there any more.
		if (!channel) {
			problems.push({
				channelId: target.channelId,
				id: 'channelMissing',
				kind: target.kind,
				names: target.names,
			});
			continue;
		}

		const {
			expects, id, optional, required,
		} = REQUIREMENTS[target.kind];

		if (!suits(expects, channel)) {
			problems.push({
				channelId: target.channelId,
				expected: expects,
				id: 'channelWrongType',
				kind: target.kind,
				names: target.names,
			});
			continue;
		}

		const permissions = guild.members.me.permissionsIn(channel);

		for (const permission of missingPermissions(permissions, required)) {
			problems.push({
				channelId: target.channelId,
				id,
				kind: target.kind,
				names: target.names,
				permission,
			});
		}

		for (const {
			feature, permission,
		} of optional) {
			if (permissions?.has(Flags[permission])) continue;
			problems.push({
				channelId: target.channelId,
				feature,
				id: 'missingOptionalPermission',
				kind: target.kind,
				names: target.names,
				permission,
			});
		}
	}

	if (isBotPublic) problems.push({ id: 'botPublic' });

	return {
		problems,
		targets,
	};
}

module.exports = {
	DASHBOARD_PROBLEM_IDS,
	LOG_CHANNEL,
	REQUIREMENTS,
	TICKET_CATEGORY,
	TRANSCRIPT_CHANNEL,
	checkGuild,
	configuredChannels,
	missingPermissions,
};
