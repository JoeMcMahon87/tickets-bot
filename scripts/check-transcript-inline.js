/* eslint-disable no-console */
/**
 * Checks src/lib/transcript-inline.js, which embeds a ticket's images in its
 * HTML transcript so they outlive every URL.
 *
 * The cases that matter: the file stays under the upload limit, nothing is
 * fetched from outside Discord and our own bucket, only real images are
 * embedded, and every failure leaves the image as a link.
 *
 * Fetch and storage are injected, so nothing here touches the network.
 */

const assert = require('assert');
const fs = require('fs');
const { join } = require('path');
const Mustache = require('mustache');

const {
	configuredBudget,
	createLoader,
	embedTicketImages,
	fetchCapped,
	fitBudget,
	inlineTicketImages,
	isDiscordMediaUrl,
	sniffImage,
} = require(join(__dirname, '../src/lib/transcript-inline'));
const { escapeHtml } = require(join(__dirname, '../src/lib/transcript-media'));
const { resolveTicketMedia } = require(join(__dirname, '../src/lib/transcript'));

let pass = 0;
const ok = name => {
	console.log('  ok   ' + name);
	pass++;
};

const log = {
	error: () => {},
	warn: () => {},
};

// The smallest valid-looking bodies for each signature, padded to 12 bytes.
const png = (n = 16) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(n - 8)]);
const jpeg = (n = 16) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(n - 3)]);

/** A fetch that serves `routes[url]` and records what it was asked for. */
function fakeFetch(routes) {
	const calls = [];
	const impl = async (url, options) => {
		calls.push({
			options,
			url,
		});
		const body = routes[url];
		if (!body) {
			return {
				body: null,
				headers: new Map(),
				ok: false,
			};
		}
		return new Response(body, { headers: { 'content-length': String(body.length) } });
	};
	impl.calls = calls;
	return impl;
}

