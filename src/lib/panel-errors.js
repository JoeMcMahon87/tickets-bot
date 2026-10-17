/**
 * Working out why creating a panel failed.
 *
 * Panel creation is several Discord calls in a row -- resolve or create a
 * channel, then send a message with components into it -- and when one fails
 * the only thing reaching the log was the raw rejection:
 *
 *   [ERROR] (HTTP) req-1e4 DiscordAPIError[50013]: Missing Permissions
 *       at async Object.handler (.../panels.js:128:5)
 *
 * which says neither what the bot was attempting nor what it is missing. In
 * practice the answer is almost always a permission the bot does not hold in
 * the target channel, so these helpers name the step, decode the code, and
 * list the permissions that are actually absent.
 */

const { PermissionsBitField } = require('discord.js');

const { Flags } = PermissionsBitField;

/**
 * What the bot needs in a channel to post a panel into it.
 *
 * `ViewChannel` and `SendMessages` are obvious. `EmbedLinks` is the one that
 * catches people out: a panel is an embed, so without it the send fails with
 * `Missing Permissions` even though the bot can clearly talk in the channel.
 */
const REQUIRED_CHANNEL_PERMISSIONS = [
	['ViewChannel', Flags.ViewChannel],
	['SendMessages', Flags.SendMessages],
	['EmbedLinks', Flags.EmbedLinks],
];

module.exports.REQUIRED_CHANNEL_PERMISSIONS = REQUIRED_CHANNEL_PERMISSIONS;

/**
 * Which of the required permissions the bot lacks in a channel.
 *
 * @param {?import('discord.js').PermissionsBitField} permissions the bot's
 *   effective permissions in the channel, from `channel.permissionsFor(me)`.
 *   Null is treated as "everything is missing", which is what a channel the
 *   bot cannot see looks like.
 * @returns {string[]} permission names, empty when nothing is missing
 */
const missingChannelPermissions = permissions => {
	if (!permissions) return REQUIRED_CHANNEL_PERMISSIONS.map(([name]) => name);
	return REQUIRED_CHANNEL_PERMISSIONS
		.filter(([, flag]) => !permissions.has(flag))
		.map(([name]) => name);
};

module.exports.missingChannelPermissions = missingChannelPermissions;

/**
 * Discord error codes worth saying something specific about.
 *
 * Only the ones that actually come up here. Anything else falls through to the
 * raw message, which is better than a wrong guess.
 */
const EXPLANATIONS = {
	10003: 'that channel no longer exists, or the bot cannot see it',
	30007: 'the channel has hit its webhook limit',
	30010: 'the guild has too many channels',
	50001: 'the bot has no access to that channel -- it is missing View Channel, or is not permitted to see it at all',
	50013: 'the bot is missing a permission it needs in that channel',
	50035: 'Discord rejected the panel contents as invalid',
	160002: 'the bot cannot use one of the emojis on this panel',
};

/**
 * A one-line explanation of a failed panel step, for the log.
 *
 * @param {object} options
 * @param {string} options.step what was being attempted, as a phrase
 * @param {Error} options.error the rejection
 * @param {string} [options.channelId]
 * @param {string[]} [options.missing] permissions known to be absent
 * @returns {string}
 */
module.exports.describe = ({
	step, error, channelId, missing,
}) => {
	const parts = [`could not ${step}`];
	if (channelId) parts.push(`channel=${channelId}`);

	const code = error?.code ?? error?.rawError?.code;
	if (code !== undefined) {
		const explanation = EXPLANATIONS[code];
		parts.push(explanation ? `${code}: ${explanation}` : `${code}: ${error.message}`);
	} else {
		parts.push(error?.message ?? String(error));
	}

	// The decisive detail when the cause is permissions, and the thing the raw
	// rejection never carried.
	if (missing?.length) parts.push(`missing=${missing.join(', ')}`);

	return parts.join(' | ');
};
