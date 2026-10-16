/* eslint-disable no-console */
const { randomBytes } = require('crypto');
const fs = require('fs');
const { short } = require('leeks.js');

function log (...strings) {
	console.log(short('&9[preinstall]&r'), ...strings);
}

if (process.env.CI) {
	log('CI detected, skipping');
	process.exit(0);
}

const env = {
	CPU_LIMIT: '',
	DB_CONNECTION_URL: '',
	DB_PROVIDER: '', // don't default to sqlite, postinstall checks if empty
	DISABLE_ENCRYPTION: false,
	DISCORD_SECRET: '',
	DISCORD_TOKEN: '',
	ENCRYPTION_KEY: randomBytes(24).toString('hex'),
	HTTP_EXTERNAL: 'http://127.0.0.1:8169',
	HTTP_HOST: '0.0.0.0',
	HTTP_INTERNAL: '',
	HTTP_PORT: 8169,
	HTTP_TRUST_PROXY: false,
	INVALIDATE_TOKENS: '',
	NODE_ENV: 'production', // not bot-specific
	OVERRIDE_ARCHIVE: '',
	PUBLIC_BOT: false,
	PUBLISH_COMMANDS: false,
	// Optional S3 object storage: transcripts are delivered as presigned links
	// instead of Discord attachments, and message attachments are mirrored so
	// archives survive Discord's CDN URLs expiring. Leave S3_BUCKET empty to
	// keep everything local.
	S3_ARCHIVE_ATTACHMENTS: '',
	S3_ARCHIVE_AVATARS: '',
	S3_BUCKET: '',
	S3_ENDPOINT: '',
	S3_MAX_ATTACHMENT_SIZE: '',
	S3_PREFIX: '',
	S3_REGION: '',
	S3_URL_EXPIRY: '',
	// Deliberately empty: `ManageGuild` is the admin threshold, and upstream's
	// default here is an account we do not control.
	SUPER: '',
};

// check ENCRYPTION_KEY because we don't want to force use of the .env file
if (!process.env.ENCRYPTION_KEY && !fs.existsSync('./.env')) {
	log('generating ENCRYPTION_KEY');
	fs.writeFileSync('./.env', Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n'));
	log('created .env file');
	log(short('&r&0&!e WARNING &r &e&lkeep your environment variables safe, don\'t lose your encryption key or you will lose data'));
} else {
	log('nothing to do');
}
