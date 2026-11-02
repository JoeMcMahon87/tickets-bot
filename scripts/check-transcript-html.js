/* eslint-disable no-console */
/**
 * Checks the media layout behind the HTML transcript: src/lib/transcript-media.js,
 * the structured fields resolveTicketMedia adds for templates, and the shipped
 * src/user/templates/transcript.html.mustache itself.
 *
 * What matters: reviewers can click straight through to every image, and
 * nothing a member typed can become markup in the rendered page.
 *
 * `presign` is injected, so nothing here touches AWS.
 */

const assert = require('assert');
const fs = require('fs');
const { join } = require('path');
const Mustache = require('mustache');

const {
	describeEmbed,
	escapeHtml,
	formatBytes,
	isHtmlTemplate,
	mediaKind,
	safeUrl,
} = require(join(__dirname, '../src/lib/transcript-media'));
const { resolveTicketMedia } = require(join(__dirname, '../src/lib/transcript'));

let pass = 0;
const ok = name => {
	console.log('  ok   ' + name);
	pass++;
};

const resolver = () => ({
	enabled: true,
	log: {
		error: () => {},
		warn: () => {},
	},
	presign: async key => `https://s3.example/${key}?signed`,
});

const attachment = (extra = {}) => ({
	id: '1',
	name: 'evidence.png',
	url: 'https://cdn.discordapp.com/attachments/1/2/evidence.png?ex=expired',
	...extra,
});

async function main() {
	// ── structured media, for the HTML template ──────────────────────────────
	const rich = {
		archivedMessages: [
			{
				content: {
					attachments: [
						attachment({
							contentType: 'image/png',
							name: 'proof.png',
							s3Key: 'attachments/proof.png',
							size: 2048,
						}),
						attachment({
							contentType: 'application/pdf',
							name: 'log.pdf',
							size: 3 * 1024 * 1024,
						}),
					],
					content: 'see\nattached',
					embeds: [
						{
							data: {
								thumbnail: { url: 'https://i.example/cat.jpg' },
								type: 'image',
								url: 'https://i.example/cat.jpg',
							},
						},
						{ data: { type: 'rich' } },
					],
				},
				number: 'M1',
				text: 'see\n\tattached',
			},
		],
		archivedUsers: [],
	};
	await resolveTicketMedia(rich, resolver());
	const [m] = rich.archivedMessages;
	assert.strictEqual(m.body, 'see\nattached');
	assert.deepStrictEqual(m.media.map(x => [x.name, x.isImage, x.isFile, x.size]), [
		['proof.png', true, false, '2.0 KiB'],
		['log.pdf', false, true, '3.0 MiB'],
	]);
	assert.strictEqual(m.media[0].url, 'https://s3.example/attachments/proof.png?signed');
	// The empty embed is dropped from the previews but still counted in text.
	assert.strictEqual(m.embedPreviews.length, 1);
	assert.strictEqual(m.text.split('[embedded content]').length - 1, 2);
	assert.deepStrictEqual(rich.gallery.map(g => [g.number, g.url]), [
		['M1', 'https://s3.example/attachments/proof.png?signed'],
		['M1', 'https://i.example/cat.jpg'],
	]);
	ok('attachments and embed images are exposed as media and a ticket gallery');

	assert.strictEqual(mediaKind({ contentType: 'image/webp' }), 'image');
	assert.strictEqual(mediaKind({ contentType: 'video/mp4' }), 'video');
	assert.strictEqual(mediaKind({ name: 'old.JPG' }), 'image');
	assert.strictEqual(mediaKind({
		contentType: 'image/svg+xml',
		name: 'x.svg',
	}), 'file');
	assert.strictEqual(mediaKind({ name: 'notes.txt' }), 'file');
	ok('media kind from content type, extension as fallback, SVG never inline');

	assert.strictEqual(formatBytes(undefined), null);
	assert.strictEqual(formatBytes(500), '500 B');
	ok('sizes format, and an unknown size is null');

	assert.strictEqual(safeUrl('javascript:alert(1)'), null);
	assert.strictEqual(safeUrl('https://ok.example'), 'https://ok.example');
	assert.strictEqual(describeEmbed({ data: { url: 'javascript:alert(1)' } }), null);
	assert.strictEqual(describeEmbed({ image: { url: 'https://a.example/b.png' } }).imageUrl, 'https://a.example/b.png');
	ok('embed URLs must be http(s); bare payloads are read too');

	assert.strictEqual(escapeHtml('<b a="1">&\''), '&lt;b a&#x3D;&quot;1&quot;&gt;&amp;&#39;');
	ok('HTML escaping covers content and attributes');

	assert.ok(isHtmlTemplate('transcript.html') && isHtmlTemplate('x.HTM'));
	assert.ok(!isHtmlTemplate('transcript.md') && !isHtmlTemplate(undefined));
	ok('HTML templates are recognised by extension');

	// ── the shipped HTML template ────────────────────────────────────────────
	const template = fs.readFileSync(join(__dirname, '../src/user/templates/transcript.html.mustache'), 'utf8');
	const evil = '<script>alert(1)</script>';
	rich.archivedMessages[0].body = evil;
	rich.archivedMessages[0].author = {
		avatarUrl: null,
		displayName: evil,
		username: 'u',
	};
	const html = Mustache.render(template, {
		channelName: 'ticket-1',
		closedAtFull: () => 'closed',
		createdAtFull: () => 'created',
		createdAtTimestamp: () => 'ts',
		guildName: 'Guild',
		pinned: '',
		ticket: {
			...rich,
			category: { name: 'Support' },
			id: 't1',
			number: 1,
			questionAnswers: [],
		},
	}, undefined, { escape: escapeHtml });
	assert.ok(!html.includes('<script>'), 'ticket content must be escaped');
	assert.ok(html.includes('&lt;script&gt;'));
	assert.ok(html.includes('<img src="https:&#x2F;&#x2F;s3.example&#x2F;attachments&#x2F;proof.png?signed"'));
	assert.ok(html.includes('id="M1"') && html.includes('href="#M1"'));
	assert.ok(html.includes('Images (2)'));
	assert.ok(html.includes('📎 log.pdf'));
	ok('HTML template shows images inline, links files, escapes content');

	console.log(`\n[check-transcript-html] ${pass} checks passed`);
}

main().catch(error => {
	console.error('\n[check-transcript-html] FAILED:', error.message);
	process.exit(1);
});
