---
name: mock-fast-spec
description: Use this skill for the AI-managed "source of truth" layer on top of mock-fast — when the user keeps raw captured API traffic (request/response JSON) in an `api-spec/<endpoint>/` folder and wants the assistant to infer a `spec.yml` and generate or update `mock-fast.json` from it, instead of hand-writing the DSL. It runs in both directions: forward (api-spec → mock-fast.json) and reverse/import (an existing `mock-fast.json` → a fresh `api-spec/` tree). Two-phase, human-in-the-loop. Triggers on prompts like "agregué un endpoint X / pegué estos JSON, créame el spec", "modifiqué la ruta /autenticacion, actualizá el mock", "sincronizá el spec de <endpoint>", "convertí estas respuestas en un mock", "detectá qué cambió en este endpoint y actualizá mock-fast.json", and for the reverse direction "ya tengo un mock-fast.json, generame el api-spec", "convertí mi mock existente en specs", "importá / hacé reverse de mock-fast.json". This is the OPTIONAL agentic companion to the `mock-fast` skill: `mock-fast` documents how to write the DSL by hand; THIS skill derives the DSL from captured traffic via a reviewable `spec.yml` (and can bootstrap that spec from a mock you already have).
---

# mock-fast-spec — spec-driven, AI-managed layer for mock-fast

