/**
 * How a member's avatar is represented in `ArchivedUser.avatar`.
 *
 * That column holds one of two things:
 *
 *   - a bare Discord avatar hash, which is what it has always held, and what
 *     is still stored when mirroring is disabled, unavailable, or declined;
 *   - a mirrored object key, marked with a prefix.
 *
 * Reusing one column rather than adding `avatarS3Key` keeps this fork off a
 * schema migration in all three provider directories, which would collide
 * with upstream's own migrations later for the sake of one nullable string.
 * Nothing is lost by it: a mirrored key ends in `<hash>.webp`, so the hash is
 * recoverable from either form, and `decodeAvatar` returns both.
 *
 * Why mirror at all: a Discord avatar URL is unsigned and does not expire the
 * way an attachment URL does, but the hash stops resolving the moment the
 * member changes their picture or deletes the account. So an unmirrored
 * archive does not rot on a timer — it rots when someone changes their
 * avatar, and nothing signals that it has happened.
 */

/**
 * Avatars are mirrored at 128px. An archive thumbnail has no use for the
 * 1024px original, and size matters more here than for attachments: one
 * object exists per member per avatar, referenced from every ticket they
 * appear in.
 */
const AVATAR_SIZE = 128;

/** Marks the column value as an object key rather than a Discord hash. */
const AVATAR_PREFIX = 's3:';

/**
 * Build the column value for a mirrored avatar.
 * @param {string} key
 * @returns {string}
 */
function encodeAvatar(key) {
	return AVATAR_PREFIX + key;
}

/**
 * Read a column value written by either form.
 *
 * A Discord hash is hex, optionally `a_`-prefixed for animated avatars, so it
 * can never be mistaken for a prefixed key.
 *
 * @param {string?} value
 * @returns {{hash: string?, s3Key: string?}} `s3Key` is null when the avatar
 * was never mirrored; `hash` is null only when there was no avatar at all.
 */
function decodeAvatar(value) {
	if (!value) {
		return {
			hash: null,
			s3Key: null,
		};
	}

	if (!value.startsWith(AVATAR_PREFIX)) {
		return {
			hash: value,
			s3Key: null,
		};
	}

	const s3Key = value.slice(AVATAR_PREFIX.length);
	const basename = s3Key.split('/').pop() || '';

	return {
		hash: basename.replace(/\.[^.]+$/, '') || null,
		s3Key,
	};
}

module.exports = {
	AVATAR_PREFIX,
	AVATAR_SIZE,
	decodeAvatar,
	encodeAvatar,
};
