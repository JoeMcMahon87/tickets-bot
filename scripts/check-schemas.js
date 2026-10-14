/* eslint-disable no-console */
/**
 * Checks the admin API body schemas by running them through a real fastify
 * instance, which is the only way to see what AJV actually does with them.
 *
 * The behaviour that matters is not "invalid input is rejected" but the split:
 * unknown keys are *stripped* (so they cannot reach a Prisma spread) while
 * bad types and ranges on known keys are *rejected* (so a client is told).
 * Those come from fastify's `removeAdditional: true` plus
 * `additionalProperties: false`, and a change to either would quietly undo
 * the fix — hence checking it rather than assuming it.
 */

const assert = require('assert');
const { join } = require('path');
const Fastify = require('fastify');

const guildSchema = require(join(__dirname, '../src/schemas/guild.js'));
const categorySchema = require(join(__dirname, '../src/schemas/category.js'));
const tagSchema = require(join(__dirname, '../src/schemas/tag.js'));
const panelSchema = require(join(__dirname, '../src/schemas/panel.js'));

let pass = 0;
const ok = name => {
	console.log('  ok   ' + name);
	pass++;
};

/** Post a body at a schema and report what the handler would have received. */
async function submit(schema, body) {
	const app = Fastify();
	app.route({
		handler: async req => ({ body: req.body }),
		method: 'POST',
		schema: { body: schema },
		url: '/',
	});
	const res = await app.inject({
		method: 'POST',
		payload: body,
		url: '/',
	});
	await app.close();
	return {
		body: res.statusCode === 200 ? res.json().body : null,
		message: res.statusCode === 400 ? res.json().message : null,
		status: res.statusCode,
	};
}

