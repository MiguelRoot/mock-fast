---
name: mock-fast-spec
description: Use this skill for the AI-managed "source of truth" layer on top of mock-fast — when the user keeps raw captured API traffic (request/response JSON) in an `api-spec/<endpoint>/` folder and wants the assistant to infer a `spec.yml` and generate or update `mock-fast.json` from it, instead of hand-writing the DSL. It runs in both directions: forward (api-spec → mock-fast.json) and reverse/import (an existing `mock-fast.json` → a fresh `api-spec/` tree). Two-phase, human-in-the-loop. Triggers on prompts like "agregué un endpoint X / pegué estos JSON, créame el spec", "modifiqué la ruta /autenticacion, actualizá el mock", "sincronizá el spec de <endpoint>", "convertí estas respuestas en un mock", "detectá qué cambió en este endpoint y actualizá mock-fast.json", and for the reverse direction "ya tengo un mock-fast.json, generame el api-spec", "convertí mi mock existente en specs", "importá / hacé reverse de mock-fast.json". This is the OPTIONAL agentic companion to the `mock-fast` skill: `mock-fast` documents how to write the DSL by hand; THIS skill derives the DSL from captured traffic via a reviewable `spec.yml` (and can bootstrap that spec from a mock you already have).
---

# mock-fast-spec — spec-driven, AI-managed layer for mock-fast

This skill is an **optional abstraction layer** over [`mock-fast`](../mock-fast/SKILL.md). The user does **not** write the `mock-fast.json` DSL. Instead they keep, per endpoint, the **raw traffic they observed on the wire** (request and response JSON) in a folder. They tell you *"I added / modified endpoint X"*, and you:

1. **Infer** a small, reviewable `spec.yml` from the captured JSON (what changed, the cases, the selectors, the nullable fields).
2. **Stop and let the user review** the `spec.yml`. Never skip this.
3. On their go-ahead, **generate or update** `mock-fast.json` from the approved `spec.yml`.

> **Which skill when?**
> - **`mock-fast`** — reference for the DSL itself (route shape, `when`, extensions, templating). You will lean on it for the *output* of phase 2.
> - **`mock-fast-spec`** (this one) — the workflow that *produces* that DSL from captured traffic with a human checkpoint. Use it whenever the user works through an `api-spec/` folder rather than editing `mock-fast.json` directly.

## The contract: spec.yml describes the wire, nothing else

`spec.yml` is the **protocol between client and server** — only what you'd see in a packet capture. HTTP method/path/auth/headers/status, request and response shapes, and the **server-side condition** under which each response is returned. Anything about *the client* (navigation, state, UI, "the app should do X") does **not** belong here. Mental test: if a fact applies equally to a web client, a mobile client, and a server-to-server integration, it belongs; if it only applies to one app, it doesn't.

The raw `.json` files are the **captured truth** — treat them as read-only fixtures. `spec.yml` and `mock-fast.json` are *derived* from them. Never quietly rewrite a capture to make generation easier; if a capture is wrong, say so.

### Direction of truth (one-way)

```
api-spec/  (captures + spec.yml)   ──generate──▶   mock-fast.json
        THE SOURCE OF TRUTH                        a derived artifact
```

- **`api-spec/` is authoritative.** `mock-fast.json` is **generated** from it and should be treated as build output: don't hand-edit it as an input, don't read it back as a fact. To change behavior, change the captures/`spec.yml` and regenerate.
- **The reverse (Mode C) is the single exception** where `mock-fast.json` is read as input — and only to *bootstrap* the source of truth that doesn't exist yet. It is **not** part of the steady-state loop.
- Therefore reverse runs **once**: the first time (no `api-spec/` exists), or when the user asks for it **explicitly**. After `api-spec/` exists, never auto-reverse — that would let the generated artifact overwrite its own source.
- If you notice `mock-fast.json` was hand-edited and now **drifts** from `api-spec/`, do **not** silently import the change back. Surface the drift and ask: the fix is almost always to update the capture/`spec.yml` and regenerate, not to reverse.

## Directory layout

```
<project>/
├── mock-fast.json              ← generated/updated by phase 2 (the live mock)
└── api-spec/
    ├── README.md               ← optional human copy of this schema
    └── <endpoint-name>/
        ├── spec.yml            ← inferred in phase 1, reviewed by the user
        ├── request-<variant>.json         ← captured request bodies (optional)
        └── response-<code>-<variant>.json ← captured responses (required)
```

