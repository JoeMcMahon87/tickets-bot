/**
 * Body schema for POST /api/admin/guilds/:guild/panels.
 *
 * This one writes no database rows — it posts a message to Discord — but the
 * handler indexes into `data.categories` and branches on `data.type`, so an
 * unexpected body produced a 500 from a TypeError rather than a 400.
 */

module.exports = {
	additionalProperties: false,
	properties: {
		categories: {
			items: { type: 'integer' },
			minItems: 1,
			type: 'array',
		},
		channel: {
			maxLength: 20,
			type: 'string',
		},
		description: { type: ['string', 'null'] },
		image: { type: ['string', 'null'] },
		thumbnail: { type: ['string', 'null'] },
		title: { type: ['string', 'null'] },
		// MESSAGE panels take exactly one category; BUTTON panels take any.
		type: {
			enum: ['MESSAGE', 'BUTTON'],
			type: 'string',
		},
	},
	required: ['categories', 'channel', 'type'],
	type: 'object',
};
