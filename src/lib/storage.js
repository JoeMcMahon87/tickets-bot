/**
 * Optional S3 object storage.
 *
 * Two jobs, both of which fix a real problem rather than just moving bytes
 * around:
 *
 *  1. Transcripts. `/transcript` renders the whole ticket in memory and sends
 *     it as a Discord attachment, which fails outright once a busy ticket
 *     renders past Discord's upload limit. Uploading and handing back a
 *     presigned link has no such ceiling.
 *
 *  2. Attachments. Archived messages store only Discord's CDN URL for each
 *     attachment, and those URLs expire — so old transcripts quietly rot.
 *     Mirroring the bytes to S3 makes the archive self-contained.
 *
 * Everything here is optional and off unless `S3_BUCKET` is set, so a
 * self-hoster with no AWS account is unaffected and this stays mergeable with
 * upstream. Callers must treat every function as fallible and degrade to the
 * existing behaviour rather than failing the interaction: the bot staying
 * available matters more than a transcript reaching S3.
 *
 * Works with any S3-compatible store (MinIO, R2, Backblaze) via `S3_ENDPOINT`.
 */

const ms = require('ms');

const bucket = process.env.S3_BUCKET || null;

/** Whether object storage is configured at all. */
const enabled = !!bucket;

/**
 * Whether to mirror message attachments. Defaults on when a bucket is
 * configured, since the expiring-URL problem it solves is silent.
 */
const archiveAttachments = enabled && process.env.S3_ARCHIVE_ATTACHMENTS !== 'false';

/**
 * Attachments larger than this are left as Discord URLs rather than mirrored.
 * The shared instance is memory-constrained, and a mirrored object is buffered
 * in full before upload, so this cap is what keeps a 500 MiB upload in a
 * ticket from taking the bot down. 8 MiB by default.
 */
const maxAttachmentSize = parseInt(process.env.S3_MAX_ATTACHMENT_SIZE) || 8 * 1024 * 1024;

/** SigV4 presigned URLs cannot outlive 7 days. */
const MAX_EXPIRY = 604800;
const urlExpiry = Math.min(
	parseInt(process.env.S3_URL_EXPIRY) || ms('1d') / 1000,
	MAX_EXPIRY,
);

// Operator-configured, so its slashes are meaningful and kept: a prefix of
// "env/prod" is two levels deep on purpose. Only the leading/trailing and
// duplicate separators are tidied.
const prefix = (process.env.S3_PREFIX || '')
	.replace(/^\/+|\/+$/g, '')
	.replace(/\/+/g, '/');

/**
 * At most this many attachment mirrors run at once. Each one buffers up to
 * `maxAttachmentSize`, so this bounds the worst-case footprint rather than
 * letting a burst of messages decide it.
 */
const MAX_CONCURRENT_MIRRORS = 2;

let client;
let getSignedUrl;
let GetObjectCommand;
let PutObjectCommand;

/**
 * The AWS SDK is only loaded when storage is actually used, so the require
 * cost is not paid by self-hosters who have not configured a bucket.
 */
function getClient() {
	if (!enabled) throw new Error('S3 storage is not configured');
	if (!client) {
		const s3 = require('@aws-sdk/client-s3');
		({
			GetObjectCommand,
			PutObjectCommand,
		} = s3);
		({ getSignedUrl } = require('@aws-sdk/s3-request-presigner'));
		client = new s3.S3Client({
			region: process.env.S3_REGION || process.env.AWS_REGION,
			...(process.env.S3_ENDPOINT
				? {
					endpoint: process.env.S3_ENDPOINT,
					// Custom endpoints are rarely virtual-host addressable.
					forcePathStyle: true,
				}
				: {}),
		});
	}
	return client;
}

/**
 * Join path segments into an object key, applying `S3_PREFIX` and dropping
 * anything that could escape the intended prefix.
 * @param {...string} parts
 * @returns {string}
 */
