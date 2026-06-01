---
name: mock-fast-spec
description: Use this skill when the user keeps an `api-spec/` folder as the source of truth for a mock-fast mock server — captured response JSON plus a `spec.yml` per endpoint — and wants help wiring it up. The transformation api-spec ↔ mock-fast.json is done by deterministic CLI commands (`mock-fast sync`, `mock-fast watch`, `mock-fast sync --from-mock`), NOT by you hand-editing the DSL. Your job is to write/fix the `spec.yml` (the per-endpoint logic) when the watcher reports it's missing or wrong, and to edit the response JSON / spec when the user asks. Triggers: "el watch dice que falta el spec / missing-bridge", "creá el spec.yml de <endpoint>", "revisá los responses de <endpoint>", "agregué un json, ayudame a declararlo", "generá el api-spec desde mi mock" (→ `sync --from-mock`).
---

# mock-fast-spec — the api-spec source-of-truth layer

> **Skill version:** `0.0.0-dev` — should match the installed `@killki/mock-fast`. See [Staying in sync](#staying-in-sync-with-the-installed-library).

A mock-fast server can be driven from an `api-spec/` folder instead of editing `mock-fast.json` by hand. Two layers:

- **JSON = static data.** `response-*.json` (and optional `request-*.json`) are plain examples of what an endpoint receives and returns. Easy to read; easy to spot a wrong/missing field at a glance — that's the whole point.
- **`spec.yml` = the per-endpoint logic.** It's the dynamic interface of ONE endpoint (think the slice of a Swagger doc for that route): method, auth, which response for which request, which fields are dynamic. It turns the static JSON into something the server can run.

The two together are the bridge that builds the mock server.

## You don't transform — the CLI does

The api-spec ↔ mock-fast.json conversion is **deterministic code**, not your job:

| Command | Direction |
|---|---|
| `mock-fast sync` | `api-spec/` → `mock-fast.json` |
| `mock-fast watch` | runs the server; press `r` to re-sync + reload (Flutter/Expo style) |
| `mock-fast sync --from-mock` | reverse: regenerate the whole `api-spec/` tree FROM `mock-fast.json` (`--force` to overwrite) |

So **never hand-write `mock-fast.json` from a spec, and never hand-derive a spec by mentally flattening the mock** — run the command. The generator copies fixtures verbatim and resolves inheritance, so it can't drift. If it fails it prints a structured error (also to `.mock-fast/sync-error.json`) with `kind`, `where`, `problem`, `suggestion`.

## Your actual job

1. **Fix `missing-bridge`.** When the user pastes a `sync-error.json` (or says the watcher reports a folder has `response-*.json` but no `spec.yml`): that folder is an endpoint. Read its JSON and write the `spec.yml`. The URL is the folder path — don't ask about it. `method` isn't in the body: infer it (a `request-*.json` present ⇒ POST/PUT/PATCH, else GET) or **ask**. Ask about `auth` only if unclear.
2. **Edit on request.** "revisá los responses de `<x>`", "renombrá `contrasena`→`password`", "agregá un campo": edit the relevant `.json` / `spec.yml` following the existing pattern. One change at a time. Then tell the user to run `sync`/`r`.
3. **Bootstrap.** "generá el api-spec desde mi mock" → that's `mock-fast sync --from-mock`; run it (warn it overwrites with `--force`, and that templated values become samples).

You write **spec.yml and JSON**. You do not write `mock-fast.json`.

## `spec.yml` is pure logic — no human language

A `spec.yml` contains **only** the fields the generator reads. **No comments, no prose, no `description`, no `notes`, no `when`-in-words.** It's an interface, not documentation.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `method` | `GET\|POST\|PUT\|PATCH\|DELETE` | yes | route method |
| `auth` | `none\|bearer` | no | `bearer`→`requireAuth:true`. Omit to inherit from an ancestor `_group.yml`; set to override. |
| `headers` | `map<string,string>` | no | route headers |
| `cases` | `map<variant, case>` | yes | one response, or conditional `responses[]` |
| `behavior` | `map` | no | extensions (below) |
| `dynamic` | `map<dotpath, handlebars>` | no | fields of the response body to templatize |

**`case` object:** `match` (map of dotted request paths → primitive; absent ⇒ this is the fallback), `request` (optional example file), `response` (file, required), `status` (int, required).

```yaml
method: POST
auth: none
cases:
  exito:
    match: { "body.usuario": "jperez", "body.password": "test1234" }
    response: response-200.json
    status: 200
  fallo:                 # no match ⇒ fallback, must be last
    response: response-401.json
    status: 401
```

Selection at runtime: cases are tried **in order**, first `match` wins; the match-less case is the catch-all and goes **last**. Exactly **one** fallback per endpoint.

### `behavior` → extensions

```yaml
behavior:
  latency_ms: [80, 400]      # → delayRange
  error_rate: 0.05           # → errorRate
  rate_limit:                # → rateLimit
    by: "{{body.usuario}}"
    window: on-success       # 1m | 5m | 1h | session | on-success
    max: 3
    per_user: { user-vip: 1000 }       # optional
    on_limit: { status: 423, body: { error: "..." } }   # optional
```

### `dynamic` → templating (and the JSON-stays-static rule)

Fixtures are **static data and never contain Handlebars**. When a response field must vary per request (timestamp, token, echo of input), keep a concrete sample value in the `.json` and declare the expression in `dynamic`:

```yaml
dynamic:
  "timestamp": "{{now}}"
  "data.token": "Bearer mock.{{uuid}}"
```

The generator substitutes those paths when building `mock-fast.json`; the `.json` itself stays plain. A `dynamic` path that exists in only some cases is applied where present (e.g. a token only in the success body).

## Folder = URL (the route tree)

The folder path IS the URL (Next.js style — there is **no `path` field**). Nest folders for deeper paths; nest a subtree to share auth.

```
api-spec/
└── api/
    └── protegida/
        ├── _group.yml      ← shared config for the subtree (auth: bearer, behavior). No cases.
        ├── perfil/         → GET /api/protegida/perfil   (inherits auth: bearer)
        └── [id]/           → /:id
```

| Folder | URL segment |
|---|---|
| `usuarios/` | `/usuarios` |
| `[id]/` | `/:id` (read as `{{params.id}}`) |
| `[...rest]/` | `/*` catch-all (read as `{{params.[0]}}`; emitted last) |
| `[[...rest]]/` | optional catch-all → two routes (`/x` and `/x/*`) |
| `(grupo)/` | nothing (groups children, shares config, no segment) |
| `_privado/` | ignored by routing |

**Files:** `spec.yml` makes the folder an endpoint; `_group.yml` carries shared `auth`/`behavior`/`headers` for the subtree (no `cases`). Both optional — a bare folder just contributes its segment. `auth`/`behavior`/`headers` inherit from the nearest ancestor `_group.yml`; a child overrides per key (`auth: none` disables an inherited guard).

## Matcher limits (be honest about these)

mock-fast's matching is **equality of primitives, AND-ed, no operators, no negation**. So:
- "wrong password" / "any non-null value" can't be matched — model the error as the **fallback** (everything that didn't match a success case).
- Two distinct errors that differ only by a *wrong* value can't both be matched; one must be the fallback.
- Header keys are lowercase (`headers.x-api-key`); a matched POST body needs `Content-Type: application/json`.
- A primitive matched against an array matches if **any** element equals it (`"body.aplicaciones": "VS"` matches `["VS"]`).

## Staying in sync with the installed library

This skill is versioned to match `@killki/mock-fast` (see **Skill version** at top). A skill file is a *copy* in the project, so it can fall behind after an upgrade. When you use it, do a quick soft check: read the installed version (`node_modules/@killki/mock-fast/package.json`), compare to the Skill version, and if the library is newer, suggest refreshing the copy from `node_modules/@killki/mock-fast/dist/mock-fast-spec/SKILL.md`. Never a blocker. If it reads `0.0.0-dev`, it's an unbuilt source copy — ignore the check.
