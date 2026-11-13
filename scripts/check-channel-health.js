/* eslint-disable no-console */
/**
 * Checks src/lib/channel-health.js, which reports what the bot cannot do in
 * the channels a guild has configured.
 *
 * The behaviour worth pinning is that the report is complete and says which
 * channel each problem is about. The failures it exists to catch are silent
 * ones -- a panel button that does nothing, a transcript that never arrives --
 * so a check that quietly skipped a channel would be worse than no check.
 *
 * Two findings are pinned by name below: a deleted channel must not be read as
 * "missing every permission", and AttachFiles in a ticket category is required
 * rather than optional, because Discord refuses an overwrite granting a
 * permission the bot does not hold.
 *
 * No test framework, matching the other check-*.js scripts.
 */

const assert = require('assert');
const { join } = require('path');
const {
	ChannelType, PermissionsBitField,
} = require('discord.js');

const {
	DASHBOARD_PROBLEM_IDS,
	LOG_CHANNEL,
	TICKET_CATEGORY,
	TRANSCRIPT_CHANNEL,
	checkGuild,
} = require(join(__dirname, '../src/lib/channel-health'));

const { Flags } = PermissionsBitField;

let pass = 0;
const ok = name => {
	console.log('  ok   ' + name);
	pass++;
};

/** Everything the bot could want, for the cases that are not about a lack. */
const EVERYTHING = [
	'ViewChannel',
	'SendMessages',
	'EmbedLinks',
	'AttachFiles',
	'ReadMessageHistory',
	'ManageChannels',
	'ManageRoles',
	'ManageMessages',
];

/** Stands in for a PermissionsBitField holding exactly these names. */
const held = names => ({ has: flag => names.some(name => Flags[name] === flag) });

/**
 * A guild whose channels hold the permissions given.
 *
 * @param {object} channels id -> {perms, type}
 */
function fakeGuild(channels) {
	const cache = new Map(
		Object.entries(channels).map(([id, { type = ChannelType.GuildText }]) => [
			id,
			{
				id,
				isTextBased: () => type === ChannelType.GuildText,
				type,
			},
		]),
	);
	return {
		channels: { cache },
		id: 'guild-1',
		members: { me: { permissionsIn: channel => held(channels[channel.id].perms) } },
	};
}

/** A category row with only the fields channel-health reads. */
const category = (name, discordCategory, transcriptChannel = null) => ({
	discordCategory,
	name,
	transcriptChannel,
});

const run = ({
	categories = [],
	channels = {},
	config = {},
	isBotPublic = false,
	settings = {},
}) => checkGuild({
	categories,
	config,
	guild: fakeGuild(channels),
	isBotPublic,
	settings,
});

const ids = problems => problems.map(problem => problem.id);