`<endpoint-name>` is a free folder name (`autenticacion`, `perfil`, `documentos`). `<variant>` is a free id (`step1`, `step2`, `unauthorized`, `not_found`).

## `spec.yml` schema

| Field | Type | Required | Maps to (mock-fast) |
|---|---|---|---|
| `description` | string | no | comment only |
| `method` | `GET\|POST\|PUT\|PATCH\|DELETE` | yes | route `method` |
| `path` | string | yes | route `url` (relative to BASE_URL) |
| `auth` | `none\|bearer` | yes | `extensions.requireAuth` (`bearer`→`true`) |
| `headers` | `map<string,string>` | no | route `headers` |
| `cases` | `map<variant, case>` | yes | `response` or `responses[]` |
| `behavior` | `map` | no | `extensions` (see below) |
| `dynamic` | `map<dotpath, handlebars>` | no | templating on the chosen response body |
| `request_constraints` | `list<string>` | no | doc only (static rules) |
| `notes` | `list<string>` | no | doc only (shape facts) |

### The `case` object

| Field | Type | Required | Meaning |
|---|---|---|---|
| `when` | string | no | **Prose** server-side condition. For humans and test names. NOT machine-read. |
| `match` | `map<dotpath, primitive>` | no | **Machine selector** → mock-fast `when`. Absent ⇒ this is the **fallback**. |
| `request` | filename | no | Example request body (omit if the case is request-agnostic). |
| `response` | filename | yes | Example response body. |
| `status` | int | yes | HTTP status. |

`match` keys are dotted paths into the request context exactly like mock-fast's `when`: `body.X`, `query.X`, `headers.X` (lowercase!), `params.X`, `token.X`. Values are primitives only (`string|number|boolean|null`). See **Translation** for how this becomes `response` vs `responses[]`.

### The `behavior` object (optional → extensions)

```yaml
behavior:
  latency_ms: [80, 400]          # → extensions.delayRange
  error_rate: 0.05               # → extensions.errorRate (0..1)
  rate_limit:                    # → extensions.rateLimit
    by: "{{body.usuario}}"       #   identifier (handlebars)
    window: on-success           #   1m | 5m | 1h | session | on-success
    max: 3
    per_user: { user-vip: 1000, user-locked: 0 }   # optional
    on_limit: { status: 423, body: { error: "..." } }  # optional
```

### The `dynamic` object (optional → templating)

The captured `.json` are frozen snapshots — good as **test fixtures**, but a live mock feels real when volatile fields regenerate per request. `dynamic` lists which fields of the **selected response body** to replace with a Handlebars expression when generating the DSL. The `.json` file stays untouched.

```yaml
dynamic:
  "timestamp": "{{now}}"
  "data.aplicaciones.0.token": "Bearer mock.{{uuid}}"
```

### Minimal valid spec

```yaml
method: GET
path: /algo
auth: bearer
cases:
  ok:
    when: well-formed request
    response: response-200.json
    status: 200
```

## The two-phase workflow — never collapse it

**This skill is two phases with a hard stop between them.** Phase 1 only ever writes/updates `spec.yml`. Phase 2 only ever writes `mock-fast.json`, and only after the user approves. If the user says "agregá X" you do phase 1 and stop; you do **not** also generate the mock until they say "procedé" (or equivalent).

### Mode A — new endpoint

Trigger: *"agregué un endpoint / pegué estos JSON en `api-spec/<x>/`, creá el spec"*.

1. **Read** every `*.json` in `api-spec/<endpoint>/`. Classify request vs response (filename `request-*` / `response-*`, else by content / by having a status-like shape).
2. **Infer** `spec.yml` using the rules below. For anything not derivable from the JSON (notably `path` and `method` — they are NOT in the body), insert a clearly-marked `TODO` and ask, rather than guessing.
3. **Write the draft `spec.yml`**, then **STOP**. Summarize: the cases you found, the `match` selectors you chose and why, the fields you flagged nullable, and every open question. Do **not** touch `mock-fast.json`.
4. User edits the `spec.yml` and/or replies "procedé".
5. **Phase 2:** generate the route, **merge** it into `mock-fast.json` (add, or replace the route with the same id/path; preserve everything else), validate against mock-fast's DSL rules, report.

### Mode B — modified endpoint

Trigger: *"modifiqué la ruta /autenticacion"* or the user edited a `response-*.json`.

