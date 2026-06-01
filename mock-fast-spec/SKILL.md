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

| Command | What it does |
|---|---|
| `mock-fast sync` | forward: `api-spec/` → `mock-fast.json` (when the api-spec is the source) |
| `mock-fast sync --from-mock` | reverse: regenerate the whole `api-spec/` view FROM `mock-fast.json` (`--force`) |
| `mock-fast watch` | **mock-fast.json is the source of truth; api-spec/ is a readable view.** See below. |

The transformation is **deterministic code** — never hand-write `mock-fast.json` from a spec, and never hand-derive a spec by mentally flattening the mock. Run the command.

## The `watch` model: mock is the source, api-spec is the view

In `watch`, the **`mock-fast.json` is the source of truth**. The `api-spec/` is a readable projection of it so the user can see request/response clearly and edit there. Keys:

- **`r`** (and on startup): reverse the view from the mock (`mock-fast.json` → `api-spec/`), snapshot it, and **reset** the change log.
- **`m`**: diff the current `api-spec/` against that snapshot and write **`.mock-fast/changes.json`** — `{file, line, kind, before, after}` per edited line, **only changes since the last `r`**.
- The server runs on `mock-fast.json` and hot-reloads when it's rewritten.

### Your job in this model

1. **"actualizá el último cambio en el mock"** (the main one): read **`.mock-fast/changes.json`**. It points you to the exact file + line(s) the user edited. Apply **just those edits** to `mock-fast.json` surgically — find the corresponding field in the mock and change it. **Do not** regenerate the whole mock from the api-spec (the view is lossy — a forward `sync` would damage it). After you apply, tell the user to press `r` (refreshes the view and clears the log). Touch only what `changes.json` lists.
2. **Fix `missing-bridge`.** If the user pastes a `.mock-fast/sync-error.json` (a folder has `response-*.json` but no `spec.yml`): that folder is an endpoint; write its `spec.yml` (URL = folder path; infer `method` or ask; ask about `auth` only if unclear).
3. **Edit on request.** "revisá los responses de `<x>`", "renombrá `contrasena`→`password`": edit the relevant `.json`/`spec.yml`. One change at a time.
4. **Bootstrap.** "generá el api-spec desde mi mock" → `mock-fast sync --from-mock --force`.

You apply changes to `mock-fast.json` **only** when guided by `changes.json` (surgical) — otherwise you edit the api-spec view and the user drives the CLI.

## `spec.yml` is pure logic — no human language

A `spec.yml` contains **only** the fields the generator reads. **No comments, no prose, no `description`, no `notes`, no `when`-in-words.** It's an interface, not documentation.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `method` | `GET\|POST\|PUT\|PATCH\|DELETE` | yes | route method |
| `auth` | `none\|bearer` | no | `bearer`→`requireAuth:true`. Omit to inherit from an ancestor `_group.yml`; set to override. |
| `headers` | `map<string,string>` | no | route headers |
| `cases` | `map<key, case>` | yes | one response, or conditional `responses[]` |
| `behavior` | `map` | no | extensions (below) |
| `dynamic` | `map<dotpath, handlebars>` | no | fields of the response body to templatize |

**`case` object:** `match` (map of dotted request paths → primitive; absent ⇒ this is the fallback), `request` (optional example file), `response` (file, required), `status` (int, required).

**Naming — status, not prose.** The status code already identifies the response, so don't add words:
- **Response file:** `response-<status>.json`. A second response of the same status is `-v2`, `-v3` (`response-200.json`, `response-200-v2.json`).
- **Request file:** `request.json` (a request has no status). A second is `request-v2.json`, `request-v3.json`.
- **Case key:** `s<status>` (+ `_v2`, `_v3`). The `s` prefix is because YAML keys can't start with a digit.

Filenames are just labels — the `case` links its own `request:`/`response:` explicitly, so a case's request and response don't have to share a suffix. (`sync --from-mock` only emits response files; requests aren't in the mock, so you/the user create those.)

```yaml
method: POST
auth: none
cases:
  s200:
    match: { "body.usuario": "jperez", "body.password": "test1234" }
    response: response-200.json
    status: 200
  s401:                  # no match ⇒ fallback, must be last
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
