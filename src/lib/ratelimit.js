/**
 * Request rate limiting for the HTTP server.
 *
 * Irrelevant while the dashboard is only reachable over an SSH tunnel, and a
 * prerequisite once it is public: without it an unauthenticated flood meets no
 * limit at all, on an instance shared with several other bots.
 *
 * It lives here, rather than inline in src/http.js, so that
 * scripts/check-ratelimit.js can exercise the configuration that actually
 * ships instead of a copy of it. The hook order below is the whole point of
 * the file and is easy to get wrong, so it is worth a test.
 */

/**
 * Attach the limiter.
 *
 * Registered with `global: false` and added as an instance-level `onRequest`
 * hook, deliberately. With `global: true` the plugin's hook runs *after* a
 * route's own `onRequest` hooks, which means `fastify.authenticate` answers
 * `401` first and the limiter never counts the request -- so an
 * unauthenticated flood against the API would not have been limited at all,
 * which is the case this exists for. An instance-level hook runs before
 * route-level ones.
 *
 * The cost of that ordering is the key: `req.user` is not populated yet, so
 * requests are counted per client address rather than per user. Administrators
 * behind one address therefore share an allowance, which `HTTP_RATE_LIMIT`
 * exists to raise. `HTTP_TRUST_PROXY` must be true behind a reverse proxy, or
 * every request appears to come from the proxy and shares a single bucket.
 *
 * @param {import('fastify').FastifyInstance} fastify
 */
module.exports.attach = async fastify => {
	await fastify.register(require('@fastify/rate-limit'), { global: false });
	fastify.addHook('onRequest', fastify.rateLimit({
		// `/status` exists to be polled and reveals nothing.
		allowList: req => req.url === '/status',
		keyGenerator: req => req.ip,
		max: module.exports.max(),
		timeWindow: '1 minute',
	}));
};

/**
 * Requests per minute per address.
 *
 * @returns {number}
 */
module.exports.max = () => Number(process.env.HTTP_RATE_LIMIT) || 300;
