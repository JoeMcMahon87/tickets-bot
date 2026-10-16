/* eslint-disable no-console */
/**
 * Checks src/lib/ratelimit.js, the HTTP request limiter.
 *
 * It exists because the obvious configuration does not work. Registering
 * @fastify/rate-limit with `global: true` puts its hook *after* a route's own
 * `onRequest` hooks, so `fastify.authenticate` answers 401 first and the
 * limiter never counts the request -- leaving an unauthenticated flood against
 * the API entirely unlimited, which is the one case the limiter is for. That
 * failure is invisible in any test that only hits an unauthenticated route.
 *
 * So the case below that matters most is the authenticated one: six
 * unauthenticated requests to a route whose `onRequest` rejects them must
 * still be limited.
 *
 * No test framework, matching the other check-*.js scripts. The real
 * `attach()` is used, so this exercises what ships.
 */

const assert = require('assert');
const { join } = require('path');

const ratelimit = require(join(__dirname, '../src/lib/ratelimit'));

let pass = 0;
const ok = name => {
	console.log('  ok   ' + name);
	pass++;
};

/** A server wired exactly as src/http.js wires it. */
const server = async () => {
	const fastify = require('fastify')({ trustProxy: true });
	await ratelimit.attach(fastify);
	// mimics fastify.authenticate refusing an unauthenticated caller
	fastify.get('/api/thing', { onRequest: async (req, res) => res.code(401).send({ statusCode: 401 }) }, async () => 'ok');
	fastify.get('/open', async () => 'ok');
	fastify.get('/status', async () => 'ok');
	return fastify;
};

const codes = async (fastify, url, n) => {
	const out = [];
	for (let i = 0; i < n; i++) {
		out.push((await fastify.inject({
			method: 'GET',
			url,
		})).statusCode);
	}
	return out;
};

async function main() {
	// ── the limit is configurable, and has a default ─────────────────────────────
	const realLimit = process.env.HTTP_RATE_LIMIT;
	delete process.env.HTTP_RATE_LIMIT;
	assert.strictEqual(ratelimit.max(), 300);
	process.env.HTTP_RATE_LIMIT = '';
	assert.strictEqual(ratelimit.max(), 300);
	process.env.HTTP_RATE_LIMIT = '3';
	assert.strictEqual(ratelimit.max(), 3);
	ok('HTTP_RATE_LIMIT sets the limit, and defaults to 300 when unset or empty');

	try {
		// ── the case the hook order exists for ───────────────────────────────────────
		// With `global: true` these would all be 401 and never limited.
		let fastify = await server();
		let seen = await codes(fastify, '/api/thing', 6);
		assert.ok(
			seen.includes(429),
			`unauthenticated flood was not limited: ${seen.join(',')}`,
		);
		assert.deepStrictEqual(seen, [401, 401, 401, 429, 429, 429]);
		ok('a flood against an authenticated route is limited, not just 401ed');

		// ── an ordinary route ────────────────────────────────────────────────────────
		fastify = await server();
		seen = await codes(fastify, '/open', 5);
		assert.deepStrictEqual(seen, [200, 200, 200, 429, 429]);
		ok('an unauthenticated route is limited after the allowance');

		// ── /status is exempt ────────────────────────────────────────────────────────
		fastify = await server();
		seen = await codes(fastify, '/status', 6);
		assert.deepStrictEqual(seen, [200, 200, 200, 200, 200, 200]);
		ok('/status is exempt, so health polling cannot lock itself out');

		// ── the refusal is well formed ───────────────────────────────────────────────
		fastify = await server();
		await codes(fastify, '/open', 3);
		const limited = await fastify.inject({
			method: 'GET',
			url: '/open',
		});
		assert.strictEqual(limited.statusCode, 429);
		assert.ok(limited.headers['retry-after'], 'no retry-after header');
		assert.strictEqual(JSON.parse(limited.body).error, 'Too Many Requests');
		ok('a limited request gets 429, a retry-after header and a JSON body');
	} finally {
		if (realLimit === undefined) delete process.env.HTTP_RATE_LIMIT;
		else process.env.HTTP_RATE_LIMIT = realLimit;
	}

	console.log(`\n[check-ratelimit] ${pass} checks passed`);
}

main().catch(error => {
	console.error('\n[check-ratelimit] FAILED:', error.message);
	process.exit(1);
});
