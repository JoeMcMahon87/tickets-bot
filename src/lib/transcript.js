/**
 * Resolves the media referenced by an archived ticket into usable URLs, for
 * rendering a transcript.
 *
 * This runs on the main thread rather than in the transcript worker, because
 * presigning needs the S3 client, and the worker is a separate thread that
 * exists to offload decryption. The worker therefore leaves `message.text`
 * holding only the message body, and the attachment and embed lines are
 * appended here, in the same order it used to produce them.
 *
 * What this buys: a mirrored attachment outlives Discord's CDN URL, so a
 * transcript *regenerated* at any later date still has working links. The
 * presigned URLs written into a given transcript file do expire — like the
 * Discord URLs they replace — but the objects behind them do not, which is
 * the part that was previously lost for good.
 *
 * Every resolution falls back to the original Discord URL, so a transcript is
 * never worse than it was before mirroring existed.
 */

const { decodeAvatar } = require('./avatars');

const DISCORD_CDN = 'https://cdn.discordapp.com';

/**
 * @typedef {object} Resolver
 * @property {(key: string, options?: object) => Promise<string>} presign
 * @property {boolean} enabled whether object storage is configured
 * @property {{warn: function, error: function}} log
 */

/**
 * The URL for an attachment: the mirrored copy when there is one, otherwise
 * the Discord URL that may already have expired.
 * @param {object} attachment
 * @param {Resolver} resolver
 * @returns {Promise<string>}
 */
async function resolveAttachmentUrl(attachment, resolver) {
	if (!resolver.enabled || !attachment.s3Key) return attachment.url;
	try {
		return await resolver.presign(attachment.s3Key, { filename: attachment.name });
	} catch (error) {
		resolver.log.warn('Failed to sign attachment %s, using the Discord URL', attachment.s3Key);
		resolver.log.error(error);
		return attachment.url;
	}
}

/**
 * The URL for an archived user's avatar, or null if they had none.
 *
 * For a mirrored avatar this is the image as it was when the ticket happened.
 * For a value stored before mirroring existed only the hash is known, and
 * the per-guild and global avatars live at different CDN paths with no record
 * of which this was — so the global path is assumed, and may 404. That
 * ambiguity is precisely what mirroring removes going forward.
 *
 * @param {object} user an ArchivedUser row
 * @param {Resolver} resolver
 * @returns {Promise<string?>}
 */
async function resolveAvatarUrl(user, resolver) {
	const {
		hash,
		s3Key,
	} = decodeAvatar(user.avatar);

	if (!hash && !s3Key) return null;

	const fallback = hash ? `${DISCORD_CDN}/avatars/${user.userId}/${hash}.webp` : null;

	if (!resolver.enabled || !s3Key) return fallback;

	try {
		return await resolver.presign(s3Key);
	} catch (error) {
		resolver.log.warn('Failed to sign avatar %s, falling back to the CDN', s3Key);
		resolver.log.error(error);
		return fallback;
	}
}

/**
 * Fill in the media URLs on a decrypted ticket, in place.
 *
 * Appends each message's attachment and embed lines to `message.text`, and
 * sets `avatarUrl` on every archived user so a transcript template can show
 * participants' avatars as they were.
 *
 * @param {object} ticket the ticket as returned by the transcript worker
 * @param {Resolver} resolver
 * @returns {Promise<object>} the same ticket
 */
async function resolveTicketMedia(ticket, resolver) {
	for (const message of ticket.archivedMessages ?? []) {
		for (const attachment of message.content?.attachments ?? []) {
			message.text += '\n\t' + await resolveAttachmentUrl(attachment, resolver);
		}
		const embedCount = message.content?.embeds?.length ?? 0;
		for (let i = 0; i < embedCount; i++) {
			message.text += '\n\t[embedded content]';
		}
	}

	// The same user appears once per ticket, so this is a handful of
	// signatures per transcript, each of which is local computation.
	for (const user of ticket.archivedUsers ?? []) {
		user.avatarUrl = await resolveAvatarUrl(user, resolver);
	}

	return ticket;
}

module.exports = {
	DISCORD_CDN,
	resolveAttachmentUrl,
	resolveAvatarUrl,
	resolveTicketMedia,
};
