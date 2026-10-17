/* eslint-disable no-console */
/**
 * Checks src/lib/panel-errors.js, which works out why creating a panel failed.
 *
 * The behaviour worth pinning is that the output names the cause. Before this,
 * a failed panel left only:
 *
 *   [ERROR] (HTTP) req-1e4 DiscordAPIError[50013]: Missing Permissions
 *       at async Object.handler (.../panels.js:128:5)
 *
 * which says neither what was being attempted nor what was missing, and sent
 * people reading a line number instead of a channel's permissions.
 *
 * No test framework, matching the other check-*.js scripts.
 */

const assert = require('assert');
const { join } = require('path');

const {
	describe, missingChannelPermissions, REQUIRED_CHANNEL_PERMISSIONS,
} = require(join(__dirname, '../src/lib/panel-errors'));

let pass = 0;
const ok = name => {
	console.log('  ok   ' + name);
	pass++;
};

/** Stands in for a PermissionsBitField holding exactly these names. */
const held = (...names) => ({
	has: flag => names.includes(
		REQUIRED_CHANNEL_PERMISSIONS.find(([, f]) => f === flag)?.[0],
	),
});

async function main() {
	// ── which permissions are missing ────────────────────────────────────────────
	assert.deepStrictEqual(
		missingChannelPermissions(held('ViewChannel', 'SendMessages', 'EmbedLinks')),
		[],
	);
	ok('nothing is missing when the bot holds all three');

	assert.deepStrictEqual(
		missingChannelPermissions(held('ViewChannel', 'SendMessages')),
		['EmbedLinks'],
	);
	ok('EmbedLinks alone is reported -- the case that looks like it should work');

	assert.deepStrictEqual(
		missingChannelPermissions(held('ViewChannel')),
		['SendMessages', 'EmbedLinks'],
	);
	ok('several missing permissions are all listed, not just the first');

	// A channel the bot cannot see yields null from permissionsFor, which must
	// not be read as "nothing is missing".
	assert.deepStrictEqual(
		missingChannelPermissions(null),
		['ViewChannel', 'SendMessages', 'EmbedLinks'],
	);
	ok('a channel the bot cannot see reports everything missing, not nothing');

	// ── the log line ─────────────────────────────────────────────────────────────
	let line = describe({
		channelId: '123',
		error: Object.assign(new Error('Missing Permissions'), { code: 50013 }),
		missing: ['EmbedLinks'],
		step: 'send the panel message',
	});
	assert.match(line, /could not send the panel message/);
	assert.match(line, /channel=123/);
	assert.match(line, /50013/);
	assert.match(line, /missing a permission it needs/);
	assert.match(line, /missing=EmbedLinks/);
	ok('the line names the step, the channel, the code and the missing permission');

	line = describe({
		channelId: '456',
		error: Object.assign(new Error('Missing Access'), { code: 50001 }),
		step: 'fetch the channel the panel should go in',
	});
	assert.match(line, /could not fetch the channel/);
	assert.match(line, /no access to that channel/);
	assert.doesNotMatch(line, /missing=/);
	ok('50001 is explained, and the missing= field is omitted when unknown');

	// An unmapped code must still produce something useful rather than a wrong
	// guess, so the raw message is kept.
	line = describe({
		error: Object.assign(new Error('Something unforeseen'), { code: 99999 }),
		step: 'create a channel for the panel',
	});
	assert.match(line, /99999: Something unforeseen/);
	ok('an unmapped code falls back to the raw message');

	// Not every failure is a DiscordAPIError.
	line = describe({
		error: new Error('socket hang up'),
		step: 'send the panel message',
	});
	assert.match(line, /could not send the panel message/);
	assert.match(line, /socket hang up/);
	ok('a plain error is described without inventing a code');

	// rawError is where discord.js puts the code on some rejections.
	line = describe({
		error: { rawError: { code: 50013 } },
		step: 'send the panel message',
	});
	assert.match(line, /50013/);
	ok('a code on rawError is found too');

	console.log(`\n[check-panel-errors] ${pass} checks passed`);
}

main().catch(error => {
	console.error('\n[check-panel-errors] FAILED:', error.message);
	process.exit(1);
});