async function main() {
	// ── the core protection ─────────────────────────────────────────────────
	// Anything not named in the schema must not survive to the handler, which
	// is what stops it reaching `prisma.guild.update({ data })`.
	let result = await submit(guildSchema, {
		archive: false,
		'data; DROP TABLE': 1,
		id: '999',
		tickets: { deleteMany: {} },
	});
	assert.strictEqual(result.status, 200);
	assert.deepStrictEqual(result.body, { archive: false });
	ok('unknown keys are stripped before the handler, not passed through');

	// Including the two the routes delete by hand; they are simply gone now.
	result = await submit(guildSchema, {
		createdAt: '2020-01-01',
		id: '123',
	});
	assert.deepStrictEqual(result.body, {});
	ok('id and createdAt are stripped, so the hand-written deletes are moot');

	// ── rejection, for known fields ─────────────────────────────────────────
	result = await submit(guildSchema, { archive: 'yes' });
	assert.strictEqual(result.status, 400);
	assert.match(result.message, /archive/);
	ok('a wrong type on a known field is rejected, naming the field');

	// Constraints carried over from the dead joi schema.
	assert.strictEqual((await submit(guildSchema, { autoClose: 1000 })).status, 400);
	assert.strictEqual((await submit(guildSchema, { autoClose: 3_600_000 })).status, 200);
	assert.strictEqual((await submit(guildSchema, { staleAfter: 100 })).status, 400);
	assert.strictEqual((await submit(guildSchema, { staleAfter: 60_000 })).status, 200);
	ok('autoClose and staleAfter minimums are enforced');

	assert.strictEqual((await submit(guildSchema, { workingHours: [1, 2, 3] })).status, 400);
	assert.strictEqual(
		(await submit(guildSchema, { workingHours: ['UTC', [], [], [], [], [], [], []] })).status,
		200,
	);
	ok('workingHours must have exactly eight entries');

	// autoTag is a list of channels or one of three modes.
	assert.strictEqual((await submit(guildSchema, { autoTag: 'all' })).status, 200);
	assert.strictEqual(
		(await submit(guildSchema, { autoTag: ['123456789012345678'] })).status,
		200,
	);
	assert.strictEqual((await submit(guildSchema, { autoTag: 'everything' })).status, 400);
	// Not a channel ID, so it cannot slip through the array branch either.
	assert.strictEqual((await submit(guildSchema, { autoTag: ['everything'] })).status, 400);
	ok('autoTag accepts a list of channel IDs or a known mode, nothing else');

	// ── clearing a value has to keep working ────────────────────────────────
	// The dashboard clears a channel with an empty string and a footer with
	// null; rejecting either would break saving.
	assert.strictEqual((await submit(guildSchema, { logChannel: '' })).status, 200);
	assert.strictEqual((await submit(guildSchema, { logChannel: null })).status, 200);
	assert.strictEqual((await submit(guildSchema, { footer: null })).status, 200);
	assert.strictEqual((await submit(guildSchema, { staleAfter: null })).status, 200);
	ok('empty strings and nulls are accepted where a value can be cleared');

	// But not a value too long for the column behind it.
	assert.strictEqual((await submit(guildSchema, { logChannel: '1'.repeat(64) })).status, 400);
	ok('an over-long channel ID is refused rather than truncated by the database');

	// ── categories ──────────────────────────────────────────────────────────
	result = await submit(categorySchema.patch, {
		guildId: '000000000000000000',
		name: 'Support',
		transcriptChannel: '123456789012345678',
	});
	// guildId is not in the schema: an admin of one guild must not be able to
	// move a category into another by sending one.
	assert.deepStrictEqual(result.body, {
		name: 'Support',
		transcriptChannel: '123456789012345678',
	});
	ok('a category cannot be reassigned to another guild through the body');

	assert.strictEqual((await submit(categorySchema.create, { description: 'x' })).status, 400);
	assert.strictEqual((await submit(categorySchema.create, { name: 'Support' })).status, 200);
	ok('creating a category requires a name');

	// The nested questions array is upserted, so it is validated too.
	assert.strictEqual(
		(await submit(categorySchema.patch, { questions: [{ type: 'CHECKBOX' }] })).status,
		400,
	);
	result = await submit(categorySchema.patch, {
		questions: [{
			label: 'Why?',
			sneaky: true,
			type: 'TEXT',
		}],
	});
	assert.strictEqual(result.status, 200);
	assert.deepStrictEqual(result.body.questions, [{
		label: 'Why?',
		type: 'TEXT',
	}]);
	ok('nested questions are validated and stripped, not just the top level');

	// ── tags ────────────────────────────────────────────────────────────────
	result = await submit(tagSchema.create, {
		content: 'Hello',
		guildId: '000000000000000000',
		name: 'hi',
	});
	assert.deepStrictEqual(result.body, {
		content: 'Hello',
		name: 'hi',
	});
	ok('a tag cannot be written into another guild through the body');

	assert.strictEqual((await submit(tagSchema.create, { name: 'hi' })).status, 400);
	assert.strictEqual((await submit(tagSchema.patch, { name: 'hi' })).status, 200);
	ok('tag content is required on create but not on patch');

	// ── panels ──────────────────────────────────────────────────────────────
	// The handler calls data.categories.map and branches on data.type, so a
	// missing or mistyped field used to be a 500 from a TypeError.
	assert.strictEqual((await submit(panelSchema, { type: 'MESSAGE' })).status, 400);
	assert.strictEqual((await submit(panelSchema, {
		categories: [],
		channel: '1',
		type: 'MESSAGE',
	})).status, 400);
	assert.strictEqual((await submit(panelSchema, {
		categories: [1],
		channel: '123456789012345678',
		type: 'BUTTON',
	})).status, 200);
	assert.strictEqual((await submit(panelSchema, {
		categories: [1],
		channel: '1',
		type: 'CAROUSEL',
	})).status, 400);
	ok('a panel needs categories, a channel and a known type');

	console.log(`\n[check-schemas] ${pass} checks passed`);
}

main().catch(error => {
	console.error('\n[check-schemas] FAILED:', error.message);
	process.exit(1);
});