1. **Locate** the endpoint folder, its existing `spec.yml`, and the current route in `mock-fast.json`.
2. **Diff** the on-disk `.json` against what `spec.yml` / `mock-fast.json` currently encode. Detect: new/removed/renamed fields, changed `status`, a new variant file, changed selector values, nullability flips, a new error case.
3. **Summarize the delta in plain words**, update `spec.yml` (including its `notes`), then **STOP** for review. Do **not** touch `mock-fast.json` yet.
4. On approval, **regenerate just that route** in `mock-fast.json` and report.

### Mode C — import / reverse (existing `mock-fast.json` → `api-spec/`)

Trigger: *"ya tengo un mock-fast.json, generame el api-spec"* / *"convertí mi mock existente en specs"* / *"importá / hacé reverse"*. This is the **inverse** of phases 1–2: the mock already exists; you bootstrap the source-of-truth layer **from** it.

**When this is allowed (see _Direction of truth_):** Mode C is a **one-time bootstrap**, not part of the loop. Run it only when **no `api-spec/` exists yet** for the endpoint(s), or when the user **explicitly** asks to import/reverse. Once `api-spec/` exists it is authoritative — do **not** reverse automatically, and never in response to a `mock-fast.json` edit (that edit is drift to surface, not input to import). If `api-spec/` already exists and the user asks to re-import, confirm first: re-import overwrites the source of truth with output derived from the artifact.

1. **Read** the existing `mock-fast.json` and flatten its route tree (resolve URL concatenation and inherited `extensions`/`headers`, exactly as the mock engine does — a child of a `requireAuth` parent is `auth: bearer`).
2. For **each route that registers an endpoint** (has `response` or `responses`; pure namespace nodes are skipped), create `api-spec/<endpoint>/` and reverse-map it to a `spec.yml` + fixture files using the **Reverse rules** below.
3. **Stop for review.** This is a **draft**: bodies came from the mock's own templates, not from a real capture, so flag every templated/synthesized field as needing confirmation. Present the tree you'd create (folders, files, open questions). Do **not** overwrite an existing `api-spec/<endpoint>/` without saying so.
4. On approval, **write** the `api-spec/` tree. From here the forward flow (Modes A/B) takes over: the user edits captures and re-syncs.

> Import produces a **seed** spec, not ground truth. A `mock-fast.json` body like `"{{faker 'person.firstName'}}"` has no real captured value — keep the expression, lift it into `dynamic`, and add a note to replace it with a real capture. Never present a reverse-import as if it were observed traffic.

## Inference rules (JSON → spec.yml)

| You observe | You infer |
|---|---|
| filename `response-401-*.json` / a body with `"code": 401` | a `case` with `status: 401` |
| one response file per outcome | one `case` per file; `variant` from the filename |
| two `request-*.json` that differ only in field F (e.g. `totp: null` vs `"123456"`) | F is the **discriminator** → put it in each case's `match` |
| a request body whose values equal the "happy" inputs | those values become the `match` of the success case |
| an error case with no distinguishing request (wrong creds) | **no `match`** → it's the fallback, ordered last |
| a field that is `null` in some captures | note: "`X` suele venir null" → caller marks it nullable downstream |
| a field that is `null` in **every** capture | note: "`X` siempre null, candidato a ignorar" — flag, don't drop silently |
| `Authorization` header present on the request | `auth: bearer` |
| no auth header anywhere | `auth: none` (add a note if unsure) |
| `method` / `path` | **not in the body** — ask the user or leave a `TODO` |
| a `timestamp`/`token`/uuid-looking field | propose it under `dynamic` (`{{now}}` / `{{uuid}}`) in the review summary |

When picking `match` selectors, choose the **fewest fields that uniquely separate the cases** — usually the discriminator plus the credential fields that distinguish success from the fallback. More keys = stricter AND.

## Translation rules (approved spec.yml → mock-fast.json)

