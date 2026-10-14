/* eslint-disable no-console */
/**
 * Checks src/lib/avatars.js, the encoding of the `ArchivedUser.avatar` column.
 *
 * The column carries two different kinds of value — a bare Discord hash and a
 * mirrored object key — so the decoder is what stops rows written before this
 * feature, or while it was disabled, from being misread. These are pure
 * functions with no environment or network involved.
 */

const assert = require('assert');
const { join } = require('path');

const {
	AVATAR_SIZE,
	decodeAvatar,
	encodeAvatar,
} = require(join(__dirname, '../src/lib/avatars'));

let pass = 0;
const ok = name => {
	console.log('  ok   ' + name);
	pass++;
};

// ── round trip ───────────────────────────────────────────────────────────────
const key = 'avatars/319467558166069248/abc123def.webp';
assert.strictEqual(encodeAvatar(key), 's3:' + key);
assert.deepStrictEqual(decodeAvatar(encodeAvatar(key)), {
	hash: 'abc123def',
	s3Key: key,
});
ok('a mirrored key round-trips, and the hash survives encoding');

// ── values written before this feature, or with it disabled/failed ───────────
assert.deepStrictEqual(decodeAvatar('abc123def'), {
	hash: 'abc123def',
	s3Key: null,
});
ok('a bare hash decodes as a hash, with no key');

// Animated avatars are "a_"-prefixed. That must not look like a key.
assert.deepStrictEqual(decodeAvatar('a_abc123def'), {
	hash: 'a_abc123def',
	s3Key: null,
});
ok('an animated avatar hash is not mistaken for a key');

// ── absent avatars ───────────────────────────────────────────────────────────
for (const empty of [null, undefined, '']) {
	assert.deepStrictEqual(decodeAvatar(empty), {
		hash: null,
		s3Key: null,
	});
}
ok('null, undefined and empty all decode to no avatar');

// ── the hash stays recoverable however deep the key is ───────────────────────
assert.strictEqual(
	decodeAvatar('s3:env/prod/avatars/123/deadbeef.webp').hash,
	'deadbeef',
);
assert.strictEqual(
	decodeAvatar('s3:env/prod/avatars/123/deadbeef.webp').s3Key,
	'env/prod/avatars/123/deadbeef.webp',
);
// An extension is not guaranteed, and must not eat the hash.
assert.strictEqual(decodeAvatar('s3:avatars/123/deadbeef').hash, 'deadbeef');
ok('hash recoverable under a nested prefix and with no extension');

// ── the mirrored size is a thumbnail, not the original ───────────────────────
assert.strictEqual(AVATAR_SIZE, 128);
assert.strictEqual(
	Number.isInteger(Math.log2(AVATAR_SIZE)),
	true,
	'Discord only serves power-of-two avatar sizes',
);
ok('avatars are mirrored at a power-of-two thumbnail size');

console.log(`\n[check-avatars] ${pass} checks passed`);