function buildKey(...parts) {
	// Each part becomes exactly one key segment. Callers pass values that are
	// attacker-influenced -- a Discord filename can be anything, including
	// "../../x" -- so separators are flattened and leading dots stripped,
	// which makes it impossible for a part to climb out of its prefix.
	const segments = parts
		.filter(part => part !== null && part !== undefined && part !== '')
		.map(part => String(part).replace(/[/\\]+/g, '_').replace(/^\.+/, ''))
		.filter(part => part !== '');
	return (prefix ? [prefix, ...segments] : segments).join('/');
}

/**
 * Upload an object.
 * @param {object} options
 * @param {string} options.key
 * @param {Buffer|Uint8Array|string} options.body
 * @param {string?} options.contentType
 * @returns {Promise<string>} the key written
 */
async function put({
	body,
	contentType,
	key,
}) {
	await getClient().send(new PutObjectCommand({
		Body: body,
		Bucket: bucket,
		ContentType: contentType,
		Key: key,
	}));
	return key;
}

/**
 * Create a time-limited download URL for an object.
 * @param {string} key
 * @param {object} options
 * @param {number?} options.expiresIn seconds; capped at 7 days
 * @param {string?} options.filename suggested download filename
 * @returns {Promise<string>}
 */
async function presign(key, {
	expiresIn,
	filename,
} = {}) {
	const c = getClient();
	return await getSignedUrl(
		c,
		new GetObjectCommand({
			Bucket: bucket,
			Key: key,
			// Without this the browser saves the object under its key, which
			// is a ticket ID rather than anything a human asked for.
			...(filename
				? { ResponseContentDisposition: `attachment; filename="${filename.replace(/"/g, '')}"` }
				: {}),
		}),
		{ expiresIn: Math.min(expiresIn || urlExpiry, MAX_EXPIRY) },
	);
}

let activeMirrors = 0;
const mirrorQueue = [];

/** Release a mirror slot and start whatever is waiting for one. */
function releaseMirrorSlot() {
	activeMirrors--;
	const next = mirrorQueue.shift();
	if (next) next();
}

/** Wait for a free mirror slot. */
function acquireMirrorSlot() {
	if (activeMirrors < MAX_CONCURRENT_MIRRORS) {
		activeMirrors++;
		return Promise.resolve();
	}
	return new Promise(resolve => mirrorQueue.push(() => {
		activeMirrors++;
		resolve();
	}));
}

/**
 * Copy a remote file into the bucket.
 *
 * Returns `null` rather than throwing when the file is too large or the
 * source is unavailable: a missing mirror is a degraded archive, not a failed
 * one, and the caller keeps the original URL either way.
 *
 * @param {string} url source URL
 * @param {string} key destination key
 * @param {object} options
 * @param {number?} options.size expected size, if known in advance
 * @param {string?} options.contentType
 * @returns {Promise<string|null>} the key written, or null
 */
async function mirror(url, key, {
	contentType,
	size,
} = {}) {
	// Checking the size we were told before opening the connection avoids
	// streaming something we have already decided to reject.
	if (size && size > maxAttachmentSize) return null;

	await acquireMirrorSlot();

	try {
		const res = await fetch(url);
		if (!res.ok) return null;

		// Discord's declared size and the response can disagree; trust neither
		// without checking, or the cap is advisory only.
		const declared = parseInt(res.headers.get('content-length'));
		if (declared && declared > maxAttachmentSize) return null;

		const body = Buffer.from(await res.arrayBuffer());
		if (body.length > maxAttachmentSize) return null;

		return await put({
			body,
			contentType: contentType || res.headers.get('content-type') || 'application/octet-stream',
			key,
		});
	} finally {
		releaseMirrorSlot();
	}
}

module.exports = {
	archiveAttachments,
	bucket,
	buildKey,
	enabled,
	maxAttachmentSize,
	mirror,
	presign,
	put,
	urlExpiry,
};