- **One case, no `match`** → the route uses a single `response`.
- **Multiple cases** → the route uses `responses[]`. Each `match` becomes a `when`; a case **without** `match` becomes the trailing entry **without** `when` (the fallback). Order: all `match` cases first, fallback last. (mock-fast returns the **first** match; if every entry had a `when` and none matched the client gets a 404 — that's why the fallback must be present and last.)
- `auth: bearer` → `extensions.requireAuth: true`.
- `behavior.latency_ms` → `delayRange`; `behavior.error_rate` → `errorRate`; `behavior.rate_limit` → `rateLimit` (`by`→`identifier`, `window`/`max`/`per_user`→`perUser`/`on_limit`→`onLimit`).
- `dynamic` → splice each Handlebars expression into the response body at its dotted path before emitting.
- `response` body is otherwise copied **verbatim** from the captured `.json`.
- `path` → route `url`; if several specs share a prefix and the same `auth`, you MAY nest them under a grouping node and hoist `requireAuth` — but that's an optimization you propose, never a requirement.

## Reverse rules (existing `mock-fast.json` → spec.yml + fixtures) — Mode C

The mirror of the translation table. Work on the **flattened** route (parent URL and inherited extensions already resolved).

| In `mock-fast.json` | Reverse to |
|---|---|
| route `method` + resolved `url` | `method` + `path` |
| `extensions.requireAuth: true` (own or inherited) | `auth: bearer`; absent/`false` → `auth: none` |
| `extensions.delayRange` / `errorRate` / `rateLimit` | `behavior.latency_ms` / `error_rate` / `rate_limit` |
| single `response` | one `case` `ok`; `response.body` → `response-<status>.json`; `status` from `response.status` |
| `responses[]` entry **with** `when` | a `case` with `match` = the `when`; `body` → `response-<code>-<variant>.json` |
| `responses[]` entry **without** `when` | the **fallback** `case` (no `match`, ordered last) |
| a `when` made of `body.*` keys | synthesize `request-<variant>.json` by un-flattening those dotted paths (`body.usuario`→`{usuario:...}`); `query.*`/`headers.*`/`params.*`/`token.*` matchers go in `notes`, not the request body |
| a body field whose value is a Handlebars expression (`{{now}}`, `{{uuid}}`, `{{faker ...}}`, `{{body.x}}`) | add it to `dynamic`; keep the expression in the fixture and add a note "seed — replace with real capture" |
| route `headers` (resolved) | `headers` |
| route `id` or last URL segment | the `<endpoint>` folder name |

**Variant naming** (no filenames exist to copy from): single response → `ok`; for `responses[]`, name 2xx entries by the distinguishing `when` field/value (or `ok1`, `ok2`), and name the fallback / error entries by status (`401`→`unauthorized`, `403`→`forbidden`, `404`→`not_found`, `409`→`conflict`, `422`→`unprocessable`, `423`→`locked`, else `error<code>`). Keep names stable so a later re-import is a clean diff.

## Limits to surface (the matcher is weaker than prose)

mock-fast's `when` is **equality of primitives, keys AND-ed, no operators, no "exists", no negation**. Your prose `when` is richer. When the gap bites, say so in the review summary instead of silently approximating:

- **"any non-null value"** can't be matched — only specific literals. Enumerate the values, or rely on the fallback.
- **negation** ("invalid TOTP") isn't expressible — model it as the fallback (exclusion).
- **two distinct error responses** that differ only by a *wrong* value (401 wrong-password vs 422 wrong-TOTP) can't both be matched, because "wrong" isn't a literal. Pick one as the fallback, or agree on a sentinel literal to trip the other.
- header matchers are **lowercase** (`headers.x-api-key`); a `POST` whose body you match on must be sent with `Content-Type: application/json`.

## Coverage suggestions (gap analysis)

Because `api-spec` declares **all the inputs and outputs** of an endpoint, you can spot **missing error handling** and propose it. Do this as part of the phase-1 review summary (Mode A and Mode B): list the gaps you detect, with a suggested status and a reasonable default body, and let the user decide. **Suggestions only — never auto-add a case.** The user confirms (and supplies the real error shape) before it enters `spec.yml` → the mock.

Ground every suggestion in what's observable; don't invent endpoints or methods that weren't captured.

| You observe | Likely missing case to suggest |
|---|---|
| `path` contains a path param (`:id`, `/{id}`) and no `404` case | `404 not_found` for an unknown id |
| `auth: bearer` but no `401` case captured | `401 unauthorized` with the API's real body (mock-fast's `requireAuth` returns a *generic* 401 — capture the real shape if it differs) |
| `POST`/`PUT`/`PATCH` with a request body and no `400`/`422` case | `400`/`422` for malformed or missing required fields |
| only success cases, **no fallback** (`match`-less case) | a fallback — otherwise any non-matching request gets mock-fast's generic `404 "No response matched"`, not your shape |
| `behavior.rate_limit` set but no `429`/`423` case captured | document the limit response (`on_limit`) shape so it's deliberate, not the default |
| a create (`POST`) of a unique resource, no `409` | `409 conflict` for duplicates (lower confidence — flag, don't push) |
| validation rules in `request_constraints` but no error case for violating them | an error case (usually `400`/`422`) exercising that constraint |

Frame each as "el mock hoy no maneja X — ¿lo agrego?" and note whether mock-fast already covers it with a **default** (auth → generic 401; no-match → generic 404) vs needing a **real captured shape**. The point is deliberate coverage of the real contract, not a generic placeholder.

## Worked example — `autenticacion` (real, end to end)

**Captured input** (`api-spec/autenticacion/`): two requests differing only in `totp` (`null` vs `"123456"`), two `200` responses, one `401`.

**Phase 1 — inferred `spec.yml`:**

```yaml
description: Login con flujo de 2 pasos sobre la misma URL.
method: POST
path: /autenticacion-mobile-service/autenticacion
auth: none

cases:
  step1:
    when: body.totp es null y credenciales válidas
    match: { "body.usuario": "jperez", "body.contrasena": "test1234", "body.totp": null }
    request: request-step1.json
    response: response-200-step1.json
    status: 200
  step2:
    when: body.totp correcto y credenciales válidas
    match: { "body.usuario": "jperez", "body.contrasena": "test1234", "body.totp": "123456" }
    request: request-step2.json
    response: response-200-step2.json
    status: 200
  unauthorized:
    when: credenciales o TOTP inválidos   # no match → fallback (exclusión)
    response: response-401.json
    status: 401

dynamic:
  "timestamp": "{{now}}"
  "data.aplicaciones.0.token": "Bearer mock.{{uuid}}"

notes:
  - "`usuario.fecRegistro` suele venir null"
  - "`aplicaciones[].perfilesDetails` siempre null, candidato a ignorar"
  - "Formato del 401 tentativo, confirmar con backend"
```

*Review summary you'd present:* 3 cases; `match` separates step1/step2 by `body.totp`; `unauthorized` is the fallback (the matcher can't express "invalid", so anything not matching the two success selectors returns 401); `timestamp`/`token` proposed as dynamic; `roles`/`perfilesDetails` flagged null. **Open question:** confirm `path`/`method` and the 401 shape.

