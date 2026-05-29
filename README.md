# mock-fast

Declarative mock server with a small, scalable JSON DSL. One command to start, nested-route inheritance, inherited authentication, random errors, variable latency, per-user rate limiting, Faker-powered templating, hot reload.

mock-fast doesn't reinvent the engine: it builds on [@mocks-server/main](https://www.mocks-server.org) and adds a more concise DSL, route inheritance, and an extension pipeline you grow with a single file.

> 📦 **Ships with AI skills.** After installing, you'll find two Agent Skills under your install folder (`node_modules/@killki/mock-fast/dist/`) — `mock-fast` (DSL reference) and `mock-fast-spec` (spec-driven authoring) — so an assistant like Claude Code can build and maintain your mocks. [Details below](#skills-ai-assisted-authoring).

## Philosophy

- **One line to start.** Sensible hard-coded defaults — port, host, CORS, hot reload, auth header. If you need something non-standard it goes in the JSON, not in flags.
- **The JSON is the source of truth.** Edit one file, the server reloads.
- **Nesting with inheritance.** Declare `requireAuth` once on a protected root and every child inherits it. URLs concatenate.
- **Scalable.** Adding a new extension = one file in `src/extensions/`. The pipeline chains them.

## Install

```bash
npm install --save-dev mock-fast
```

Source: [github.com/MiguelRoot/mock-fast](https://github.com/MiguelRoot/mock-fast).

## Hello world

Create a `mock-fast.json` file at the project root:

```json
{
  "routes": [
    {
      "id": "health",
      "url": "/health",
      "response": { "status": 200, "body": { "ok": true } }
    }
  ]
}
```

Start:

```bash
npx mock-fast start
```

```
[mock-fast] listening on http://127.0.0.1:3001
[mock-fast] admin API on http://127.0.0.1:3110
[mock-fast] DSL: /abs/path/mock-fast.json
```

`GET http://127.0.0.1:3001/health` → `{"ok":true}`.

## Defaults

| Concept | Default |
|---|---|
| DSL file | searches `cwd` for: `mock-fast.json`, `mocks.json`, `mock.json` |
| HTTP port | `3001` |
| HTTP host | `127.0.0.1` |
| CORS | open |
| Admin API | `http://127.0.0.1:3110` (provided by mocks-server) |
| Hot reload | on (the server picks up changes when you save the JSON) |
| Auth header | `Authorization` with pattern `^Bearer [A-Za-z0-9._-]+$` |

To change any of these, put it in the JSON:

```json
{
  "server": { "port": 4000, "cors": false },
  "auth": { "headerName": "X-Token", "pattern": "^sk-.+" },
  "routes": [ ... ]
}
```

CLI flags are only for one-off overrides:

```bash
mock-fast start --file ./fixtures/mock.json --port 4000 --no-watch
```

## DSL

Every node under `routes` can be a route, a group, or both.

### Flat route

```json
{
  "id": "users-list",
  "method": "get",
  "url": "/api/users",
  "response": { "status": 200, "body": { "users": [] } }
}
```

### Nested routes

Each node's `url` is **concatenated** with its parent's. Children inherit `headers` and `extensions` by default. They can override.

```json
{
  "url": "/api/protected",
  "extensions": { "requireAuth": true },
  "response": { "status": 200, "body": { "data": "root" } },
  "routes": [
    {
      "id": "users-list",
      "url": "/users",
      "response": { "status": 200, "body": { "users": ["a", "b"] } }
    },
    {
      "id": "users-byId",
      "url": "/users/:id",
      "response": { "status": 200, "body": { "id": "{{params.id}}" } }
    }
  ]
}
```

Final URLs: `/api/protected`, `/api/protected/users`, `/api/protected/users/:id`. All three require `Authorization: Bearer ...`.

### Pure groups (namespace)

A node without `response` only groups — it registers no endpoint. Useful to reuse inheritance:

```json
{
  "url": "/api",
  "routes": [
    { "id": "login", "url": "/login", "method": "post", "response": { ... } },
    { "id": "logout", "url": "/logout", "method": "post", "response": { ... } }
  ]
}
```

### Inheritance rules

| Field | Inherits | How it combines |
|---|---|---|
| `url` | yes | concatenation with `/` |
| `extensions` | yes | shallow merge (child overrides per key) |
| `headers` | yes | merge (child wins on collision) |
| `method` | no | each route declares its own (default `get`) |
| `response` / `responses` | no | when both are absent, the node is a pure group and registers no endpoint |

## Conditional responses

A route can declare a single `response` (the normal case) or a `responses[]` array with rules that pick which one to serve. Rules, in order:

1. `responses[]` is walked top to bottom.
2. The **first** entry whose `when` matches the request is returned.
3. A response **without** `when` always matches — use it as a fallback at the end.
4. If every entry has a `when` and none matches, mock-fast responds **404** with `{ "error": "No response matched", "route": "...", "method": "...", "url": "..." }`.

The keys in `when` follow the same variables as templating: `body.X`, `query.X`, `headers.X`, `params.X`, `token.X`. Arbitrary dotted paths are supported (`body.user.address.city`, `body.items.0.id`).

Comparison: **equality with string coercion**. `body.dni: 12345673` (a number in the request) matches against `"12345673"` (a string in the rule). If the request value is an array, it matches when **any** element equals the expected primitive (handy for `tags`, `roles`, etc.). `null` in the rule matches `null` **or** missing values.

Across keys of a single `when`, the operator is **implicit AND**. For OR, declare two separate responses.

`response` (single) and `responses` (array) **cannot coexist** on the same node — the schema rejects it.

```json
{
  "id": "verify",
  "url": "/identity/verify",
  "method": "post",
  "responses": [
    {
      "when": { "body.dni": "12345673" },
      "status": 200,
      "body": { "kind": "success", "name": "Renato" }
    },
    {
      "when": { "body.dni": "12345674" },
      "status": 200,
      "body": { "kind": "success", "name": "Juan" }
    },
    {
      "when": { "body.dni": "00000000" },
      "status": 422,
      "body": { "kind": "invalid", "reason": "blacklisted" }
    },
    {
      "status": 200,
      "body": { "kind": "failure", "dni": "{{body.dni}}" }
    }
  ]
}
```

> **Headers are case-insensitive**: Express normalizes them to lowercase, use `headers.x-api-key`, not `headers.X-Api-Key`.
>
> **No templating in `when`**: matcher values are literal. Templating still runs over the `body` and `headers` of the chosen response.
>
> **Operators (`gt`, `regex`, `in`, ...) are not in v1**. The DSL shape (`when: { "path": value }`) is stable; operators will arrive as object-typed values (`{ "body.amount": { "gt": 100 } }`) without breaking this syntax.

## Extensions

Each extension activates when it appears in a route's `extensions` (or a parent's, via inheritance). They run in this order:

