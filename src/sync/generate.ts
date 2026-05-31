import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";

import { parse as parseYaml } from "yaml";

import { dslDocument } from "../schema.js";

/** Structured, AI-friendly detail about a sync failure (also written to the error file). */
export interface SyncErrorDetail {
  kind:
    | "missing-bridge" // a folder has fixtures but no spec.yml (the bridge)
    | "invalid-yaml"
    | "invalid-json"
    | "schema"
    | "fixture-missing"
    | "dynamic-path"
    | "bad-cases"
    | "no-api-spec";
  /** Folder or file the problem is about, relative-friendly. */
  where: string;
  /** What's missing/wrong, in plain words. */
  problem: string;
  /** Concrete next step the AI (or user) should take. */
  suggestion?: string;
}

/** Thrown on any deterministic-sync failure. Carries a human-readable, fixable message + structured detail. */
export class SyncError extends Error {
  detail: SyncErrorDetail;
  constructor(detail: SyncErrorDetail) {
    super(`${detail.problem} (${detail.where})${detail.suggestion ? `\n  → ${detail.suggestion}` : ""}`);
    this.name = "SyncError";
    this.detail = detail;
  }
}

interface Ctx {
  ext: Record<string, unknown>;
  headers: Record<string, string>;
}

const EMPTY: Ctx = { ext: {}, headers: {} };

/** Maps a spec.yml / _group.yml's auth+behavior+headers into mock-fast extensions. */
function ctxFrom(src: any): Ctx {
  const ext: Record<string, unknown> = {};
  if (src?.auth === "bearer") ext.requireAuth = true;
  else if (src?.auth === "none") ext.requireAuth = false;

  const b = src?.behavior;
  if (b) {
    if (b.latency_ms) ext.delayRange = b.latency_ms;
    if (b.error_rate != null) ext.errorRate = b.error_rate;
    if (b.rate_limit) {
      const r = b.rate_limit;
      const rl: Record<string, unknown> = {};
      if (r.by != null) rl.identifier = r.by;
      if (r.window != null) rl.window = r.window;
      if (r.max != null) rl.max = r.max;
      if (r.per_user) rl.perUser = r.per_user;
      if (r.on_limit) rl.onLimit = r.on_limit;
      ext.rateLimit = rl;
    }
  }
  return { ext, headers: src?.headers ?? {} };
}

/** Child overrides parent per key. */
function merge(parent: Ctx, child: Ctx): Ctx {
  return {
    ext: { ...parent.ext, ...child.ext },
    headers: { ...parent.headers, ...child.headers },
  };
}

function readYaml(file: string): any {
  try {
    return parseYaml(readFileSync(file, "utf8")) ?? {};
  } catch (e) {
    throw new SyncError({
      kind: "invalid-yaml",
      where: file,
      problem: `Invalid YAML: ${(e as Error).message.split("\n")[0]}`,
      suggestion: "Fix the YAML syntax (a colon in a value usually needs quotes).",
    });
  }
}

/** True if a folder holds response fixtures (so it's meant to be an endpoint). */
function hasFixtures(dir: string): boolean {
  return readdirSync(dir).some((f) => /^response.*\.json$/i.test(f));
}

const readSpec = (dir: string) => {
  const f = path.join(dir, "spec.yml");
  return existsSync(f) ? readYaml(f) : null;
};
const readGroup = (dir: string) => {
  const f = path.join(dir, "_group.yml");
  return existsSync(f) ? readYaml(f) : null;
};

const subdirs = (dir: string) =>
  readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

const isGroup = (n: string) => /^\(.+\)$/.test(n);
const isOptionalCatchAll = (n: string) => /^\[\[\.\.\..+\]\]$/.test(n);

/** Folder name → URL segment. `[id]`→`/:id`, `[...x]`→`/*`, literal→`/name`. */
function segment(name: string): string {
  if (/^\[\.\.\..+\]$/.test(name)) return "/*";
  const m = /^\[([^\]]+)\]$/.exec(name);
  if (m) return "/:" + m[1]!.split(":")[0]; // drop a `:int`-style constraint (doc only)
  return "/" + name;
}

