/**
 * Body schemas for the tag endpoints. Mirrors the `Tag` model.
 *
 * `guildId` is deliberately absent: the create route connects the guild from
 * the URL, so accepting one in the body would let an admin of one guild write
 * a tag into another.
 */

const properties = {
	content: {
		maxLength: 4096,
		type: 'string',
	},
	name: {
		maxLength: 32,
		type: 'string',
	},
	regex: {
		maxLength: 512,
		type: ['string', 'null'],
	},
};

module.exports = {
	create: {
		additionalProperties: false,
		properties,
		required: ['content', 'name'],
		type: 'object',
	},
	patch: {
		additionalProperties: false,
		properties,
		type: 'object',
	},
};
