/* eslint-disable no-console */
/**
 * Checks src/lib/transcript.js, which turns an archived ticket's media into
 * usable URLs when a transcript is rendered.
 *
 * This is where the mirroring actually pays off, so the cases that matter are
 * the fallbacks: a transcript must never come out worse than it did before
 * mirroring existed, whatever S3 does.
 *
 * `presign` is injected, so nothing here touches AWS.
 */

const assert = require('assert');
const { join } = require('path');

const {
	DISCORD_CDN,
	resolveAttachmentUrl,
	resolveAvatarUrl,
	resolveTicketMedia,
} = require(join(__dirname, '../src/lib/transcript'));

let pass = 0;
const ok = name => {
	console.log('  ok   ' + name);
	pass++;
};

const warnings = [];
const resolver = (overrides = {}) => ({
	enabled: true,
	log: {
		error: () => {},
		warn: (...args) => warnings.push(args),
	},
	presign: async key => `https://s3.example/${key}?signed`,
	...overrides,
});

const attachment = (extra = {}) => ({
	id: '1',
	name: 'evidence.png',
	url: 'https://cdn.discordapp.com/attachments/1/2/evidence.png?ex=expired',
	...extra,
});

async function main() {
	// ── attachments ──────────────────────────────────────────────────────────
	assert.strictEqual(
		await resolveAttachmentUrl(attachment({ s3Key: 'attachments/t/m/1/evidence.png' }), resolver()),
		'https://s3.example/attachments/t/m/1/evidence.png?signed',
	);
	ok('a mirrored attachment resolves to the presigned copy');

	// Not mirrored (over the size cap, or archived before this existed).
	assert.strictEqual(
		await resolveAttachmentUrl(attachment(), resolver()),
		attachment().url,
	);
	// Storage switched off entirely.
	assert.strictEqual(
		await resolveAttachmentUrl(
			attachment({ s3Key: 'attachments/x' }),
			resolver({ enabled: false }),
		),
		attachment().url,
	);
	ok('unmirrored attachment, or storage disabled: keeps the Discord URL');

	warnings.length = 0;
	assert.strictEqual(
		await resolveAttachmentUrl(
			attachment({ s3Key: 'attachments/x' }),
			resolver({
				presign: async () => {
					throw new Error('no credentials');
				},
			}),
		),
		attachment().url,
	);
	assert.strictEqual(warnings.length, 1);
	ok('presign failure: falls back to the Discord URL and warns');

	// ── avatars ──────────────────────────────────────────────────────────────
	const mirrored = {
		avatar: 's3:avatars/42/abc123.webp',
		userId: '42',
	};
	assert.strictEqual(
		await resolveAvatarUrl(mirrored, resolver()),
		'https://s3.example/avatars/42/abc123.webp?signed',
	);
	ok('a mirrored avatar resolves to the presigned copy');

	// Written before mirroring existed: only the hash is known, so the global
	// CDN path is assumed. It may 404 -- that ambiguity is what mirroring fixes.
	assert.strictEqual(
		await resolveAvatarUrl({
			avatar: 'abc123',
			userId: '42',
		}, resolver()),
		`${DISCORD_CDN}/avatars/42/abc123.webp`,
	);
	ok('a legacy hash falls back to the Discord CDN path');

	// A mirrored key still carries the hash, so presign failure can fall back.
	assert.strictEqual(
		await resolveAvatarUrl(mirrored, resolver({
			presign: async () => {
				throw new Error('nope');
			},
		})),
		`${DISCORD_CDN}/avatars/42/abc123.webp`,
	);
	ok('presign failure on a mirrored avatar still yields the CDN path');

	for (const avatar of [null, undefined, '']) {
		assert.strictEqual(
			await resolveAvatarUrl({
				avatar,
				userId: '42',
			}, resolver()),
			null,
		);
	}
	ok('a member with no avatar resolves to null, not a broken URL');

	// ── whole ticket ─────────────────────────────────────────────────────────
	const ticket = {
		archivedMessages: [{
			content: {
				attachments: [
					attachment({
						name: 'a.png',
						s3Key: 'attachments/a.png',
					}),
					attachment({
						name: 'b.png',
						url: 'https://cdn.discordapp.com/b.png',
					}),
				],
				embeds: [{}, {}],
			},
			text: 'look at this',
		}],
		archivedUsers: [
			{
				avatar: 's3:avatars/42/abc.webp',
				userId: '42',
			},
			{
				avatar: null,
				userId: '43',
			},
		],
	};

	await resolveTicketMedia(ticket, resolver());

	// Order must match what the worker used to emit: body, attachments, embeds.
	assert.strictEqual(
		ticket.archivedMessages[0].text,
		'look at this' +
		'\n\thttps://s3.example/attachments/a.png?signed' +
		'\n\thttps://cdn.discordapp.com/b.png' +
		'\n\t[embedded content]' +
		'\n\t[embedded content]',
	);
	ok('message tails keep the worker\'s original order and count');

	assert.strictEqual(ticket.archivedUsers[0].avatarUrl, 'https://s3.example/avatars/42/abc.webp?signed');
	assert.strictEqual(ticket.archivedUsers[1].avatarUrl, null);
	ok('avatarUrl set on every participant, for the template to use');

	// A message with neither attachments nor embeds must be left alone.
	const plain = {
		archivedMessages: [{
			content: {},
			text: 'hello',
		}],
		archivedUsers: [],
	};
	await resolveTicketMedia(plain, resolver());
	assert.strictEqual(plain.archivedMessages[0].text, 'hello');
	ok('a message with no media is untouched');

	console.log(`\n[check-transcript] ${pass} checks passed`);
}

main().catch(error => {
	console.error('\n[check-transcript] FAILED:', error.message);
	process.exit(1);
});