> **Skill version:** `0.0.0-dev` — should match the installed `@killki/mock-fast`. See [Staying in sync](#staying-in-sync-with-the-installed-library).

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

### The JSON is the hub (two-way sync, one direction per change)

The `api-spec/` JSON is the **central point of communication** — the friendly surface the user reads, edits, and controls. `mock-fast.json` is the live server kept **in sync** with it. Sync runs **both ways**, but it is always **user-directed**: the user declares which side changed, and the agent reflects it to the other. There is no automatic sync.

```
api-spec/  (JSON: captures + spec.yml)   ◀──sync (user-directed)──▶   mock-fast.json
        the hub the user controls                                     the live mock server
```

Typical directions (the user picks per action):

| Situation | Direction | Mode |
|---|---|---|
| Something **new** | add behavior in `mock-fast.json`, then generate its JSON | mock-fast → JSON (Mode C / fill-gaps) |
| **Modify** an endpoint that already has JSON | edit the JSON, reflect into `mock-fast.json` | JSON → mock-fast (Modes A/B) |
| User hand-edited the JSON | "update the mock" | JSON → mock-fast (Mode B) |

**The one rule that prevents chaos: one direction per change.** A given change is authored on **one** side, and the agent regenerates the **other** side from it. Don't hand-edit both sides for the same change and expect reconciliation — that's the only way to create conflicting "truths".

- Prefer the **JSON** as the place to author and review changes (it's the hub). Editing `mock-fast.json` directly is fine too — especially for brand-new endpoints — as long as you then sync the JSON from it.
- The two are **complementary**: if one side has data the other lacks, **derive it** (don't make the user retype).
- If both sides were independently hand-edited and now **conflict**, do **not** guess a winner — surface the conflict and ask the user which side is correct, then sync that direction.

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

**The folder path IS the URL** — `<endpoint-name>/` is a URL segment (`autenticacion/` → `/autenticacion`); nest folders for deeper paths (next section). There is **no `path` field** — one rule, like Next.js. `<variant>` is a free id (`step1`, `step2`, `unauthorized`, `not_found`).

## Folders are the URL (the route tree)

mock-fast is a **tree with inheritance**: URLs concatenate and `extensions`/`headers` inherit from the parent. The `api-spec/` folders mirror that tree **1:1** — the folder path is the URL, at any depth. This is the **single rule** for routing (no `path` override, exactly like Next.js / Astro / ASP.NET file-routing). A one-segment endpoint is just depth 1; nest deeper for longer paths, and nest a subtree when it **shares auth** (declare the token guard once on the parent, children inherit).

```
api-spec/
└── api/
    ├── _group.yml              ← namespace node: segment "/api", no endpoint of its own
    └── protegida/
        ├── _group.yml          ← segment "/protegida" + auth: bearer   ← the guard lives here
        ├── spec.yml            ← /api/protegida is ALSO an endpoint (optional)
        ├── usuarios/
        │   └── spec.yml        ← inherits auth from protegida
        └── [id]/
            └── spec.yml        ← path segment ":id" (dynamic)
```

### Folder-name conventions

| Folder | Means | mock-fast `url` | Notes |
|---|---|---|---|
| `usuarios/` | literal segment | `/usuarios` | — |
| `[id]/` | dynamic param | `:id` | read as `{{params.id}}` |
| `[...rest]/` | catch-all (matches remaining path) | `*` | read as `{{params.[0]}}`; **emit last** (more specific routes win) |
| `[[...rest]]/` | **optional** catch-all (matches the base path **and** any subpath) | `/base` + `/base/*` (**two** routes) | mock-fast can't do both in one route; emit the base node and a `/*` node sharing the same response. Both **last**. |
| `(grupo)/` | route **group**: shares config with children but adds **no** URL segment | — | for "protect several routes that share no common prefix" |
| `_privado/` | **ignored** by routing (shared fixtures, fragments, docs) | — | not an endpoint |

### The folder name IS the segment (Next.js style); files are optional

- The **folder name** determines the URL segment automatically: `usuarios/`→`/usuarios`, `[id]/`→`/:id`, `[...rest]/`→`/*`, `(grupo)/`→nothing. No file is needed just to add a segment.
- A folder with **neither** `spec.yml` nor `_group.yml` is a pure organizational namespace (it only contributes its segment).

### Reserved files in a folder

- **`spec.yml`** — this folder **is** an endpoint (the "page"). There is **no `path` field** — the URL is the folder path. `auth` is optional (defaults to the inherited value; set it only to **override**). A folder may have both a `spec.yml` and child folders (a node that responds *and* has children).
- **`_group.yml`** — attaches **shared config** to this folder's subtree (the "layout"): `auth`, `behavior`, `headers`. **No `cases`, no `path`.** Add it only when there's something to share (e.g. the auth guard); a plain folder doesn't need one.

### Inheritance rules (mirror mock-fast)

- **URL**: effective URL = the folder-name segments of every ancestor joined with this node's. A `(grupo)/` folder contributes **no** segment.
- **`auth` / `behavior` / `headers`**: inherit from the nearest ancestor `_group.yml`; a child **overrides** per key. `auth: none` on a child disables an inherited guard (like `requireAuth: false`).
- In the **review**, always surface what a node *inherits* ("`/api/protegida/usuarios` inherits `auth: bearer` from `protegida`") so the user never has to trace the chain by hand.

### Generation, reverse, and moving

- **Generate**: nested folders → nested `routes[]`, with the parent node carrying the shared `extensions` (more faithful than the flat output, which repeats `auth` on every route). Catch-all (`[...rest]`) and any `/*` fallback are emitted **last**.
- **Reverse**: **preserve the tree** (don't flatten). A namespace node → a `_group.yml`; `:id` → `[id]/`; `*` → `[...rest]/`; a no-URL grouping → `(grupo)/`. A base route `/x` **plus** a sibling `/x/*` with the same response → collapse to one `[[...rest]]/` (optional catch-all).
- **Move / add / remove** a folder = move/add/remove the route; recompute the inherited URL + `auth`, then regenerate `mock-fast.json`. Moving a folder **out** of a protected parent means it stops inheriting the token — exactly the intent. Structural moves go through the review checkpoint (user-directed, one direction per change).

### Caveats (verified against the engine)

- Catch-all uses the **star** form (`/files/*`, `/*`) — the regex form `/(.*)` is **not** reliable; don't emit it.
- A single `*` route matches subpaths but **not** the base (`/shop/*` ✓ `/shop/a` ✗ `/shop`). The **optional** catch-all (`[[...rest]]`) therefore needs **two** routes — `/shop` and `/shop/*` — sharing the same response. (Verified: both return 200.)
- The wildcard value reads with **bracket** syntax: `{{params.[0]}}` (a bare `{{params.0}}` renders literally — same gotcha as array indexes).
- `(grupo)` and `_privado` are **api-spec organizational** ideas; they don't survive into `mock-fast.json` as folders — they only affect how routes/extensions are grouped and which paths are emitted.
- ASP.NET-style **typed constraints** (`[id:int]`, `{id:guid}`) are **documentation only** — mock-fast does **not** enforce them. Record them in `notes`/`request_constraints`, never claim the mock validates the type.

## `spec.yml` schema

| Field | Type | Required | Maps to (mock-fast) |
|---|---|---|---|
| `description` | string | no | comment only |
| `method` | `GET\|POST\|PUT\|PATCH\|DELETE` | yes | route `method` |
| `auth` | `none\|bearer` | yes* | `extensions.requireAuth` (`bearer`→`true`) |
| `headers` | `map<string,string>` | no | route `headers` |
| `cases` | `map<variant, case>` | yes | `response` or `responses[]` |
| `behavior` | `map` | no | `extensions` (see below) |
| `dynamic` | `map<dotpath, handlebars>` | no | templating on the chosen response body |
| `request_constraints` | `list<string>` | no | doc only (static rules) |
| `notes` | `list<string>` | no | doc only (shape facts) |

There is **no `path` field**: the route `url` is the **folder path** (one rule, like Next.js). `*auth` is required only when there's no ancestor to inherit it from; under a subtree it defaults to the inherited value.

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

`api-spec/algo/spec.yml` (the folder `algo/` is the URL `/algo`):

```yaml
method: GET
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
2. **Infer** `spec.yml` using the rules below. The **URL comes from the folder path** the user placed the files in (no `path` field). `method` is not in the body — infer it (POST/PUT/PATCH if there's a request body, else GET) or ask. For anything else not derivable, insert a `TODO` and ask rather than guessing.
3. **Write the draft `spec.yml`**, then **STOP**. Summarize: the cases you found, the `match` selectors you chose and why, the fields you flagged nullable, and every open question. Do **not** touch `mock-fast.json`.
4. User edits the `spec.yml` and/or replies "procedé".
5. **Phase 2:** generate the route, **merge** it into `mock-fast.json` (add, or replace the route with the same `method`+`url`; preserve everything else), validate against mock-fast's DSL rules, report.

### Mode B — modified endpoint

Trigger: *"modifiqué la ruta /autenticacion"* or the user edited a `response-*.json`.

1. **Locate** the endpoint folder, its existing `spec.yml`, and the current route in `mock-fast.json`.
2. **Diff** the on-disk `.json` against what `spec.yml` / `mock-fast.json` currently encode. Detect: new/removed/renamed fields, changed `status`, a new variant file, changed selector values, nullability flips, a new error case.
3. **Summarize the delta in plain words**, update `spec.yml` (including its `notes`), then **STOP** for review. Do **not** touch `mock-fast.json` yet.
4. On approval, **regenerate just that route** in `mock-fast.json` and report.

### Mode C — import / reverse (existing `mock-fast.json` → `api-spec/`)

Trigger: *"ya tengo un mock-fast.json, generame el api-spec"* / *"convertí mi mock existente en specs"* / *"importá / hacé reverse"*. This is the **inverse** of phases 1–2: the mock already exists; you bootstrap the source-of-truth layer **from** it.

**When this is allowed (see _The JSON is the hub_):** reverse is **user-directed**, never automatic. Run it when the user declares the change started on the `mock-fast.json` side — e.g. *"I added/edited this endpoint in the mock, now generate/update its JSON"* — or asks to bootstrap a whole tree that has no `api-spec/` yet. Don't reverse on your own initiative just because you noticed the mock changed; wait for the user to point the direction. If reverse would **overwrite** existing JSON that the user didn't say to replace, confirm first (it's their hub — don't clobber it silently). Adding a *missing* fixture is always fine (see **Filling gaps**).

**Filling gaps (non-destructive):** a narrower, always-allowed use of reverse — when `api-spec/` exists but a fixture is **missing** (a `case` references a `request-*.json`/`response-*.json` that isn't on disk) and the data **is** present in `mock-fast.json`, generate the missing file from the mock. This only *adds* what's absent; it never overwrites a fixture that already exists. The api-spec and the mock are complementary: if one side has data the other lacks, derive it rather than asking the user to retype it.

1. **Read** the existing `mock-fast.json` and flatten its route tree (resolve URL concatenation and inherited `extensions`/`headers`, exactly as the mock engine does — a child of a `requireAuth` parent is `auth: bearer`).
2. For **each route that registers an endpoint** (has `response` or `responses`; pure namespace nodes are skipped), create `api-spec/<endpoint>/` and reverse-map it to a `spec.yml` + fixture files using the **Reverse rules** below.
3. **Stop for review.** This is a **draft**: templated fields were **materialized** to representative sample values (not real captures), so flag them for confirmation. Present the tree you'd create (folders, files, open questions). Do **not** overwrite an existing `api-spec/<endpoint>/` without saying so.
4. On approval, **write** the `api-spec/` tree. From here the forward flow (Modes A/B) takes over: the user edits captures and re-syncs.

> Import produces a **seed** spec, not ground truth. A `mock-fast.json` body like `"{{faker 'person.firstName'}}"` has no real captured value — **materialize** it to a concrete sample in the fixture, lift the expression into `dynamic`, and note that the value should be replaced with a real capture. The fixture never holds Handlebars. Never present a reverse-import as if it were observed traffic.

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
| the **URL** | comes from the **folder path** (no `path` field); `method` not in body → infer (body present → POST) or ask |
| a `timestamp`/`token`/uuid-looking field | propose it under `dynamic` (`{{now}}` / `{{uuid}}`) in the review summary |

When picking `match` selectors, choose the **fewest fields that uniquely separate the cases** — usually the discriminator plus the credential fields that distinguish success from the fallback. More keys = stricter AND.

## Translation rules (approved spec.yml → mock-fast.json)

- **One case, no `match`** → the route uses a single `response`.
- **Multiple cases** → the route uses `responses[]`. Each `match` becomes a `when`; a case **without** `match` becomes the trailing entry **without** `when` (the fallback). Order: all `match` cases first, fallback last. (mock-fast returns the **first** match; if every entry had a `when` and none matched the client gets a 404 — that's why the fallback must be present and last.)
- `auth: bearer` → `extensions.requireAuth: true`.
- `behavior.latency_ms` → `delayRange`; `behavior.error_rate` → `errorRate`; `behavior.rate_limit` → `rateLimit` (`by`→`identifier`, `window`/`max`/`per_user`→`perUser`/`on_limit`→`onLimit`).
- `dynamic` → splice each Handlebars expression into the response body at its dotted path before emitting.
- **Parity (strict):** the emitted `body` must EQUAL the fixture `.json` with **only** the `dynamic` paths substituted. Copy it **verbatim** — never trim, reorder, rename, or "simplify" fields. If `body` and the fixture diverge in any non-`dynamic` field, that's a bug.
- **Never emit an `id`.** The route's identity is its **path** (Next.js style); mock-fast auto-derives the id from `method`+`url`. One less knob to set and keep in sync.
- **folder path** → route `url` (segments concatenated down the tree). Create an intermediate route node only when it carries shared `extensions` or groups 2+ children; otherwise collapse the segments into one node's `url`.

## Reverse rules (existing `mock-fast.json` → spec.yml + fixtures) — Mode C

The mirror of the translation table. Work on the **flattened** route (parent URL and inherited extensions already resolved).

| In `mock-fast.json` | Reverse to |
|---|---|
| route `method` + resolved `url` | `method` + the **folder path** (each URL segment a folder; no `path` field) |
| `extensions.requireAuth: true` (own or inherited) | `auth: bearer`; absent/`false` → `auth: none` |
| `extensions.delayRange` / `errorRate` / `rateLimit` | `behavior.latency_ms` / `error_rate` / `rate_limit` |
| single `response` | one `case` `ok`; `response.body` → `response-<status>.json`; `status` from `response.status` |
| `responses[]` entry **with** `when` | a `case` with `match` = the `when`; `body` → `response-<code>-<variant>.json` |
| `responses[]` entry **without** `when` | the **fallback** `case` (no `match`, ordered last) |
| a `when` made of `body.*` keys | synthesize `request-<variant>.json` by un-flattening those dotted paths (`body.usuario`→`{usuario:...}`); `query.*`/`headers.*`/`params.*`/`token.*` matchers go in `notes`, not the request body |
| a numeric segment in a path (`body.aplicaciones.0`) | un-flatten it into an **array**: `body.aplicaciones.0: "VS"` → `{ aplicaciones: ["VS"] }`. The `.N` proves the field is a list. |
| a **bare** primitive matcher (`body.aplicaciones: "VS"`) | **ambiguous** — mock-fast matches a primitive against either a scalar OR any array element, so the field could be `"VS"` **or** `["VS"]`. Still **generate** the fixture (default to the scalar), but **flag it**: "`aplicaciones` could be an array — confirm." Never drop the field, and never claim certainty. |
| a body field whose value is a Handlebars expression (`{{now}}`, `{{uuid}}`, `{{faker ...}}`, `{{body.x}}`) | **Never copy the expression into the fixture** — templating is mock-server logic, not contract data. **Materialize** it to a concrete representative value in the fixture, and record the expression in `spec.yml` → `dynamic` (path → expression). See materialization rules below. |
| route `headers` (resolved) | `headers` |
| route's last URL segment | the `<endpoint>` folder name (no `id` exists — the path is the identity) |

**Variant naming** (no filenames exist to copy from): single response → `ok`; for `responses[]`, name 2xx entries by the distinguishing `when` field/value (or `ok1`, `ok2`), and name the fallback / error entries by status (`401`→`unauthorized`, `403`→`forbidden`, `404`→`not_found`, `409`→`conflict`, `422`→`unprocessable`, `423`→`locked`, else `error<code>`). Keep names stable so a later re-import is a clean diff.

### Materialization (templating → concrete fixture value)

**No Handlebars ever lands in an api-spec `.json`.** A fixture is observed/contract data; templating is mock-server logic. When reverse-generating a fixture from a templated mock field, write a **concrete, representative** value and move the expression to `spec.yml` → `dynamic`:

| Mock field value | Fixture value (concrete) | `dynamic` entry |
|---|---|---|
| `{{faker 'string.alphanumeric' length=120}}` | a real-looking 120-char alphanumeric string | `"<path>": "{{faker 'string.alphanumeric' length=120}}"` |
| `{{faker 'person.firstName'}}` | a plausible name, e.g. `"Juan"` | the faker expression |
| `{{uuid}}` | a sample UUID, e.g. `"3f2504e0-4f89-41d3-9a0c-0305e82c3301"` | `{{uuid}}` |
| `{{now}}` | a concrete ISO timestamp | `{{now}}` |
| `{{body.x}}` / `{{params.x}}` (echo) | the **same value** the synthesized request/params hold (so request and response agree) | the echo expression |

The fixture value is a **representative sample, not a real capture** — note that in the review so the user can replace it with a true capture. The round-trip is clean: forward generation re-reads `dynamic` and puts the expression back into `mock-fast.json`, while the `.json` stays plain data.

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
| the URL has a path param (an `[id]/` folder → `:id`) and no `404` case | `404 not_found` for an unknown id |
| `auth: bearer` but no `401` case captured | `401 unauthorized` with the API's real body (mock-fast's `requireAuth` returns a *generic* 401 — capture the real shape if it differs) |
| `POST`/`PUT`/`PATCH` with a request body and no `400`/`422` case | `400`/`422` for malformed or missing required fields |
| only success cases, **no fallback** (`match`-less case) | a fallback — otherwise any non-matching request gets mock-fast's generic `404 "No response matched"`, not your shape |
| `behavior.rate_limit` set but no `429`/`423` case captured | document the limit response (`on_limit`) shape so it's deliberate, not the default |
| a create (`POST`) of a unique resource, no `409` | `409 conflict` for duplicates (lower confidence — flag, don't push) |
| validation rules in `request_constraints` but no error case for violating them | an error case (usually `400`/`422`) exercising that constraint |

Frame each as "el mock hoy no maneja X — ¿lo agrego?" and note whether mock-fast already covers it with a **default** (auth → generic 401; no-match → generic 404) vs needing a **real captured shape**. The point is deliberate coverage of the real contract, not a generic placeholder.

## Worked example — `autenticacion` (real, end to end)

**Captured input** (`api-spec/autenticacion-mobile-service/autenticacion/` — the folder path is the URL): two requests differing only in `totp` (`null` vs `"123456"`), two `200` responses, one `401`.

**Phase 1 — inferred `spec.yml`:**

```yaml
description: Login con flujo de 2 pasos sobre la misma URL.
# URL = folder path → /autenticacion-mobile-service/autenticacion
method: POST
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

*Review summary you'd present:* 3 cases; `match` separates step1/step2 by `body.totp`; `unauthorized` is the fallback (the matcher can't express "invalid", so anything not matching the two success selectors returns 401); `timestamp`/`token` proposed as dynamic; `roles`/`perfilesDetails` flagged null. **Open question:** confirm the folder URL / `method` and the 401 shape.

**Phase 2 — generated route in `mock-fast.json`** (after approval):

```json
{
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
5. Did you take the **URL from the folder path** (no `path` field), infer/confirm `method`, and **ask** about `auth` when unclear instead of guessing?
6. Did you surface every **matcher limitation** that bit (negation / exists / two distinct errors) in the review summary?
7. On modify: did you **diff** and summarize the delta before editing the spec?
8. Did you propose `dynamic` for timestamps/tokens, and verify each dotted path exists in the response body?
9. Did the generated DSL validate against the `mock-fast` rules (no `response`+`responses` together, fallback present, lowercase header matchers)?
10. On import (Mode C): did you **flatten** inherited URL/extensions first, label the result a **draft/seed**, lift every templated field into `dynamic` with a "replace with real capture" note, and refuse to overwrite an existing `api-spec/<endpoint>/` silently?
11. Did you run the **coverage gap analysis** in the review summary (missing 404 on `:id` routes, 400/422 on body endpoints, an explicit fallback, etc.) — as suggestions the user confirms, never auto-added?

## Staying in sync with the installed library

This skill is **versioned to match** `@killki/mock-fast` (see **Skill version** at the top). A skill file is a *copy* in the project, so it can fall behind the installed package after an upgrade. When you use this skill, do a quick, **soft** check:

1. Read the installed version from `node_modules/@killki/mock-fast/package.json` (or `npm ls @killki/mock-fast`).
2. Compare it to this file's **Skill version**.
3. If the library is **newer**, tell the user the skill copy is outdated and suggest refreshing it — copy `node_modules/@killki/mock-fast/dist/mock-fast-spec/SKILL.md` over the project's `mock-fast-spec` skill file (e.g. `.claude/skills/mock-fast-spec/SKILL.md`).

It's a one-time suggestion, never a blocker. If the version reads `0.0.0-dev`, this is an unbuilt source copy — ignore the check.
