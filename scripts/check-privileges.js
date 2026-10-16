/* eslint-disable no-console */
/**
 * Checks who the dashboard treats as an administrator.
 *
 * `getPrivilegeLevel` is what `fastify.isAdmin` gates on (it requires >= 2),
 * so these are the rules that decide who can change the bot's settings over
 * HTTP. Two of them are easy to get wrong by accident and worth pinning:
 *
 *  - `SUPER` is expected to be empty, because `ManageGuild` is the admin
 *    threshold. Anything in it outranks a guild owner in every guild.
 *  - a role *named* "admin" grants level 2. The match must stay exact, or
 *    "Administrator" and "non-admin" would qualify.
 *  - session cookies must be `Secure` over HTTPS and not over the tunnel.
 *    Both failures are silent: without it the cookie crosses the internet in
 *    the clear, and with it hardcoded the tunnel cannot log in at all.
 *
 * No test framework, matching the other check-*.js scripts. `isStaff` is
 * stubbed where a case would otherwise fall through to it, since the real one
 * reaches for keyv and prisma.
 */

const assert = require('assert');
const { join } = require('path');

const users = require(join(__dirname, '../src/lib/users'));
const { useSecureCookies } = require(join(__dirname, '../src/lib/misc'));
const {
	ADMIN_ROLE_NAME, hasAdminRole, getPrivilegeLevel,
} = users;

let pass = 0;
const ok = name => {
	console.log('  ok   ' + name);
	pass++;
};

/** A GuildMember stub with only what getPrivilegeLevel touches. */
const member = ({
	id = '1',
	ownerId = 'owner',
	manageGuild = false,
	roles = [],
	supers = [],
} = {}) => ({
	guild: {
		client: { supers },
		ownerId,
	},
	id,
	permissions: { has: () => manageGuild },
	roles: { cache: roles.map(name => ({ name })) },
});

async function main() {
	// ── the role-name rule ───────────────────────────────────────────────────────
	assert.strictEqual(ADMIN_ROLE_NAME, 'admin');

	assert.strictEqual(hasAdminRole(member({ roles: ['admin'] })), true);
	assert.strictEqual(hasAdminRole(member({ roles: ['Admin'] })), true);
	assert.strictEqual(hasAdminRole(member({ roles: ['ADMIN'] })), true);
	assert.strictEqual(hasAdminRole(member({ roles: ['  admin  '] })), true);
	ok('a role named "admin" matches whatever its case or surrounding space');

	assert.strictEqual(hasAdminRole(member({ roles: ['Administrator'] })), false);
	assert.strictEqual(hasAdminRole(member({ roles: ['admin-helper'] })), false);
	assert.strictEqual(hasAdminRole(member({ roles: ['non-admin'] })), false);
	assert.strictEqual(hasAdminRole(member({ roles: ['server admin'] })), false);
	ok('the match is exact, so lookalike role names do not grant admin');

	assert.strictEqual(hasAdminRole(member({ roles: [] })), false);
	assert.strictEqual(hasAdminRole(member({ roles: ['Moderator', 'Member'] })), false);
	ok('no roles, or unrelated roles, is not admin');

	// ── the levels isAdmin depends on ────────────────────────────────────────────
	assert.strictEqual(await getPrivilegeLevel(null), -1);
	ok('a non-member is -1');

	assert.strictEqual(await getPrivilegeLevel(member({
		id: 'owner',
		ownerId: 'owner',
	})), 3);
	ok('the guild owner is 3');

	assert.strictEqual(await getPrivilegeLevel(member({ manageGuild: true })), 2);
	ok('ManageGuild is 2, the admin threshold');

	assert.strictEqual(await getPrivilegeLevel(member({ roles: ['Admin'] })), 2);
	ok('a role named "admin" is also 2, so it can administer the dashboard');

	// A lookalike role must not reach 2. It falls through to isStaff, which the
	// real implementation would take to keyv and prisma.
	const realIsStaff = users.isStaff;
	users.isStaff = async () => false;
	try {
		assert.strictEqual(await getPrivilegeLevel(member({ roles: ['Administrator'] })), 0);
		ok('a lookalike role is 0, not 2');

		assert.strictEqual(await getPrivilegeLevel(member({ roles: ['Member'] })), 0);
		ok('an ordinary member is 0');

		users.isStaff = async () => true;
		assert.strictEqual(await getPrivilegeLevel(member({ roles: ['Support'] })), 1);
		ok('a category staff role is 1, which isAdmin still refuses');
	} finally {
		users.isStaff = realIsStaff;
	}

	// ── SUPER ────────────────────────────────────────────────────────────────────
	assert.strictEqual(await getPrivilegeLevel(member({
		id: 'x',
		supers: ['x'],
	})), 4);
	ok('SUPER is 4, above the guild owner -- which is why it stays empty');

	// The parsing in src/client.js, restated: empty must mean nobody, and a
	// spaced list must not silently drop entries.
	const parse = v => (v ?? '')
		.split(',')
		.map(id => id.trim())
		.filter(id => id.length > 0);

	assert.deepStrictEqual(parse(undefined), []);
	assert.deepStrictEqual(parse(''), []);
	ok('an unset or empty SUPER grants nobody level 4');

	assert.deepStrictEqual(parse('111,222'), ['111', '222']);
	assert.deepStrictEqual(parse('111, 222'), ['111', '222']);
	assert.deepStrictEqual(parse(' 111 , 222 ,'), ['111', '222']);
	ok('a spaced or trailing-comma list parses without inert entries');

	// ── SUPER's env validation ───────────────────────────────────────────────────
	// src/env.js is a module-level side effect on require, so the rule is
	// restated rather than imported.
	const validate = v => !v || v.split(',').every(id => /^\d{17,20}$/.test(id.trim()));

	assert.strictEqual(validate(''), true);
	assert.strictEqual(validate(undefined), true);
	assert.strictEqual(validate('319467558166069248'), true);
	assert.strictEqual(validate('319467558166069248, 319467558166069249'), true);
	ok('empty, or a list of snowflakes, validates');

	assert.strictEqual(validate('not-an-id'), false);
	assert.strictEqual(validate('123'), false);
	assert.strictEqual(validate('319467558166069248,nope'), false);
	ok('a typo fails startup rather than becoming an ID that never matches');

	// ── the cookie Secure attribute ──────────────────────────────────
	const withExternal = v => {
		const before = process.env.HTTP_EXTERNAL;
		process.env.HTTP_EXTERNAL = v;
		try {
			return useSecureCookies();
		} finally {
			if (before === undefined) delete process.env.HTTP_EXTERNAL;
			else process.env.HTTP_EXTERNAL = before;
		}
	};

	assert.strictEqual(withExternal('https://tickets.example.com'), true);
	ok('cookies are Secure when the dashboard is served over HTTPS');

	assert.strictEqual(withExternal('http://localhost:8169'), false);
	assert.strictEqual(withExternal('http://127.0.0.1:8169'), false);
	ok('cookies are not Secure over the tunnel, which could not send them');

	// A Secure cookie is never sent over plain HTTP, so a hostname that merely
	// resembles https must not be enough to set it.
	assert.strictEqual(withExternal('http://https.example.com'), false);
	assert.strictEqual(withExternal(''), false);
	assert.strictEqual(withExternal(undefined), false);
	ok('only an https:// scheme counts, not a hostname that resembles one');

	console.log(`\n[check-privileges] ${pass} checks passed`);
}

main().catch(error => {
	console.error('\n[check-privileges] FAILED:', error.message);
	process.exit(1);
});