async function main() {
	// ── what may be fetched ──────────────────────────────────────────────────
	for (const url of [
		'https://cdn.discordapp.com/attachments/1/2/a.png?ex=1',
		'https://media.discordapp.net/attachments/1/2/a.png',
		'https://images-ext-1.discordapp.net/external/abc/https/i.example/a.png',
	]) assert.ok(isDiscordMediaUrl(url), url);
	for (const url of [
		'http://cdn.discordapp.com/a.png',
		'https://cdn.discordapp.com.evil.example/a.png',
		'https://169.254.169.254/latest/meta-data',
		'https://i.example/a.png',
		'not a url',
		null,
	]) assert.ok(!isDiscordMediaUrl(url), String(url));
	ok('only Discord\'s CDN and media proxy are fetched from, over https');

	// ── what counts as an image ──────────────────────────────────────────────
	assert.strictEqual(sniffImage(png()), 'image/png');
	assert.strictEqual(sniffImage(jpeg()), 'image/jpeg');
	assert.strictEqual(sniffImage(Buffer.from('GIF89a......')), 'image/gif');
	assert.strictEqual(sniffImage(Buffer.from('RIFF....WEBPVP8 ')), 'image/webp');
	assert.strictEqual(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">')), null);
	assert.strictEqual(sniffImage(Buffer.from('<html><script>')), null);
	assert.strictEqual(sniffImage(Buffer.alloc(4)), null);
	ok('type comes from the bytes; SVG, HTML and short bodies are refused');

	// ── capped fetch ─────────────────────────────────────────────────────────
	const f = fakeFetch({
		'https://cdn.discordapp.com/big': png(5000),
		'https://cdn.discordapp.com/small': png(100),
	});
	assert.strictEqual((await fetchCapped('https://cdn.discordapp.com/small', 1000, { fetch: f })).length, 100);
	assert.strictEqual(await fetchCapped('https://cdn.discordapp.com/big', 1000, { fetch: f }), null);
	assert.strictEqual(await fetchCapped('https://cdn.discordapp.com/missing', 1000, { fetch: f }), null);
	assert.strictEqual(f.calls[0].options.redirect, 'error');
	ok('fetch is size-capped, refuses redirects, and a miss is null');

	// A server that lies about, or omits, its length is still capped.
	const liar = async () => new Response(png(5000), { headers: { 'content-length': '10' } });
	assert.strictEqual(await fetchCapped('https://cdn.discordapp.com/x', 1000, { fetch: liar }), null);
	ok('the cap holds when content-length is wrong');

	// ── loader ───────────────────────────────────────────────────────────────
	const stored = { 'attachments/a.png': png(64) };
	const storage = {
		enabled: true,
		get: async key => {
			if (key === 'attachments/broken') throw new Error('denied');
			return stored[key] ?? null;
		},
	};
	const lf = fakeFetch({ 'https://cdn.discordapp.com/fallback.png': png(32) });
	const load = createLoader({
		fetch: lf,
		log,
		storage,
	});
	assert.strictEqual((await load({ s3Key: 'attachments/a.png' }, 1000)).length, 64);
	assert.strictEqual(lf.calls.length, 0);
	ok('a mirrored image is read from the bucket, not Discord');

	assert.strictEqual((await load({
		s3Key: 'attachments/broken',
		sourceUrl: 'https://cdn.discordapp.com/fallback.png',
	}, 1000)).length, 32);
	ok('a storage failure falls back to the Discord URL');

	assert.strictEqual(await load({ sourceUrl: 'https://i.example/hotlink.png' }, 1000), null);
	assert.strictEqual(lf.calls.length, 1);
	ok('an image with neither a mirror nor a Discord URL is not fetched');

	// ── budget ───────────────────────────────────────────────────────────────
	const MiB = 1024 * 1024;
	assert.strictEqual(fitBudget({
		baseSize: 100 * 1024,
		configured: 0,
		images: 3,
		limit: 8 * MiB,
	}), 0);
	const fit = fitBudget({
		baseSize: 2 * MiB,
		configured: 6 * MiB,
		images: 10,
		limit: 8 * MiB,
	});
	assert.ok(2 * MiB + Math.ceil(fit * 4 / 3) + 10 * 256 < 8 * MiB);
	assert.ok(fit > 4 * MiB);
	assert.strictEqual(fitBudget({
		baseSize: 9 * MiB,
		configured: 6 * MiB,
		images: 1,
		limit: 8 * MiB,
	}), 0);
	ok('budget leaves room for base64 and the text, and is 0 when nothing fits');

	assert.strictEqual(configuredBudget({}), 6 * MiB);
	assert.strictEqual(configuredBudget({ TRANSCRIPT_INLINE_IMAGE_BYTES: '0' }), 0);
	assert.strictEqual(configuredBudget({ TRANSCRIPT_INLINE_IMAGE_BYTES: '1000' }), 1000);
	assert.strictEqual(configuredBudget({ TRANSCRIPT_INLINE_IMAGE_BYTES: 'lots' }), 0);
	ok('TRANSCRIPT_INLINE_IMAGE_BYTES: default, off, set, and invalid means off');

	// ── inlining a ticket ────────────────────────────────────────────────────
	const items = ['a', 'big', 'b', 'svg', 'gone', 'c'].map((name, i) => ({
		id: `img-${i + 1}`,
		name,
	}));
	const bodies = {
		a: png(400),
		b: jpeg(300),
		big: png(2000),
		c: png(400),
		svg: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
	};
	const ticket = { gallery: items };
	await inlineTicketImages(ticket, {
		budget: 1000,
		load: async item => {
			if (item.name === 'gone') throw new Error('404');
			return bodies[item.name];
		},
		log,
	});
	// a (400) + b (300) fit; big is skipped, not the end; c (400) no longer fits.
	assert.deepStrictEqual(ticket.inlineImages.map(i => i.name), ['a', 'b']);
	assert.strictEqual(ticket.linkedImageCount, 4);
	assert.match(items[0].dataUri, /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/);
	assert.match(items[2].dataUri, /^data:image\/jpeg;base64,/);
	assert.strictEqual(items[3].dataUri, undefined);
	ok('images embed in order within budget; oversized, non-image and failed ones stay links');

	// ── end to end through the shipped template ──────────────────────────────
	const template = fs.readFileSync(join(__dirname, '../src/user/templates/transcript.html.mustache'), 'utf8');
	const full = {
		archivedMessages: [{
			author: {
				displayName: 'A',
				username: 'a',
			},
			content: {
				attachments: [
					{
						contentType: 'image/png',
						height: 300,
						name: 'proof.png',
						url: 'https://cdn.discordapp.com/attachments/1/2/proof.png?ex=1',
						width: 400,
					},
					{
						contentType: 'image/png',
						name: 'hotlink.png',
						url: 'https://i.example/hotlink.png',
					},
				],
				content: 'see',
				embeds: [],
			},
			number: 'M1',
			text: 'see',
		}],
		archivedUsers: [],
		category: { name: 'Support' },
		id: 't1',
		number: 1,
		questionAnswers: [],
	};
	await resolveTicketMedia(full, {
		enabled: false,
		log,
	});
	const render = () => Mustache.render(template, {
		channelName: 'ticket-1',
		closedAtFull: () => '',
		createdAtFull: () => '',
		createdAtTimestamp: () => '',
		guildName: 'G',
		pinned: '',
		ticket: full,
	}, undefined, { escape: escapeHtml });
	const html = await embedTicketImages({
		fetch: fakeFetch({ 'https://cdn.discordapp.com/attachments/1/2/proof.png?ex=1': png(64) }),
		limit: 8 * MiB,
		log,
		render,
		storage: { enabled: false },
		ticket: full,
		transcript: render(),
	});
	const encoded = png(64).toString('base64');
	// The bytes appear exactly once, however many places show the image.
	assert.strictEqual(html.split(encoded).length - 1, 1);
	assert.ok(html.includes(`.img-1 { --src: url("data:image/png;base64,${encoded}"); }`));
	assert.ok(html.includes('id="view-img-1"') && html.includes('href="#view-img-1"'));
	assert.ok(html.includes('style="aspect-ratio: 400 / 300"'));
	// The unfetchable one is still a link.
	assert.ok(html.includes('<img src="https:&#x2F;&#x2F;i.example&#x2F;hotlink.png"'));
	assert.ok(html.includes('1 image(s) could not be saved'));
	assert.ok(html.includes('Images are saved inside this file'));
	ok('rendered transcript stores each image once, opens it in a lightbox, links the rest');

	console.log(`\n[check-transcript-inline] ${pass} checks passed`);
}

main().catch(error => {
	console.error('\n[check-transcript-inline] FAILED:', error.message);
	console.error(error.stack);
	process.exit(1);
});
