const { createHash } = require('crypto');
module.exports.md5 = str => createHash('md5').update(str).digest('hex');

module.exports.iconURL = guildLike => guildLike.icon
	? guildLike.client.rest.cdn.icon(guildLike.id, guildLike.icon)
	: `https://api.dicebear.com/8.x/initials/png?seed=${encodeURIComponent(guildLike.name)}&size=96&backgroundType=gradientLinear&fontWeight=600`;

/**
 * Whether session cookies should carry the `Secure` attribute.
 *
 * Derived from `HTTP_EXTERNAL` rather than hardcoded, because both
 * deployments are legitimate: the dashboard is reached over HTTPS at a public
 * hostname, and over plain HTTP at `http://localhost:8169` through an SSH
 * tunnel, where `Secure` would stop the cookie being sent at all and make
 * login silently fail.
 *
 * It lives here, in one place, because getting it wrong in only one of the
 * three places cookies are set is the likely failure -- and the failure is
 * silent either way round.
 *
 * @returns {boolean}
 */
module.exports.useSecureCookies = () => (process.env.HTTP_EXTERNAL ?? '').startsWith('https://');