1. `requireAuth`
2. `rateLimit`
3. `errorRate`
4. `delayRange`

Any extension that short-circuits (returns 401, 429, 500) skips the rest and the normal response.

### `requireAuth: boolean`

Checks that the auth header (`Authorization` by default) matches `auth.pattern`. If not, **401**.

```json
"extensions": { "requireAuth": true }
```

To turn it off on a child that inherited `true`:

```json
"extensions": { "requireAuth": false }
```

### `errorRate: number` (between 0 and 1)

Rolls a die per request. With probability `errorRate`, returns **500** without reaching the normal body.

```json
"extensions": { "errorRate": 0.10 }
```

10% failure rate. Useful for testing client retries.

### `delayRange: [min, max]`

Random latency in milliseconds before responding.

```json
"extensions": { "delayRange": [200, 1500] }
```

Each request waits a uniform value in `[min, max]`. Composes with everything else.

### `rateLimit`

Counts requests per identifier and cuts off when exceeded. Covers two cases with the same shape: uniform limit and per-user override.

```json
"extensions": {
  "rateLimit": {
    "identifier": "{{token.sub}}",
    "window": "1m",
    "max": 100,
    "perUser": {
      "user-vip": 1000,
      "user-locked": 0
    },
    "onLimit": {
      "status": 429,
      "body": { "error": "Too many requests" }
    }
  }
}
```

| Field | Default | Accepts |
|---|---|---|
| `identifier` | client IP (`req.ip`) | Handlebars expression: `{{body.x}}`, `{{headers.x}}`, `{{token.sub}}` |
| `window` | `"1m"` | `"1m"`, `"5m"`, `"1h"`, `"session"`, `"on-success"` |
| `max` | required | number of requests allowed in the window |
| `perUser` | `{}` | map `identifier → max` (overrides the default) |
| `onLimit` | `{ status: 429 }` | full response when exceeded |

**Windows explained:**

- `"1m"`, `"5m"`, `"1h"`: sliding time window.
- `"session"`: never expires until the server restarts.
- `"on-success"`: the counter resets when this same route returns `2xx`. Simulates **login lockout**: after N failed attempts, blocked; when one finally succeeds, it's released.

## Templating

Every string in `response.body`, `response.headers`, and top-level `headers` passes through Handlebars before being sent. Variables in scope:

| Variable | Source |
|---|---|
| `{{params.X}}` | path params (from `/users/:id`) |
| `{{query.X}}` | querystring |
| `{{body.X}}` | parsed request body |
| `{{headers.X}}` | request headers (lowercase) |
| `{{token.X}}` | JWT payload from the auth header, decoded without verification |

Helpers:

