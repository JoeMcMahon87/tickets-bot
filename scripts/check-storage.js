/* eslint-disable no-console */
/**
 * Checks src/lib/storage.js, the optional S3 object storage used for
 * transcripts and archived attachments.
 *
 * No test framework is in use here, matching scripts/check-i18n.js. These are
 * plain assertions over the pure, env-driven parts of the module -- key
 * building, the size caps and the concurrency gate -- with `fetch` stubbed, so
 * nothing touches the network or AWS.
 *
 * The concurrency checks matter most: a leaked slot in the mirror semaphore
 * would wedge attachment archiving permanently rather than failing loudly.
 */

const assert = require('assert');
const { join } = require('path');

const modulePath = join(__dirname, '../src/lib/storage');

function load(env) {
	delete require.cache[require.resolve(modulePath)];
	for (const k of Object.keys(process.env)) if (k.startsWith('S3_')) delete process.env[k];
	Object.assign(process.env, env);
	return require(modulePath);
}

let pass = 0;
const ok = name => {
	console.log('  ok   ' + name);
	pass++;
};
let s;

async function main() {
// ── disabled by default ──────────────────────────────────────────────────────
	s = load({});
	assert.strictEqual(s.enabled, false);
	assert.strictEqual(s.archiveAttachments, false);
	await assert.rejects(s.put({
		body: 'b',
		key: 'k',
	}), /not configured/);
	await assert.rejects(s.presign('k'), /not configured/);
	ok('disabled with no S3_BUCKET; put() and presign() reject');

	// ── enabled ──────────────────────────────────────────────────────────────────
	s = load({ S3_BUCKET: 'b' });
	assert.strictEqual(s.enabled, true);
	assert.strictEqual(s.archiveAttachments, true);
	assert.strictEqual(s.maxAttachmentSize, 8 * 1024 * 1024);
	assert.strictEqual(s.urlExpiry, 86400);
	ok('enabled by S3_BUCKET; attachment mirroring on by default');

	s = load({
		S3_ARCHIVE_ATTACHMENTS: 'false',
		S3_BUCKET: 'b',
	});
	assert.strictEqual(s.enabled, true);
	assert.strictEqual(s.archiveAttachments, false);
	ok('S3_ARCHIVE_ATTACHMENTS=false disables mirroring but keeps transcripts');

	// ── expiry is clamped to the SigV4 maximum ───────────────────────────────────
	assert.strictEqual(load({
		S3_BUCKET: 'b',
		S3_URL_EXPIRY: '99999999',
	}).urlExpiry, 604800);
	assert.strictEqual(load({
		S3_BUCKET: 'b',
		S3_URL_EXPIRY: '60',
	}).urlExpiry, 60);
	ok('S3_URL_EXPIRY clamped to 7 days');

	// ── key building ─────────────────────────────────────────────────────────────
	s = load({ S3_BUCKET: 'b' });
	assert.strictEqual(s.buildKey('transcripts', '123', '456', 'a.txt'), 'transcripts/123/456/a.txt');
	assert.strictEqual(s.buildKey('a', null, undefined, '', 'b'), 'a/b');
	// a filename is attacker-influenced (Discord lets you name a file anything)
	assert.strictEqual(s.buildKey('attachments', '../../etc/passwd'), 'attachments/_.._etc_passwd');
	assert.strictEqual(s.buildKey('x', '..'), 'x');
	assert.strictEqual(s.buildKey('x', 'a/b\\c'), 'x/a_b_c');
	ok('buildKey cannot escape its prefix');

	s = load({
		S3_BUCKET: 'b',
		S3_PREFIX: '/env/prod/',
	});
	assert.strictEqual(s.buildKey('transcripts', 'f.txt'), 'env/prod/transcripts/f.txt');
	ok('S3_PREFIX applied, slashes normalised');

	// ── mirror: size caps ────────────────────────────────────────────────────────
	s = load({
		S3_BUCKET: 'b',
		S3_MAX_ATTACHMENT_SIZE: '1000',
	});

	let fetched = false;
	global.fetch = async () => {
		fetched = true;
		throw new Error('should not be called');
	};
	assert.strictEqual(await s.mirror('http://x/f', 'k', { size: 5000 }), null);
	assert.strictEqual(fetched, false);
	ok('declared size over cap: skipped without opening a connection');

	global.fetch = async () => ({
		headers: new Map([['content-length', '9999']]),
		ok: true,
	});
	assert.strictEqual(await s.mirror('http://x/f', 'k'), null);
	ok('Content-Length over cap: rejected');

	// A lying Content-Length must not get past the cap.
	global.fetch = async () => ({
		arrayBuffer: async () => new ArrayBuffer(5000),
		headers: new Map([['content-length', '10']]),
		ok: true,
	});
	assert.strictEqual(await s.mirror('http://x/f', 'k'), null);
	ok('understated Content-Length: still rejected on actual size');

	global.fetch = async () => ({
		headers: new Map(),
		ok: false,
		status: 404,
	});
	assert.strictEqual(await s.mirror('http://x/f', 'k'), null);
	ok('source gone (404): returns null, not an exception');

	// ── the dangerous one: slot leaks would wedge archiving for good ─────────
	s = load({ S3_BUCKET: 'b' });
	global.fetch = async () => {
		throw new Error('network down');
	};
	for (let i = 0; i < 20; i++) {
		await assert.rejects(s.mirror('http://x/f', 'k'), /network down/);
	}
	// If the semaphore leaked a slot, this await never settles.
	const notWedged = await Promise.race([
		s.mirror('http://x/f', 'k').catch(() => 'threw'),
		new Promise(r => setTimeout(() => r('WEDGED'), 1000)),
	]);
	assert.strictEqual(notWedged, 'threw');
	ok('20 consecutive failures release their slots (no wedge)');

	// ── concurrency is actually bounded ──────────────────────────────────────
	s = load({ S3_BUCKET: 'b' });
	let inFlight = 0, peak = 0;
	global.fetch = async () => {
		inFlight++;
		peak = Math.max(peak, inFlight);
		await new Promise(r => setTimeout(r, 20));
		inFlight--;
		return {
			headers: new Map(),
			ok: false,
		};
	};
	await Promise.all(Array.from({ length: 12 }, () => s.mirror('http://x/f', 'k')));
	assert.strictEqual(peak, 2, `peak concurrency ${peak}, expected 2`);
	assert.strictEqual(inFlight, 0);
	ok('concurrency capped at 2 across a burst of 12, all drained');

	console.log(`\n[check-storage] ${pass} checks passed`);
}

main().catch(error => {
	console.error('\n[check-storage] FAILED:', error.message);
	process.exit(1);
});
