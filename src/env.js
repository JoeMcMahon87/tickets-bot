/* eslint-disable no-console */

const dotenv = require('dotenv');
const { colours } = require('leeks.js');

const providers = ['mysql', 'postgresql', 'sqlite'];

// ideally the defaults would be set here too, but the pre-install script may run when `src/` is not available
const env = {
	DB_CONNECTION_URL: v =>
		!!v ||
		(process.env.DB_PROVIDER === 'sqlite') ||
		new Error('must be set when "DB_PROVIDER" is not "sqlite"'),
	DB_PROVIDER: v =>
		(!!v && providers.includes(v)) ||
		new Error(`must be one of: ${providers.map(v => `"${v}"`).join(', ')}`),
	DISCORD_SECRET: v =>
		!!v ||
		new Error('is required'),
	DISCORD_TOKEN: v =>
		!!v ||
		new Error('is required'),
	ENCRYPTION_KEY: v =>
		(!!v && v.length >= 48) ||
		new Error('is required and must be at least 48 characters long; run "npm run keygen" to generate a key'),
	HTTP_EXTERNAL: v => {
		if (v?.endsWith('/')) {
			v = v.slice(0, -1);
			process.env.HTTP_EXTERNAL = v;
		}
		return (!!v && v.startsWith('http')) ||
			new Error('must be a valid URL without a trailing slash');
	},
	HTTP_HOST: v =>
		(!!v && !v.startsWith('http')) ||
		new Error('is required and must be an address, not a URL'),
	HTTP_INTERNAL: () => true, // optional
	HTTP_PORT: v =>
		!!v ||
		new Error('is required'),
	HTTP_TRUST_PROXY: () => true, // optional
	INVALIDATE_TOKENS: () => true, // optional
	OVERRIDE_ARCHIVE: () => true, // optional
	PUBLIC_BOT: () => true, // optional
	PUBLISH_COMMANDS: () => true, // optional
	// Optional S3 object storage. Everything stays disabled unless S3_BUCKET
	// is set, so these must not be required. See src/lib/storage.js.
	S3_ARCHIVE_ATTACHMENTS: () => true, // optional
	S3_ARCHIVE_AVATARS: () => true, // optional
	S3_BUCKET: () => true, // optional
	S3_ENDPOINT: () => true, // optional
	S3_MAX_ATTACHMENT_SIZE: () => true, // optional
	S3_PREFIX: () => true, // optional
	S3_REGION: v =>
		(!v || !!(process.env.S3_BUCKET)) ||
		new Error('is only meaningful when "S3_BUCKET" is set'),
	S3_URL_EXPIRY: v =>
		(!v || (Number.isInteger(Number(v)) && Number(v) > 0 && Number(v) <= 604800)) ||
		new Error('must be a number of seconds between 1 and 604800 (7 days, the SigV4 maximum)'),
	// Optional, and expected to be empty: `ManageGuild` is the admin threshold.
	// Anything listed here outranks a guild owner in every guild, so a typo must
	// not pass silently as an ID that can never match.
	SUPER: v =>
		(!v || v.split(',').every(id => /^\d{17,20}$/.test(id.trim()))) ||
		new Error('must be empty, or a comma-separated list of Discord user IDs'),
};

const load = options => {
	dotenv.config(options);
	Object.entries(env).forEach(([name, validate]) => {
		const result = validate(process.env[name]); // `true` for pass, or `Error` for fail
		if (result instanceof Error) {
			console.log('\x07' + colours.redBright(`Error: The "${name}" environment variable ${result.message}.`));
			process.exit(1);
		}
	});
};

module.exports = {
	env,
	load,
};
