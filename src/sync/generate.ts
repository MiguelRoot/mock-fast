import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";

import { parse as parseYaml } from "yaml";

import { dslDocument } from "../schema.js";

/** Thrown on any deterministic-sync failure. Carries a human-readable, fixable message. */
export class SyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncError";
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
    throw new SyncError(`Invalid YAML in ${file}: ${(e as Error).message}`);
  }
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
  if (!c?.response) throw new SyncError(`a case in ${path.join(dir, "spec.yml")} is missing 'response'`);
  const f = path.join(dir, c.response);
  if (!existsSync(f)) throw new SyncError(`fixture not found: ${f}`);
  let body: any;
  try {
    body = JSON.parse(readFileSync(f, "utf8"));
  } catch (e) {
    throw new SyncError(`invalid JSON in ${f}: ${(e as Error).message}`);
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
  const cases = spec.cases;
  if (!cases || typeof cases !== "object")
    throw new SyncError(`${path.join(dir, "spec.yml")} has no 'cases'`);
  const entries = Object.entries(cases) as [string, any][];
  if (!entries.length) throw new SyncError(`${path.join(dir, "spec.yml")} has empty 'cases'`);

  const withMatch = entries.filter(([, c]) => c.match);
  const fallbacks = entries.filter(([, c]) => !c.match);
  if (fallbacks.length > 1)
    throw new SyncError(
      `${path.join(dir, "spec.yml")} has ${fallbacks.length} fallback cases (no 'match'); only one is allowed`
    );

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
    if (!applied.has(p)) throw new SyncError(`dynamic path "${p}" not found in any case of ${path.join(dir, "spec.yml")}`);
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
  if (spec) out.push(endpoint(url, dir, spec, merge(here, ctxFrom(spec))));
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
  if (!existsSync(apiSpecDir)) throw new SyncError(`api-spec dir not found: ${apiSpecDir}`);

  const rootGroup = readGroup(apiSpecDir);
  const out: any[] = [];
  visitChildren(apiSpecDir, "", rootGroup ? ctxFrom(rootGroup) : EMPTY, out);

  // catch-all routes go last so specific routes win first-match
  const routes = [...out.filter((r) => !r.url.includes("*")), ...out.filter((r) => r.url.includes("*"))];
  const dsl = { routes };

  const res = dslDocument.safeParse(dsl);
  if (!res.success) {
    const lines = res.error.errors.map((e) => `  ${e.path.join(".") || "<root>"}: ${e.message}`);
    throw new SyncError(`generated DSL failed validation:\n${lines.join("\n")}`);
  }
  return dsl;
}