function main() {
	// ── a healthy guild ──────────────────────────────────────────────────────────
	let result = run({
		categories: [category('Support', 'cat-1', 'arch-1')],
		channels: {
			'arch-1': { perms: EVERYTHING },
			'cat-1': {
				perms: EVERYTHING,
				type: ChannelType.GuildCategory,
			},
			'log-1': { perms: EVERYTHING },
		},
		settings: { logChannel: 'log-1' },
	});
	assert.deepStrictEqual(result.problems, []);
	assert.strictEqual(result.targets.length, 3);
	ok('a fully permitted guild reports nothing, and names the three channels it checked');

	// ── the log channel ──────────────────────────────────────────────────────────
	result = run({
		channels: { 'log-1': { perms: ['ViewChannel', 'SendMessages'] } },
		settings: { logChannel: 'log-1' },
	});
	assert.deepStrictEqual(ids(result.problems), ['logChannelMissingPermission']);
	assert.strictEqual(result.problems[0].permission, 'EmbedLinks');
	assert.strictEqual(result.problems[0].kind, LOG_CHANNEL);
	ok('EmbedLinks alone is reported for a log channel -- the case that looks like it should work');

	// ── a ticket category ────────────────────────────────────────────────────────
	result = run({
		categories: [category('Support', 'cat-1')],
		channels: {
			'cat-1': {
				perms: EVERYTHING.filter(name => name !== 'ManageRoles'),
				type: ChannelType.GuildCategory,
			},
		},
	});
	assert.deepStrictEqual(ids(result.problems), ['ticketCategoryMissingPermission']);
	assert.strictEqual(result.problems[0].permission, 'ManageRoles');
	assert.deepStrictEqual(result.problems[0].names, ['Support']);
	ok('a category that cannot write overwrites is reported, and names the category');

	// Discord refuses an overwrite granting a permission the bot does not hold,
	// so this fails at channel creation rather than at the first upload.
	result = run({
		categories: [category('Support', 'cat-1')],
		channels: {
			'cat-1': {
				perms: EVERYTHING.filter(name => name !== 'AttachFiles'),
				type: ChannelType.GuildCategory,
			},
		},
	});
	assert.deepStrictEqual(ids(result.problems), ['ticketCategoryMissingPermission']);
	assert.strictEqual(result.problems[0].permission, 'AttachFiles');
	ok('AttachFiles in a category is required, not optional -- tickets cannot be created without it');

	// Pinning is the only thing that needs it, so a guild that never pins is not
	// misconfigured and must not be told it is.
	result = run({
		categories: [category('Support', 'cat-1')],
		channels: {
			'cat-1': {
				perms: EVERYTHING.filter(name => name !== 'ManageMessages'),
				type: ChannelType.GuildCategory,
			},
		},
	});
	assert.deepStrictEqual(ids(result.problems), ['missingOptionalPermission']);
	assert.strictEqual(result.problems[0].feature, 'pin');
	ok('ManageMessages is reported as optional, against the feature that needs it');

	// ── transcript channels ──────────────────────────────────────────────────────
	result = run({
		categories: [
			category('Support', 'cat-1', 'arch-1'),
			category('Billing', 'cat-1', 'arch-1'),
			category('Appeals', 'cat-1', 'arch-1'),
		],
		channels: {
			'arch-1': { perms: ['ViewChannel', 'SendMessages', 'EmbedLinks'] },
			'cat-1': {
				perms: EVERYTHING,
				type: ChannelType.GuildCategory,
			},
		},
	});
	assert.deepStrictEqual(ids(result.problems), ['transcriptChannelMissingPermission']);
	assert.strictEqual(result.problems[0].permission, 'AttachFiles');
	assert.deepStrictEqual(result.problems[0].names, ['Support', 'Billing', 'Appeals']);
	ok('one shared transcript channel is reported once, listing every category that uses it');

	// The per-guild fallback in config.yml is as real a setting as the column.
	result = run({
		categories: [category('Support', 'cat-1')],
		channels: {
			'cat-1': {
				perms: EVERYTHING,
				type: ChannelType.GuildCategory,
			},
			'fallback-1': { perms: ['ViewChannel'] },
		},
		config: { transcripts: { onClose: { 'guild-1': 'fallback-1' } } },
	});
	assert.deepStrictEqual(
		result.problems.map(problem => problem.permission),
		['SendMessages', 'EmbedLinks', 'AttachFiles'],
	);
	assert.strictEqual(result.problems[0].kind, TRANSCRIPT_CHANNEL);
	ok('config.yml\'s transcript fallback is checked too, not just the category column');

	// ── channels that are not there, or not what they should be ──────────────────
	// permissionsIn throws on an unresolvable channel, and "missing everything"
	// would send an admin to a permissions page for a channel that is gone.
	result = run({
		channels: {},
		settings: { logChannel: 'deleted-1' },
	});
	assert.deepStrictEqual(ids(result.problems), ['channelMissing']);
	assert.strictEqual(result.problems[0].channelId, 'deleted-1');
	ok('a deleted channel is reported as missing, not as missing every permission');

	result = run({
		channels: {
			'cat-1': {
				perms: EVERYTHING,
				type: ChannelType.GuildCategory,
			},
		},
		settings: { logChannel: 'cat-1' },
	});
	assert.deepStrictEqual(ids(result.problems), ['channelWrongType']);
	assert.strictEqual(result.problems[0].expected, 'text');
	ok('a category ID in the log channel field is reported as the wrong type');

	result = run({
		categories: [category('Support', 'text-1')],
		channels: { 'text-1': { perms: EVERYTHING } },
	});
	assert.deepStrictEqual(ids(result.problems), ['channelWrongType']);
	assert.strictEqual(result.problems[0].expected, 'category');
	assert.strictEqual(result.problems[0].kind, TICKET_CATEGORY);
	ok('a text channel ID in a category field is reported as the wrong type');

	// ── the public bot warning ───────────────────────────────────────────────────
	// It used to be reported only when a log channel was configured, which has
	// nothing to do with it: a self-hosted bot left public is public either way.
	result = run({
		channels: {},
		isBotPublic: true,
		settings: {},
	});
	assert.deepStrictEqual(ids(result.problems), ['botPublic']);
	ok('botPublic is reported for a guild with nothing configured at all');

	// ── what the dashboard is allowed to see ─────────────────────────────────────
	result = run({
		categories: [category('Support', 'cat-1')],
		channels: {
			'cat-1': {
				perms: ['ViewChannel'],
				type: ChannelType.GuildCategory,
			},
			'log-1': { perms: ['ViewChannel', 'SendMessages'] },
		},
		isBotPublic: true,
		settings: { logChannel: 'log-1' },
	});
	const forDashboard = result.problems.filter(problem => DASHBOARD_PROBLEM_IDS.includes(problem.id));
	assert.deepStrictEqual(ids(forDashboard), ['logChannelMissingPermission', 'botPublic']);
	assert.ok(result.problems.length > forDashboard.length);
	ok('the dashboard filter keeps the two IDs it can render and drops the newer ones');

	console.log(`\n[check-channel-health] ${pass} checks passed`);
}

try {
	main();
} catch (error) {
	console.error('\n[check-channel-health] FAILED:', error.message);
	process.exit(1);
}
