/**
 * Pure helpers for laying out a transcript's media: what kind of thing an
 * attachment is, what an embed has worth showing, and escaping for the HTML
 * template. No dependencies, so scripts/check-transcript.js can exercise them
 * directly.
 */

/** Extensions a browser will show in an `<img>`, for attachments with no content type. */
const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|avif|bmp)$/i;
const VIDEO_EXTENSION = /\.(mp4|webm|mov)$/i;

/**
 * What a reviewer should be shown for an attachment: the picture itself, a
 * player, or a plain link.
 *
 * Discord records a content type for anything uploaded in the last few
 * years; the extension is the fallback for older rows that have none.
 * SVG is deliberately not an image here: it is a document format that can
 * carry script, and a link to it is safer than rendering it.
 * @param {object} attachment
 * @returns {'image'|'video'|'file'}
 */
function mediaKind(attachment) {
	const type = attachment.contentType ?? '';
	const name = attachment.name ?? attachment.url ?? '';
	if (type.startsWith('image/') && !type.startsWith('image/svg')) return 'image';
	if (type.startsWith('video/')) return 'video';
	if (!type && IMAGE_EXTENSION.test(name)) return 'image';
	if (!type && VIDEO_EXTENSION.test(name)) return 'video';
	return 'file';
}

/**
 * A human-readable size, or null when the size was not recorded.
 * @param {number?} bytes
 * @returns {string?}
 */
function formatBytes(bytes) {
	if (!Number.isFinite(bytes) || bytes < 0) return null;
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/**
 * The URL if it is http(s), otherwise null.
 *
 * Embeds can be posted by other bots, so their URLs are not ours to trust; a
 * `javascript:` link must never reach an `href` in an HTML transcript.
 * @param {unknown} url
 * @returns {string?}
 */
function safeUrl(url) {
	if (typeof url !== 'string') return null;
	return /^https?:\/\//i.test(url) ? url : null;
}

/**
 * Escape text for HTML, element content and quoted attributes alike.
 * @param {unknown} text
 * @returns {string}
 */
function escapeHtml(text) {
	return String(text).replace(/[&<>"'`=/]/g, c => ({
		'"': '&quot;',
		'&': '&amp;',
		'\'': '&#39;',
		'/': '&#x2F;',
		'<': '&lt;',
		'=': '&#x3D;',
		'>': '&gt;',
		'`': '&#x60;',
	})[c]);
}

/**
 * What a reviewer needs from an archived embed, or null if there is nothing
 * worth showing.
 *
 * Embeds are archived as `{ ...embed }` of a discord.js `Embed`, which puts
 * the API payload under `data`; anything stored as a bare payload is read
 * as-is. Embed images are not mirrored, so these are the original URLs.
 * @param {object} embed
 * @returns {{title: string?, url: string?, description: string?, imageUrl: string?}?}
 */
function describeEmbed(embed) {
	const data = embed?.data ?? embed ?? {};
	const preview = {
		description: typeof data.description === 'string' ? data.description : null,
		imageUrl: safeUrl(data.image?.url) ?? safeUrl(data.thumbnail?.url),
		title: typeof data.title === 'string' ? data.title : null,
		url: safeUrl(data.url),
	};
	if (!preview.title && !preview.url && !preview.description && !preview.imageUrl) return null;
	return preview;
}

/**
 * Whether a template name renders to HTML, judged by its extension the same
 * way the transcript's file name is.
 * @param {string} name e.g. `transcript.html`
 * @returns {boolean}
 */
function isHtmlTemplate(name) {
	return /\.html?$/i.test(name ?? '');
}

module.exports = {
	describeEmbed,
	escapeHtml,
	formatBytes,
	isHtmlTemplate,
	mediaKind,
	safeUrl,
};