/** Writes `value` at the dotted path if it exists (numeric segments index arrays). Returns true if set. */
function setPathIfExists(obj: any, dotted: string, value: unknown): boolean {
  const keys = dotted.split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur == null || typeof cur !== "object" || !(keys[i]! in cur)) return false;
    cur = cur[keys[i]!];
  }
  const last = keys[keys.length - 1]!;
  if (cur == null || typeof cur !== "object" || !(last in cur)) return false;
  cur[last] = value;
  return true;
}

/** Loads a case's response fixture verbatim, then applies the `dynamic` paths that exist in it. */
function loadBody(dir: string, spec: any, c: any, applied: Set<string>): any {
  if (!c?.response)
    throw new SyncError({
      kind: "bad-cases",
      where: path.join(dir, "spec.yml"),
      problem: "a case is missing 'response'",
      suggestion: "Each case needs a 'response: <file>.json' pointing to a fixture.",
    });
  const f = path.join(dir, c.response);
  if (!existsSync(f))
    throw new SyncError({
      kind: "fixture-missing",
      where: f,
      problem: "response fixture not found",
      suggestion: `Create ${path.basename(f)} in ${dir}, or fix the 'response' filename.`,
    });
  let body: any;
  try {
    body = JSON.parse(readFileSync(f, "utf8"));
  } catch (e) {
    throw new SyncError({
      kind: "invalid-json",
      where: f,
      problem: `invalid JSON: ${(e as Error).message}`,
      suggestion: "Fix the JSON syntax in this fixture.",
    });
  }
  // dynamic is spec-level; each case has its own shape, so a path may exist in
  // only some cases. Apply where present; flag below if it matched no case at all.
  for (const [p, expr] of Object.entries(spec.dynamic ?? {})) {
    if (setPathIfExists(body, p, expr)) applied.add(p);
  }
  return body;
}

/** Builds `response` (single) or `responses[]` (conditional + fallback) from the cases. */
function buildResponses(dir: string, spec: any): Record<string, unknown> {
  const specFile = path.join(dir, "spec.yml");
  const cases = spec.cases;
  if (!cases || typeof cases !== "object")
    throw new SyncError({
      kind: "bad-cases",
      where: specFile,
      problem: "spec has no 'cases'",
      suggestion: "Add a 'cases:' map with at least one case (a 'response' + 'status').",
    });
  const entries = Object.entries(cases) as [string, any][];
  if (!entries.length)
    throw new SyncError({
      kind: "bad-cases",
      where: specFile,
      problem: "'cases' is empty",
      suggestion: "Add at least one case under 'cases:'.",
    });

  const withMatch = entries.filter(([, c]) => c.match);
  const fallbacks = entries.filter(([, c]) => !c.match);
  if (fallbacks.length > 1)
    throw new SyncError({
      kind: "bad-cases",
      where: specFile,
      problem: `${fallbacks.length} fallback cases (no 'match'); only one is allowed`,
      suggestion: "Give all but one case a 'match'; the single match-less case is the fallback (ordered last).",
    });

  const applied = new Set<string>();
  let result: Record<string, unknown>;

  if (entries.length === 1 && fallbacks.length === 1) {
    const c = fallbacks[0]![1];
    result = { response: { status: c.status ?? 200, body: loadBody(dir, spec, c, applied) } };
  } else {
    const responses = [...withMatch, ...fallbacks].map(([, c]) => {
      const r: Record<string, unknown> = {};
      if (c.match) r.when = c.match;
      r.status = c.status ?? 200;
      r.body = loadBody(dir, spec, c, applied);
      return r;
    });
    result = { responses };
  }

  // a dynamic key that matched no case's body is almost certainly a typo
  for (const p of Object.keys(spec.dynamic ?? {})) {
    if (!applied.has(p))
      throw new SyncError({
        kind: "dynamic-path",
        where: specFile,
        problem: `dynamic path "${p}" not found in any case's response body`,
        suggestion: "Fix the dotted path to match a field in one of the fixtures.",
      });
  }
  return result;
}

