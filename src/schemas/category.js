/**
 * Body schemas for the category endpoints.
 *
 * Mirrors the `Category` model, and `Question` for the nested array that
 * PATCH upserts. See README.md in this directory.
 */

const roleIds = {
	items: {
		maxLength: 20,
		type: 'string',
	},
	type: 'array',
};

// PATCH upserts these by `id`, so an existing question carries one and a new
// one does not.
const question = {
	additionalProperties: false,
	properties: {
		id: {
			maxLength: 36,
			type: 'string',
		},
		label: {
			maxLength: 45,
			type: 'string',
		},
		maxLength: { type: ['integer', 'null'] },
		minLength: { type: ['integer', 'null'] },
		options: { type: 'array' },
		order: { type: 'integer' },
		placeholder: {
			maxLength: 100,
			type: ['string', 'null'],
		},
		required: { type: 'boolean' },
		style: { type: 'integer' },
		type: {
			enum: ['MENU', 'TEXT'],
			type: 'string',
		},
		value: { type: ['string', 'null'] },
	},
	type: 'object',
};

const properties = {
	channelName: {
		maxLength: 100,
		type: 'string',
	},
	claiming: { type: 'boolean' },
	cooldown: { type: ['integer', 'null'] },
	customTopic: {
		maxLength: 100,
		type: ['string', 'null'],
	},
	description: {
		maxLength: 100,
		type: 'string',
	},
	discordCategory: {
		maxLength: 20,
		type: 'string',
	},
	emoji: {
		maxLength: 64,
		type: 'string',
	},
	enableFeedback: { type: 'boolean' },
	image: { type: ['string', 'null'] },
	memberLimit: {
		maximum: 25,
		minimum: 1,
		type: 'integer',
	},
	name: {
		maxLength: 100,
		type: 'string',
	},
	openingMessage: { type: 'string' },
	pingRoles: roleIds,
	questions: {
		items: question,
		type: 'array',
	},
	ratelimit: { type: ['integer', 'null'] },
	requireTopic: { type: 'boolean' },
	requiredRoles: roleIds,
	staffRoles: roleIds,
	totalLimit: {
		minimum: -1,
		type: 'integer',
	},
	// Where a closed ticket's transcript is posted; empty or null falls back
	// to transcripts.onClose in config.yml.
	transcriptChannel: {
		maxLength: 20,
		type: ['string', 'null'],
	},
};

module.exports = {
	// Creating a category needs the fields that have no database default.
	create: {
		additionalProperties: false,
		properties,
		required: ['name'],
		type: 'object',
	},
	patch: {
		additionalProperties: false,
		properties,
		type: 'object',
	},
};
