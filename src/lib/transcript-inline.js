/**
 * Embedding a ticket's images in its HTML transcript.
 *
 * A transcript that only links its images is only as durable as the links:
 * Discord's attachment URLs and our own presigned URLs both expire, so a
 * transcript posted to an archive channel shows broken pictures a day later.
 * Carrying the bytes inside the file removes the dependency altogether.
 *
 * The bytes come from the S3 mirror when there is one, and otherwise from
 * Discord's own CDN and media proxy -- never from anywhere else. Embeds can be
 * posted by other bots with arbitrary URLs, and fetching those would let a
 * ticket make the bot request internal addresses. Discord's proxy already
 * holds a copy of any embed image, so nothing is lost by refusing the rest.
 *
 * The total is capped, because a transcript is attached to a Discord message
 * and has to fit under the upload limit. Images that do not fit, or cannot be
 * fetched, keep their link: an embedded image is an improvement, never a
 * requirement.
 *
 * The loader is injected, so this module has no network or S3 dependency of
 * its own and scripts/check-transcript-html.js can exercise it directly.
 */

/**
 * Hosts the bot will fetch from to embed an unmirrored image.
 * @param {string?} url
 * @returns {boolean}
 */
function isDiscordMediaUrl(url) {
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	if (parsed.protocol !== 'https:') return false;
	return parsed.hostname === 'cdn.discordapp.com' ||
		parsed.hostname === 'media.discordapp.net' ||
		/^images-ext-\d+\.discordapp\.net$/.test(parsed.hostname);
}

/**
 * The image type of some bytes, judged by their signature, or null if they
 * are not an image a browser will show.
 *
 * Neither the stored content type nor the server's is trusted: what goes
 * into the `data:` URI is what the bytes actually are. SVG is never
 * recognised, so it is never embedded.
 * @param {Uint8Array} bytes
 * @returns {string?}
 */
function sniffImage(bytes) {
	const b = bytes;
	const at = (offset, ...values) => values.every((v, i) => b[offset + i] === v);
	const ascii = (offset, text) => at(offset, ...[...text].map(c => c.charCodeAt(0)));
	if (b.length < 12) return null;
	if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
	if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
	if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif';
	if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
	if (ascii(4, 'ftypavif') || ascii(4, 'ftypavis')) return 'image/avif';
	if (ascii(0, 'BM')) return 'image/bmp';
	return null;
}

/**
 * Fetch a URL into memory, giving up rather than reading past `maxBytes`.
 *
 * Redirects are refused, so an allowed host cannot bounce the request
 * somewhere that is not.
 * @param {string} url
 * @param {number} maxBytes
 * @param {object} options
 * @param {typeof fetch} options.fetch
 * @param {number} options.timeout milliseconds
 * @returns {Promise<Buffer?>}
 */
async function fetchCapped(url, maxBytes, {
	fetch: fetchImpl = fetch,
	timeout = 10000,
} = {}) {
	const res = await fetchImpl(url, {
		redirect: 'error',
		signal: AbortSignal.timeout(timeout),
	});
	if (!res.ok) return null;

	const declared = parseInt(res.headers.get('content-length'));
	if (declared && declared > maxBytes) {
		await res.body?.cancel();
		return null;
	}

	if (!res.body?.getReader) {
		const body = Buffer.from(await res.arrayBuffer());
		return body.length > maxBytes ? null : body;
	}

	const reader = res.body.getReader();
	const chunks = [];
	let total = 0;
	for (;;) {
		const {
			done,
			value,
		} = await reader.read();
		if (done) break;
		total += value.length;
		if (total > maxBytes) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks);
}

/**
 * How many raw image bytes fit in a transcript that must stay under
 * `limit`, given how big it is with no images embedded.
 *
 * Base64 costs four bytes for every three, and each image adds a little CSS
 * around its data, which the margin covers.
 * @param {object} options
 * @param {number} options.configured the operator's cap; 0 disables embedding
 * @param {number} options.limit the transcript's size ceiling
 * @param {number} options.baseSize the transcript's size without images
 * @param {number} options.images how many images might be embedded
 * @returns {number}
 */
function fitBudget({
	baseSize,
	configured,
	images,
	limit,
}) {
	if (!(configured > 0)) return 0;
	const room = limit - baseSize - (images * 256) - 64 * 1024;
	return Math.max(0, Math.min(configured, Math.floor(room * 3 / 4)));
}

