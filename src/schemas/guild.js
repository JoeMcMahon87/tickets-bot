/**
 * Body schema for PATCH /api/admin/guilds/:guild/settings.
 *
 * Mirrors the `Guild` model. See README.md in this directory for why
 * `additionalProperties: false` strips rather than rejects.
 */

// Long enough for a snowflake, short enough that a VarChar(19) column cannot
// be overrun. An empty string is allowed: the dashboard sends one to clear a
// channel.
const channelId = {
	maxLength: 20,
	type: ['string', 'null'],
};

const colour = {
	// Validated further in the route itself, which requires hex or a
	// discord.js colour name.
	maxLength: 32,
	type: 'string',
};

module.exports = {
	additionalProperties: false,
	properties: {
		archive: { type: 'boolean' },
		// Enforced by the dashboard as a minimum of one hour; kept here
		// because the previous (unused) schema specified it.
		autoClose: {
			minimum: 3_600_000,
			type: ['integer', 'null'],
		},
		// Either a list of channel IDs or one of three modes.
		//
		// The items must be constrained to digits, not merely to strings:
		// fastify runs AJV with `coerceTypes: 'array'`, so a bare string is
		// coerced into a one-element array and would satisfy the array branch
		// whatever it contained -- making the enum below unreachable and
		// accepting any string at all.
		autoTag: {
			anyOf: [
				{
					items: {
						pattern: '^[0-9]{16,20}$',
						type: 'string',
					},
					type: 'array',
				},
				{
					enum: ['ticket', '!ticket', 'all'],
					type: 'string',
				},
			],
		},
		blocklist: {
			items: {
				maxLength: 20,
				type: 'string',
			},
			type: 'array',
		},
		claimButton: { type: 'boolean' },
		closeButton: { type: 'boolean' },
		errorColour: colour,
		footer: {
			maxLength: 2048,
			type: ['string', 'null'],
		},
		locale: {
			maxLength: 10,
			type: 'string',
		},
		logChannel: channelId,
		moveButton: { type: 'boolean' },
		primaryColour: colour,
		// A minute is the floor the stale-ticket cron can act on; it runs on a
		// 15-minute interval.
		staleAfter: {
			minimum: 60_000,
			type: ['integer', 'null'],
		},
		successColour: colour,
		// A timezone followed by one open/close pair per weekday.
		workingHours: {
			maxItems: 8,
			minItems: 8,
			type: 'array',
		},
	},
	type: 'object',
};
