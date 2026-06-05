---
name: mock-fast
description: Use this skill whenever the user asks to build, add, modify, scaffold or initialize an HTTP mock server using mock-fast — including writing the `mock-fast.json` DSL, nesting routes, declaring extensions (`requireAuth`, `errorRate`, `delayRange`, `rateLimit`), using Handlebars templating with Faker / params / query / body / token, conditional `responses[]` with `when` clauses to return different payloads per request, configuring auth header and pattern, hot reload behavior, the admin API on port 3110, and the programmatic `createMockFast()` entry. Triggers on prompts like "create a mock with mock-fast", "add a protected endpoint", "mock a login with rate limit", "simulate flaky API", "add latency to this route", "edit mock-fast.json", "return different responses based on body".
---

# mock-fast — DSL guide

> **Skill version:** `0.0.0-dev` — should match the installed `@killki/mock-fast`. See [Staying in sync](#staying-in-sync-with-the-installed-library).

`mock-fast` is a zero-config HTTP mock server with a small declarative JSON DSL. It wraps [@mocks-server/main](https://www.mocks-server.org) and adds nested routes with inheritance, a pipeline of extensions, and Handlebars templating with Faker.

Package: `@killki/mock-fast` (CLI bin: `mock-fast`). CLI: `mock-fast start`. Programmatic: `import { createMockFast } from "@killki/mock-fast"`.

## How to run

```bash
npx mock-fast start
```

With no flags it looks for, in order: `mock-fast.json`, `mocks.json`, `mock.json` in the current directory. Defaults: port `3001`, host `127.0.0.1`, CORS enabled, hot reload enabled, admin API on `3110`.

Flags: `--file <path>`, `--port <n>`, `--host <h>`, `--admin-port <n>`, `--no-watch`.

## Top-level DSL shape

```json
{
  "server":  { "port": 3001, "host": "127.0.0.1", "cors": true, "adminPort": 3110 },
  "auth":    { "headerName": "Authorization", "pattern": "^Bearer [A-Za-z0-9._-]+$" },
  "routes":  [ /* route tree */ ]
}
```

All three top-level fields are optional except `routes`. Defaults apply otherwise.

## Route node

Every node in `routes[]` (and inside `routes[].routes[]`) follows the same shape:

```json
{
  "id":       "string",                       // optional, auto-derived from method+url
  "url":      "string",                       // required, joined with parent url
  "method":   "get|post|put|patch|delete|options|head",  // default "get"
  "headers":  { "X-Header": "value" },        // optional, merged with parent
  "extensions": { /* see below */ },           // optional, merged with parent
  "filter":   { "in": "data", "fields": [...], "by": "body.q" }, // optional, search a list
  "filters":  [ /* several filters, AND */ ],   // optional
  "paginate": { "of": "data", "page": "body.page", "size": "body.pageSize" }, // optional
  "response": { "status": 200, "headers": {}, "body": ... },     // single response
  "responses": [ { "when": {...}, "status": ..., "body": ... } ], // conditional set (XOR with response)
  "routes":   [ /* nested children */ ]
}
```

**Three truths to remember:**

- `url` always concatenates with parent (`/` separators normalized).
- `response` AND `responses` are **mutually exclusive** — pick one. Schema rejects both.
- `response` / `responses` BOTH absent => the node is a **pure namespace** (no endpoint registered, only inherits to children).

## Inheritance rules

| Field | Inherits? | Combine rule |
|---|---|---|
| `url` | yes | concat with `/` |
| `extensions` | yes | shallow merge (child overrides per key) |
| `headers` | yes | merge (child wins on collision) |
| `method` | no | default `get` per node |
| `response` / `responses` | no | each node has its own |

## Conditional responses (`responses[]` + `when`)

Use `responses[]` instead of `response` when the same endpoint must return different payloads depending on what the client sent (DNI lookups, feature flags, "happy path vs. error case" mocks, etc.).

```json
{
  "id": "verify",
  "url": "/identity/verify",
  "method": "post",
  "responses": [
    { "when": { "body.dni": "12345673" }, "status": 200, "body": { "kind": "ok",       "name": "Renato" } },
    { "when": { "body.dni": "12345674" }, "status": 200, "body": { "kind": "ok",       "name": "Juan" } },
    { "when": { "body.dni": "00000000" }, "status": 422, "body": { "kind": "blocked" } },
    {                                     "status": 200, "body": { "kind": "fallback", "dni": "{{body.dni}}" } }
  ]
}
```

**Selection rules:**

1. Walk `responses[]` in order. Return the **first** entry whose `when` matches.
2. A response **without** `when` always matches — put it last as fallback.
3. If every entry has a `when` and none match → **404** `{ "error": "No response matched", "route": "...", "method": "...", "url": "..." }`.

**`when` clauses:**

- Keys are dotted paths into the same context the templating uses: `body.X`, `query.X`, `headers.X` (lowercase!), `params.X`, `token.X`. Arbitrary depth, including numeric indices (`body.items.0.id`).
- Values are primitives only in v1: `string`, `number`, `boolean`, `null`. Schema rejects object values.
- Comparison is **equality with string coercion**: `"12345673"` matches the number `12345673`.
- `null` matches `null` OR `undefined` (missing field).
- If actual value is an array, matches when ANY element equals the expected primitive.
- Multiple keys in a single `when` are **AND**. For OR, declare separate responses.
- **No templating** in matcher values. They are literal.

**Constraints / rejections at schema time:**

- `response` + `responses` in the same node → error.
- `responses: []` (empty) → error.
- `when: { "x": { "gt": 100 } }` → error (operators not in v1).

To **disable** an inherited extension in a child, set it explicitly:

```json
"extensions": { "requireAuth": false }
```

## Filtering a list (`filter`)

When the request carries a **search term** and the endpoint must return only matching items (real filtering over a dataset, not a fixed payload), add an optional `filter` to the route node. The response body is written normally with the **full** list; `filter` trims the array before sending.

```json
{
  "url": "/anexos",
  "method": "post",
  "filter": { "in": "data", "fields": ["titulo", "descripcion"], "by": "body.filtro" },
  "response": { "status": 200, "body": { "data": [ /* full list */ ] } }
}
```

`{ "filtro": "nex" }` → only items whose `titulo` OR `descripcion` contain `nex` (case-insensitive). Empty/missing term → full list.

| Field | Meaning |
|---|---|
| `in` | dotted path to the array in the body (`data`, `result.items`) |
| `fields` | item fields to search; matches if **any** matches |
| `by` | dotted path to the search term (`body.filtro`, `query.q`) |
| `op` | `contains` (default) \| `equals` \| `startsWith` |
| `caseSensitive` | default `false` |

- **Opt-in and non-breaking**: routes without `filter` behave exactly as before.
- Runs **after** templating; works alongside `response` or `responses` (filters the chosen body).
- If `in` isn't an array, the body is sent untouched.

### Several filters (AND) + pagination

For a real listing — several optional filters (sede AND oficina AND estado) plus pagination — use `filters` (array, AND between them) and `paginate`. A filter whose term is empty/missing is **skipped**, so optional params just don't filter.

```json
{
  "url": "/ubicaciones",
  "method": "post",
  "filters": [
    { "in": "data", "fields": ["codigoSede"],    "by": "body.codigoSede",    "op": "equals" },
    { "in": "data", "fields": ["codigoOficina"], "by": "body.codigoOficina", "op": "equals" },
    { "in": "data", "fields": ["codigoEstado"],  "by": "body.codigoEstado",  "op": "equals" }
  ],
  "paginate": { "of": "data", "page": "body.page", "size": "body.pageSize", "total": "totalRegistros" },
  "response": { "status": 200, "body": { "data": [ /* full list */ ], "totalRegistros": 0 } }
}
```

`paginate`: `of` (array path), `page` (1-based, dotted path; missing→1), `size` (dotted path), `defaultSize` (when size missing, default 20), `total` (optional body path to write the count **before** paging).

Order of transforms: `filter` → `filters` (AND) → `paginate`. All opt-in.

## Extensions

Run order per request: `requireAuth` → `rateLimit` → `errorRate` → `delayRange` → respond. Any extension that short-circuits (writes 401 / 429 / 500) skips the rest and the normal response.

### `requireAuth: boolean`

Checks `auth.headerName` against `auth.pattern`. Fails => 401 `{"error":"Unauthorized","message":"Missing or invalid '...' header"}`.

```json
{ "url": "/api/admin", "extensions": { "requireAuth": true }, "response": { ... } }
```

### `errorRate: number` (0..1)

Per-request dice roll. Probability `errorRate` returns 500 with body `{"error":"Injected error","message":"errorRate=... triggered","route":"<id>"}`.

```json
"extensions": { "errorRate": 0.10 }
```

### `delayRange: [min, max]`

Uniform random latency in milliseconds, `min <= max`. Both integers >= 0.

```json
"extensions": { "delayRange": [200, 1500] }
```

### `rateLimit`

Counts requests per identifier, cuts off above `max`.

```json
"extensions": {
  "rateLimit": {
    "identifier": "{{token.sub}}",
    "window": "1m",
    "max": 100,
    "perUser": { "user-vip": 1000, "user-locked": 0 },
    "onLimit": { "status": 429, "body": { "error": "..." } }
  }
}
```

| Field | Default | Accepts |
|---|---|---|
| `identifier` | `req.ip` | Handlebars expression: `{{body.X}}`, `{{headers.X}}`, `{{token.X}}`, `{{params.X}}` |
| `window` | `"1m"` | `"1m"`, `"5m"`, `"1h"`, `"session"`, `"on-success"` |
| `max` | required | integer >= 0 |
| `perUser` | `{}` | map `identifier => max` (override) |
| `onLimit` | `{ status: 429 }` | full response object |

Windows:

- `"1m"` / `"5m"` / `"1h"`: sliding time window.
- `"session"`: never resets until server restart.
- `"on-success"`: counter clears when this route responds with 2xx. Models **login lockout** (N failed attempts before a successful one).

`perUser: { "<id>": 0 }` is the simple way to model "this user is permanently locked".

## Templating

Every string in `response.body`, `response.headers`, top-level `headers`, and the `rateLimit.identifier` field passes through Handlebars before being sent.

Variables in scope:

| Name | Source |
|---|---|
| `{{params.X}}` | Express path params (`/users/:id` => `params.id`) |
| `{{query.X}}` | Querystring |
| `{{body.X}}` | Parsed request body (JSON / urlencoded) |
| `{{headers.X}}` | Request headers (lowercase keys, Express convention) |
| `{{token.X}}` | JWT payload decoded from the auth header. **No signature verification** — it's a mock. |

Helpers:

| Helper | Use |
|---|---|
| `{{faker 'category.method' arg1 arg2}}` | Any @faker-js/faker method. Examples: `{{faker 'person.firstName'}}`, `{{faker 'internet.email'}}`, `{{faker 'number.int' min=1 max=100}}`. |
| `{{randomInt min max}}` | Integer in `[min, max]`. |
| `{{uuid}}` | UUID v4. |
| `{{now}}` | ISO timestamp at request time. |

**Important:** Templating runs **per-request**. Each call sees fresh values. There is no compile-time substitution.

## Complete examples

### Health check + protected nested API

```json
{
  "routes": [
    {
      "id": "health",
      "url": "/health",
      "response": { "status": 200, "body": { "ok": true, "ts": "{{now}}" } }
    },
    {
      "url": "/api",
      "routes": [
        {
          "url": "/protegida",
          "extensions": { "requireAuth": true, "errorRate": 0.05, "delayRange": [100, 400] },
          "response": { "status": 200, "body": { "data": "root" } },
          "routes": [
            {
              "id": "users-list",
              "url": "/usuarios",
              "response": {
                "status": 200,
                "body": {
                  "users": [
                    { "id": 1, "name": "{{faker 'person.firstName'}}" },
                    { "id": 2, "name": "{{faker 'person.firstName'}}" }
                  ]
                }
              }
            },
            {
              "id": "users-byId",
              "url": "/usuarios/:id",
              "response": {
                "status": 200,
                "body": {
                  "id": "{{params.id}}",
                  "name": "{{faker 'person.fullName'}}",
                  "tokenSub": "{{token.sub}}"
                }
              }
            }
          ]
        }
      ]
    }
  ]
}
```

### Login with on-success lockout

```json
{
  "id": "login",
  "url": "/api/login",
  "method": "post",
  "extensions": {
    "rateLimit": {
      "identifier": "{{body.username}}",
      "window": "on-success",
      "max": 3,
      "onLimit": { "status": 423, "body": { "error": "Account temporarily locked" } }
    }
  },
  "response": {
    "status": 200,
    "body": { "token": "Bearer mock.{{uuid}}", "user": "{{body.username}}" }
  }
}
```

This locks the username after 3 attempts that did NOT succeed. With a 200-only mock, on-success effectively resets every call — combine with `errorRate` or a conditional response to actually exercise the lockout.

### Per-user rate limit by JWT subject

```json
{
  "id": "premium",
  "url": "/api/premium",
  "extensions": {
    "requireAuth": true,
    "rateLimit": {
      "identifier": "{{token.sub}}",
      "window": "1h",
      "max": 10,
      "perUser": { "user-vip": 10000, "user-banned": 0 }
    }
  },
  "response": { "status": 200, "body": { "tier": "ok" } }
}
```

### Disable an inherited extension in a child

```json
{
  "url": "/api",
  "extensions": { "requireAuth": true },
  "routes": [
    {
      "id": "public-pricing",
      "url": "/pricing",
      "extensions": { "requireAuth": false },
      "response": { "status": 200, "body": { "free": 0 } }
    }
  ]
}
```

## Programmatic API

```ts
import { createMockFast } from "@killki/mock-fast";

const server = await createMockFast({
  file:       "./fixtures/mock.json",  // default: mock-fast.json | mocks.json | mock.json
  port:       3001,
  host:       "127.0.0.1",
  adminPort:  3110,
  watch:      true,
  silent:     false,
});

await server.start();
// ... tests ...
await server.reload();   // re-read DSL file
await server.stop();
```

Returns `{ start, stop, reload, url(), adminUrl() }`.

## Choosing values — heuristics

- **Auth pattern**: keep the default `^Bearer [A-Za-z0-9._-]+$` unless the API uses a non-JWT scheme (e.g., session token `^sk-.+`, custom prefix). Then change `auth.pattern` once at the top.
- **`errorRate`**: 0.05–0.15 is realistic for testing retries. Above 0.5 makes the API mostly broken (useful only for chaos drills).
- **`delayRange`**: real-world APIs sit between `[80, 400]` ms healthy and `[1500, 5000]` ms degraded. Pick the regime that matches what you want to test.
- **`rateLimit.identifier`**: prefer `{{token.sub}}` when the route is auth'd, `{{body.username}}` for login-style routes, `{{headers.x-api-key}}` for partner APIs. `req.ip` (default) is rarely what tests want.
- **`window` choice**:
  - Sliding time window (`1m`/`5m`/`1h`): generic rate limiting.
  - `session`: simple cap that survives requests but resets on restart.
  - `on-success`: account lockout semantics.

## Common pitfalls

- **Forgetting that `response` absence means "no endpoint"**: if you want the parent to also respond, add its own `response` (or `responses`).
- **Putting `extensions` inside `response`**: extensions live on the route node, not the response.
- **Mixing `response` and `responses`**: pick one. Schema rejects nodes that declare both.
- **Forgetting the fallback in `responses[]`**: if every entry has a `when` and none matches, the client gets a 404, not your "default" payload. Add a trailing entry without `when`.
- **Casing in header matchers**: use lowercase keys (`headers.x-api-key`), Express normalizes incoming headers that way.
- **Trying operators in `when` (v1)**: `{ "body.amount": { "gt": 100 } }` is rejected at load time. Use a list of explicit equalities until operators ship.
- **Expecting `delayRange` per-call**: it IS per-request — picks a fresh value each time.
- **Calling JWT decode "verification"**: it isn't. mock-fast splits the token, base64-decodes the payload, exposes it. Any well-formed JWT works; signatures are ignored.
- **Expecting `on-success` lockout to fire on a route that always returns 200**: it won't, because every call counts as success and resets the counter. Combine with `errorRate` or a route that can fail.
- **Forgetting `Content-Type` in POST requests**: if the body isn't JSON-decoded, `{{body.X}}` returns empty. Send `Content-Type: application/json`.
- **Adding extensions on a grouping-only node**: extensions on a node without `response` ARE inherited by children — that's exactly the use case for "protect a whole subtree". The grouping node itself just doesn't have its own endpoint.
- **Path collisions**: two routes resolving to the same `method` + `url` are ambiguous. Give them distinct paths or methods.

## Implementation checklist

1. Does the file live at the project root as `mock-fast.json` (or one of `mocks.json` / `mock.json`)?
2. Is `routes` an array, even with one route?
3. For nested routes: are child URLs **relative** to the parent (no full prefix repetition)?
4. For protected subtrees: is `extensions.requireAuth` set on the **parent**, not duplicated on each child?
5. For templating: any string referencing `{{params.X}}`, `{{body.X}}`, `{{token.X}}` — make sure the request actually sends that field, otherwise the value renders empty.
6. For `rateLimit`: did you choose `identifier` deliberately? Default is `req.ip` which is rarely meaningful in tests.
7. For `on-success` rate limit: does the route have a realistic path to fail (errorRate or a route that can 4xx)?
8. For body parsing: does the request set `Content-Type: application/json` if you templated from `body.X`?

## Staying in sync with the installed library

This skill is **versioned to match** `@killki/mock-fast` (see **Skill version** at the top). A skill file is a *copy* in the project, so it can fall behind the installed package after an upgrade. When you use this skill, do a quick, **soft** check:

1. Read the installed version from `node_modules/@killki/mock-fast/package.json` (or `npm ls @killki/mock-fast`).
2. Compare it to this file's **Skill version**.
3. If the library is **newer**, tell the user the skill copy is outdated and suggest refreshing it — copy `node_modules/@killki/mock-fast/dist/mock-fast/SKILL.md` over the project's `mock-fast` skill file (e.g. `.claude/skills/mock-fast/SKILL.md`).

It's a one-time suggestion, never a blocker. If the version reads `0.0.0-dev`, this is an unbuilt source copy — ignore the check.