/**
 * Embed as many of the ticket's images as the budget allows, in place.
 *
 * Works through `ticket.gallery` in order, which is the order they were
 * posted. An image too big for what is left is skipped, not the end of the
 * run, so smaller ones later in the ticket still get in. Each embedded image
 * gets a `dataUri`; the ticket gets `inlineImages` (those embedded) and
 * `linkedImageCount` (those left as links).
 *
 * @param {object} ticket a ticket that has been through resolveTicketMedia
 * @param {object} options
 * @param {number} options.budget raw bytes available, in total
 * @param {(item: object, maxBytes: number) => Promise<Uint8Array?>} options.load
 * @param {{warn: function, error: function}} options.log
 * @returns {Promise<object>} the same ticket
 */
async function inlineTicketImages(ticket, {
	budget,
	load,
	log,
}) {
	let remaining = budget;
	const gallery = ticket.gallery ?? [];

	for (const item of gallery) {
		if (remaining <= 0) break;
		let bytes;
		try {
			bytes = await load(item, remaining);
		} catch (error) {
			log.warn('Could not embed image %s in a transcript, keeping its link', item.name);
			log.error(error);
			continue;
		}
		if (!bytes || bytes.length > remaining) continue;

		const type = sniffImage(bytes);
		if (!type) continue;

		item.dataUri = `data:${type};base64,${Buffer.from(bytes).toString('base64')}`;
		remaining -= bytes.length;
	}

	ticket.inlineImages = gallery.filter(item => item.dataUri);
	ticket.linkedImageCount = gallery.length - ticket.inlineImages.length;
	return ticket;
}

/**
 * The loader `inlineTicketImages` uses in the bot: the S3 mirror first, then
 * Discord's CDN, and nothing else.
 * @param {object} options
 * @param {{enabled: boolean, get: function}} options.storage src/lib/storage.js
 * @param {{warn: function, error: function}} options.log
 * @param {typeof fetch} options.fetch
 * @returns {(item: object, maxBytes: number) => Promise<Uint8Array?>}
 */
function createLoader({
	fetch: fetchImpl = fetch,
	log,
	storage,
}) {
	return async (item, maxBytes) => {
		if (item.s3Key && storage.enabled) {
			try {
				const bytes = await storage.get(item.s3Key, { maxBytes });
				if (bytes) return bytes;
			} catch (error) {
				// The Discord URL may still be live, so this is not the end.
				log.warn('Could not read %s from storage to embed it', item.s3Key);
				log.error(error);
			}
		}
		if (!isDiscordMediaUrl(item.sourceUrl)) return null;
		return await fetchCapped(item.sourceUrl, maxBytes, { fetch: fetchImpl });
	};
}

/**
 * The operator's cap on embedded image bytes per transcript. Defaults to
 * 6 MiB, which is as much as base64 lets fit under an 8 MiB file anyway, so
 * the default in practice is "whatever fits". 0 turns embedding off.
 * @param {object} env
 * @returns {number}
 */
function configuredBudget(env = process.env) {
	const value = env.TRANSCRIPT_INLINE_IMAGE_BYTES;
	if (value === undefined || value === '') return 6 * 1024 * 1024;
	const n = Number(value);
	return Number.isInteger(n) && n >= 0 ? n : 0;
}

/**
 * Embed a ticket's images and re-render its transcript, if any fit.
 *
 * The transcript is rendered once without images first, because the text is
 * what decides how much room is left under `limit`.
 * @param {object} options
 * @param {object} options.ticket after resolveTicketMedia
 * @param {string} options.transcript the render without images
 * @param {() => string} options.render renders the ticket again
 * @param {number} options.limit the transcript's size ceiling, bytes
 * @param {object} options.storage src/lib/storage.js
 * @param {{warn: function, error: function}} options.log
 * @param {typeof fetch} options.fetch
 * @returns {Promise<string>} the transcript, with images where they fit
 */
async function embedTicketImages({
	fetch: fetchImpl = fetch,
	limit,
	log,
	render,
	storage,
	ticket,
	transcript,
}) {
	if (!ticket.gallery?.length) return transcript;
	const budget = fitBudget({
		baseSize: Buffer.byteLength(transcript, 'utf8'),
		configured: configuredBudget(),
		images: ticket.gallery.length,
		limit,
	});
	if (budget <= 0) return transcript;

	await inlineTicketImages(ticket, {
		budget,
		load: createLoader({
			fetch: fetchImpl,
			log,
			storage,
		}),
		log,
	});
	return ticket.inlineImages.length > 0 ? render() : transcript;
}

module.exports = {
	configuredBudget,
	createLoader,
	embedTicketImages,
	fetchCapped,
	fitBudget,
	inlineTicketImages,
	isDiscordMediaUrl,
	sniffImage,
};