**Phase 2 — generated route in `mock-fast.json`** (after approval):

```json
{
  "id": "autenticacion",
  "url": "/autenticacion-mobile-service/autenticacion",
  "method": "post",
  "responses": [
    { "when": { "body.usuario": "jperez", "body.contrasena": "test1234", "body.totp": null },
      "status": 200, "body": { "code": 200, "status": "success", "data": { /* step1 verbatim */ }, "timestamp": "{{now}}" } },
    { "when": { "body.usuario": "jperez", "body.contrasena": "test1234", "body.totp": "123456" },
      "status": 200, "body": { "code": 200, "status": "success", "data": { /* step2, token → Bearer mock.{{uuid}} */ }, "timestamp": "{{now}}" } },
    { "status": 401, "body": { "code": 401, "status": "error", "message": "Credenciales inválidas", "timestamp": "{{now}}" } }
  ]
}
```

A full generated file lives in [`example/mock-fast.json`](../example/mock-fast.json), built from [`example/api-spec/autenticacion/`](../example/api-spec/autenticacion/).

## Checklist

1. Did you stay in **two phases**? `spec.yml` first, **stop for review**, `mock-fast.json` only on approval.
2. Did you leave the captured `.json` **untouched**?
3. For multi-case endpoints: exactly **one** case without `match`, and is it the **fallback** (ordered last)? Two `match`-less cases is an error.
4. Did you pick `match` selectors from the **discriminating** request fields, fewest keys that separate the cases?
5. Did you mark `path`/`method`/auth as `TODO` and **ask** when the JSON couldn't tell you, instead of guessing?
6. Did you surface every **matcher limitation** that bit (negation / exists / two distinct errors) in the review summary?
7. On modify: did you **diff** and summarize the delta before editing the spec?
8. Did you propose `dynamic` for timestamps/tokens, and verify each dotted path exists in the response body?
9. Did the generated DSL validate against the `mock-fast` rules (no `response`+`responses` together, fallback present, lowercase header matchers)?
10. On import (Mode C): did you **flatten** inherited URL/extensions first, label the result a **draft/seed**, lift every templated field into `dynamic` with a "replace with real capture" note, and refuse to overwrite an existing `api-spec/<endpoint>/` silently?
11. Did you run the **coverage gap analysis** in the review summary (missing 404 on `:id` routes, 400/422 on body endpoints, an explicit fallback, etc.) — as suggestions the user confirms, never auto-added?