function endpoint(url: string, dir: string, spec: any, eff: Ctx): any {
  const node: any = { url, method: String(spec.method ?? "get").toLowerCase() };
  if (Object.keys(eff.headers).length) node.headers = eff.headers;
  if (Object.keys(eff.ext).length) node.extensions = eff.ext;
  Object.assign(node, buildResponses(dir, spec));
  return node;
}

function visitFolder(dir: string, parentUrl: string, inherited: Ctx, out: any[]) {
  const name = path.basename(dir);
  const group = readGroup(dir);
  const here = group ? merge(inherited, ctxFrom(group)) : inherited;

  if (isGroup(name)) {
    // route group: no URL segment, but its shared config flows to children
    visitChildren(dir, parentUrl, here, out);
    return;
  }

  if (isOptionalCatchAll(name)) {
    const spec = readSpec(dir);
    if (spec) {
      const eff = merge(here, ctxFrom(spec));
      out.push(endpoint(parentUrl, dir, spec, eff)); // base path
      out.push(endpoint(parentUrl + "/*", dir, spec, eff)); // + subpaths
    }
    visitChildren(dir, parentUrl, here, out);
    return;
  }

  const url = parentUrl + segment(name);
  const spec = readSpec(dir);
  if (spec) {
    out.push(endpoint(url, dir, spec, merge(here, ctxFrom(spec))));
  } else if (hasFixtures(dir)) {
    // The bridge is missing: raw JSON dropped in, but no spec.yml to turn it into
    // a route. This is the hand-off point — report exactly what the AI must create.
    throw new SyncError({
      kind: "missing-bridge",
      where: dir,
      problem: "this folder has response fixtures but no spec.yml (the bridge)",
      suggestion:
        "Create spec.yml here with: method, auth, and a 'cases' map pointing at the fixture(s). " +
        "A static JSON alone can't become a route — the spec adds the request match, auth, dynamic fields and behavior.",
    });
  }
  visitChildren(dir, url, here, out);
}

function visitChildren(dir: string, baseUrl: string, inherited: Ctx, out: any[]) {
  for (const name of subdirs(dir)) {
    if (name.startsWith("_")) continue; // _private folders are ignored by routing
    visitFolder(path.join(dir, name), baseUrl, inherited, out);
  }
}

/**
 * Deterministically generates a mock-fast DSL object from an `api-spec/` tree.
 * Throws SyncError (with a fixable message) on any problem; validates the result
 * against the DSL schema so it can never emit an invalid mock-fast.json.
 */
export function generateDsl(apiSpecDir: string): { routes: any[] } {
  if (!existsSync(apiSpecDir))
    throw new SyncError({
      kind: "no-api-spec",
      where: apiSpecDir,
      problem: "api-spec directory not found",
      suggestion: "Create an api-spec/ folder, or pass --dir <path>.",
    });

  const rootGroup = readGroup(apiSpecDir);
  const out: any[] = [];
  visitChildren(apiSpecDir, "", rootGroup ? ctxFrom(rootGroup) : EMPTY, out);

  // catch-all routes go last so specific routes win first-match
  const routes = [...out.filter((r) => !r.url.includes("*")), ...out.filter((r) => r.url.includes("*"))];
  const dsl = { routes };

  const res = dslDocument.safeParse(dsl);
  if (!res.success) {
    const lines = res.error.errors.map((e) => `  ${e.path.join(".") || "<root>"}: ${e.message}`);
    throw new SyncError({
      kind: "schema",
      where: apiSpecDir,
      problem: `generated DSL failed validation:\n${lines.join("\n")}`,
      suggestion: "Fix the offending spec field so the generated mock-fast.json is valid.",
    });
  }
  return dsl;
}
