# Request body schemas

JSON Schema for the admin API's write endpoints, validated by fastify's
built-in AJV. The route loader in `src/http.js` spreads whatever a route module
returns into `fastify.route()`, so a `schema` key is all that is needed.

These replaced `settings.js`, which was dead code: a `// TODO` that referenced
an undefined `joi` global behind an `eslint-disable no-undef`, imported
nowhere. Its field list and its `autoClose`/`staleAfter`/`workingHours`
constraints are preserved here.

## Why `additionalProperties: false` matters most

Every one of these endpoints reads `req.body` and spreads it into a Prisma
write. Without a schema, any key an authenticated admin sent reached the
database layer.

fastify configures AJV with `removeAdditional: true`, so
`additionalProperties: false` makes unknown keys **stripped rather than
rejected**. That is deliberate:

- unknown keys cannot reach Prisma, which is the actual fix;
- a client sending an extra field still succeeds, so the dashboard does not
  break if it round-trips a property these schemas do not list. `id` and
  `createdAt` are exactly that case — the routes delete them by hand, and now
  they are simply stripped before the handler runs.

Type and range violations on *known* fields do return 400, with a message
naming the field.

## Keeping these in step with the schema

A field added to a Prisma model and to the dashboard will be silently stripped
until it is listed here. If a setting will not save, that is the first place to
look.

## A coercion trap

fastify also sets `coerceTypes: 'array'`, which turns a bare scalar into a
one-element array when a schema expects one. That makes an `anyOf` of
`[array, enum]` useless on its own: the string is coerced, satisfies the array
branch, and the enum is never consulted. `autoTag` therefore constrains its
items to digits, so only a real list of channel IDs can take that branch.

Anywhere else an array sits beside a scalar in an `anyOf`, the array's items
need to be specific enough that a coerced scalar fails them.
