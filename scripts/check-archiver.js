/* eslint-disable no-console */
/**
 * Checks TicketArchiver.saveAvatar, which decides what goes in
 * `ArchivedUser.avatar`.
 *
 * The interesting paths are the fallbacks and the dedup cache. An avatar is
 * content-addressed, but an ArchivedUser row is upserted once per message, so
 * without the cache the archiver would re-upload the same image for every
 * message a member sends.
 *
 * `src/lib/threads` is stubbed out of the require cache before loading the
 * archiver: requiring it for real spawns five worker-thread pools at module
 * load, which a unit check has no use for.
 */

const assert = require('assert');
const { join } = require('path');

const storagePath = join(__dirname, '../src/lib/storage');
const avatarsPath = join(__dirname, '../src/lib/avatars');
const threadsPath = join(__dirname, '../src/lib/threads');
const archiverPath = join(__dirname, '../src/lib/tickets/archiver');

let pass = 0;
const ok = name => {
	console.log('  ok   ' + name);
	pass++;
};

/** Load the archiver with storage configured and the thread pools stubbed. */
function loadArchiver() {
	for (const path of [storagePath, threadsPath, archiverPath]) {
		delete require.cache[require.resolve(path)];
	}

	process.env.S3_BUCKET = 'test-bucket';
	delete process.env.S3_PREFIX;
	delete process.env.S3_ARCHIVE_AVATARS;

	const resolved = require.resolve(threadsPath);
	require.cache[resolved] = {
		exports: { pools: { crypto: { queue: async () => 'encrypted' } } },
		filename: resolved,
		id: resolved,
		loaded: true,
	};

	const storage = require(storagePath);
	const TicketArchiver = require(archiverPath);
	return {
		TicketArchiver,
		storage,
	};
}

/** A GuildMember just real enough for saveAvatar. */
function fakeMember({
	guildAvatar = null,
	id = '319467558166069248',
	userAvatar = null,
} = {}) {
	const urlCalls = [];
	return {
		avatar: guildAvatar,
		displayAvatarURL(options) {
			urlCalls.push(options);
			return `https://cdn.discordapp.com/avatars/${id}/x.webp`;
		},
		urlCalls,
		user: {
			avatar: userAvatar,
			bot: false,
			id,
			username: 'someone',
		},
	};
}

function fakeClient() {
	const store = new Map();
	const warnings = [];
	return {
		keyv: {
			has: async key => store.has(key),
			set: async (key, value) => store.set(key, value),
		},
		log: {
			error: () => {},
			warn: (...args) => warnings.push(args),
		},
		store,
		warnings,
	};
}

async function main() {
	const {
		TicketArchiver,
		storage,
	} = loadArchiver();

	// ── no custom avatar: nothing worth mirroring ────────────────────────────
	let client = fakeClient();
	let archiver = new TicketArchiver(client);
	let mirrorCalls = 0;
	storage.mirror = async () => {
		mirrorCalls++;
		return 'unexpected';
	};

	let member = fakeMember();
	assert.strictEqual(await archiver.saveAvatar(member), null);
	assert.strictEqual(mirrorCalls, 0, 'default avatar should not be mirrored');
	ok('member on a default avatar: returns null, no upload');

	// ── guild avatar wins over the global one ────────────────────────────────
	member = fakeMember({
		guildAvatar: 'guildhash',
		userAvatar: 'globalhash',
	});
	storage.mirror = async (url, key) => key;
	const result = await archiver.saveAvatar(member);
	assert.strictEqual(result, 's3:avatars/319467558166069248/guildhash.webp');
	// displayAvatarURL resolves which of the two CDN paths applies, so the
	// stored hash and the mirrored image always agree.
	assert.deepStrictEqual(member.urlCalls, [{
		extension: 'webp',
		size: require(avatarsPath).AVATAR_SIZE,
	}]);
	ok('per-guild avatar preferred, requested at the archive thumbnail size');

	// ── mirrored once, then served from cache ────────────────────────────────
	client = fakeClient();
	archiver = new TicketArchiver(client);
	mirrorCalls = 0;
	storage.mirror = async (url, key) => {
		mirrorCalls++;
		return key;
	};

	member = fakeMember({ userAvatar: 'abc123' });
	const expected = 's3:avatars/319467558166069248/abc123.webp';
	for (let i = 0; i < 5; i++) {
		assert.strictEqual(await archiver.saveAvatar(member), expected);
	}
	assert.strictEqual(mirrorCalls, 1, `uploaded ${mirrorCalls} times, expected 1`);
	ok('same avatar across 5 messages uploads once (dedup cache holds)');

	// A different hash is a different image and must be uploaded.
	member = fakeMember({ userAvatar: 'changed456' });
	assert.strictEqual(
		await archiver.saveAvatar(member),
		's3:avatars/319467558166069248/changed456.webp',
	);
	assert.strictEqual(mirrorCalls, 2);
	ok('changed avatar is uploaded as a separate object');

	// ── fallbacks: the archive degrades, it does not fail ────────────────────
	client = fakeClient();
	archiver = new TicketArchiver(client);
	// mirror() returns null when the image is over the cap or already gone.
	storage.mirror = async () => null;
	member = fakeMember({ userAvatar: 'abc123' });
	assert.strictEqual(await archiver.saveAvatar(member), 'abc123');
	assert.strictEqual(client.store.size, 0, 'a failed mirror must not be cached');
	ok('mirror declines: falls back to the bare hash, nothing cached');

	storage.mirror = async () => {
		throw new Error('S3 unreachable');
	};
	assert.strictEqual(await archiver.saveAvatar(member), 'abc123');
	assert.strictEqual(client.warnings.length, 1);
	ok('mirror throws: returns the bare hash and warns, does not throw');

	// ── disabled ─────────────────────────────────────────────────────────────
	mirrorCalls = 0;
	storage.mirror = async () => {
		mirrorCalls++;
		return 'unexpected';
	};
	storage.archiveAvatars = false;
	assert.strictEqual(await archiver.saveAvatar(member), 'abc123');
	assert.strictEqual(mirrorCalls, 0);
	ok('S3_ARCHIVE_AVATARS=false: stores the hash, as before this feature');

	console.log(`\n[check-archiver] ${pass} checks passed`);
}

main().catch(error => {
	console.error('\n[check-archiver] FAILED:', error.message);
	process.exit(1);
});