- `{{faker 'category.method' arg1 arg2}}` — any [@faker-js/faker](https://fakerjs.dev) method. E.g. `{{faker 'person.firstName'}}`, `{{faker 'number.int' min=1 max=100}}`.
- `{{randomInt min max}}` — random integer in range.
- `{{uuid}}` — UUID v4.
- `{{now}}` — ISO timestamp.

Examples:

```json
"response": {
  "body": {
    "id": "{{params.id}}",
    "name": "{{faker 'person.fullName'}}",
    "email": "{{faker 'internet.email'}}",
    "tokenSub": "{{token.sub}}",
    "createdAt": "{{now}}"
  }
}
```

### JWT decoding

If the route has `requireAuth` and the header carries `Bearer <jwt>`, mock-fast decodes the payload (base64url, **signature not verified** — it's a mock) and exposes it as `{{token.*}}`. Useful for personalizing responses per user without asking the client to send another header.

## Programmatic usage

```ts
import { createMockFast } from "mock-fast";

const server = await createMockFast({
  file: "./fixtures/mock.json",
  port: 3001,
  silent: true,
});

await server.start();
// ... tests ...
await server.stop();
```

API:

```ts
interface MockFastInstance {
  start(): Promise<void>;
  stop(): Promise<void>;
  reload(): Promise<void>;       // re-reads the DSL and applies it
  url(): string;                 // http://host:port
  adminUrl(): string;            // http://host:adminPort
}
```

## Hot reload

By default, mock-fast watches the DSL file for changes. When you save, it reloads routes/collections without restarting the process or closing the port. `rateLimit` counters reset on reload — that's the natural behavior in dev.

To turn it off: `--no-watch` or `{ watch: false }` in the programmatic API.

## Admin API

Inherited from mocks-server, at `http://127.0.0.1:3110` by default. Useful endpoints:

- `GET /api/mock/routes` — list of routes.
- `GET /api/mock/collections` — collections.
- Swagger UI at `/docs`.

## Deploy with Docker

To run the mock outside your machine, `mock-fast deploy` generates a self-contained, Docker-ready bundle from your DSL:

```bash
npx mock-fast deploy            # writes ./mock-deploy/
```

It validates the DSL first, then writes a `mock-deploy/` folder with a `Dockerfile` (pins the current mock-fast version, binds `0.0.0.0`, disables hot reload), a copy of your DSL as `mock-fast.json`, a `.dockerignore`, and a `README.md`. Then:

```bash
cd mock-deploy
docker build -t my-mock .
docker run --rm -p 3001:3001 my-mock
```

Options: `--out <dir>`, `--port <n>` (baked into the image), `--compose` (also emits a `docker-compose.yml`).

Cautions, because it stays a **mock**:

- No real security — `requireAuth` only checks the header pattern, JWTs are not verified. Don't expose real data.
- The admin API (`3110`) also starts and can mutate routes at runtime; the Dockerfile does **not** expose it — keep it that way.
- `rateLimit` counters are in-memory: they reset on restart and aren't shared across replicas. Run a single instance if that matters.
- No HTTPS — put it behind a reverse proxy or your platform's TLS.

## Skills (AI-assisted authoring)

mock-fast ships two [Agent Skills](https://docs.claude.com/en/docs/claude-code/skills) so an AI assistant (e.g. Claude Code) can build and maintain mocks for you. They're published under `dist/` and live in the repo at [`mock-fast/SKILL.md`](mock-fast/SKILL.md) and [`mock-fast-spec/SKILL.md`](mock-fast-spec/SKILL.md):

- **`mock-fast`** — the DSL reference. Teaches the assistant the full syntax (route tree, `when`, extensions, templating) so it can write `mock-fast.json` by hand.
- **`mock-fast-spec`** — an optional "source of truth" layer. You keep raw captured traffic (request/response JSON) in an `api-spec/<endpoint>/` folder; the assistant infers a reviewable `spec.yml`, you approve it, and it generates or updates `mock-fast.json`. It works in both directions (forward, and reverse-import from an existing `mock-fast.json`), suggests missing error cases (404, 400/422, …), and keeps a strict human-in-the-loop checkpoint. See the worked example in [`example/`](example/).

## Complete example

```json
{
  "auth": {
    "headerName": "Authorization",
    "pattern": "^Bearer [A-Za-z0-9._-]+$"
  },
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
          "id": "login",
          "url": "/login",
          "method": "post",
          "extensions": {
            "rateLimit": {
              "identifier": "{{body.username}}",
              "window": "on-success",
              "max": 3,
              "onLimit": { "status": 423, "body": { "error": "locked" } }
            }
          },
          "response": {
            "status": 200,
            "body": {
              "token": "Bearer mock.{{uuid}}",
              "user": "{{body.username}}"
            }
          }
        },
        {
          "url": "/protected",
          "extensions": {
            "requireAuth": true,
            "errorRate": 0.10,
            "delayRange": [100, 500]
          },
          "response": { "status": 200, "body": { "data": "root" } },
          "routes": [
            {
              "id": "users-list",
              "url": "/users",
              "response": {
                "status": 200,
                "body": {
                  "users": [
                    { "id": 1, "name": "{{faker 'person.firstName'}}" }
                  ]
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

## Roadmap

Planned next extensions (the architecture supports them with a single new file in `src/extensions/`):

- **Variants / scenarios**: switch responses in bulk via the admin API.
- **Matching operators** in `when`: `{ "body.amount": { "gt": 100 } }`, `regex`, `in`, etc. — the current shorthand (direct equality) keeps working.
- **Automatic CRUD**: declare `"crud": true` and get GET / POST / PUT / DELETE over an in-memory collection.
- **Proxy fallback**: undefined routes fall through to a real backend.
- **Request schema validation**: 400 when the body doesn't fit a JSON schema.
- **Advanced rate limit**: window distributions, metrics.

## License

MIT
