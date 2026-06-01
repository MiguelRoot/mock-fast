import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";

import { stringify as stringifyYaml } from "yaml";

import { loadDsl } from "../loader.js";
import { SyncError } from "./generate.js";

/** A templated field detected in a response body: dotted path + the Handlebars expression. */
interface DynEntry {
  path: string;
  expr: string;
}

const HBS = /\{\{.*?\}\}/;

/** Walks a value; for every string that is a Handlebars expression, records its path and
 *  replaces it in-place with a concrete, representative sample (so the fixture holds data, not templating). */
function materialize(value: any, base: string, dyn: DynEntry[]): any {
  if (typeof value === "string") {
    if (HBS.test(value)) {
      dyn.push({ path: base, expr: value });
      return sampleFor(value);
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v, i) => materialize(v, base ? `${base}.${i}` : String(i), dyn));
  if (value && typeof value === "object") {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) out[k] = materialize(v, base ? `${base}.${k}` : k, dyn);
    return out;
  }
  return value;
}

/** A concrete sample value for a templated string (best-effort; flagged for real capture). */
function sampleFor(expr: string): unknown {
  if (/\{\{\s*now\s*\}\}/.test(expr)) return "2026-01-01T00:00:00.000Z";
  if (/\{\{\s*uuid\s*\}\}/.test(expr)) return "00000000-0000-4000-8000-000000000000";
  if (/faker\s+'number|randomInt/.test(expr)) return 0;
  // token-ish / generic string
  if (/token/i.test(expr)) return "sample-token-replace-with-real-capture";
  return "sample-replace-with-real-capture";
}

/** mock-fast url segment → api-spec folder name (inverse of generate's `segment`). */
function urlToFolders(url: string): string[] {
  return url
    .split("/")
    .filter(Boolean)
    .map((seg) => {
      if (seg === "*") return "[...rest]";
      if (seg.startsWith(":")) return `[${seg.slice(1)}]`;
      return seg;
    });
}

/** mock-fast extensions → spec.yml `auth` + `behavior`. */
function extToSpec(ext: any): { auth?: string; behavior?: any } {
  const out: { auth?: string; behavior?: any } = {};
  if (ext?.requireAuth === true) out.auth = "bearer";
  else if (ext?.requireAuth === false) out.auth = "none";

  const behavior: any = {};
  if (ext?.delayRange) behavior.latency_ms = ext.delayRange;
  if (ext?.errorRate != null) behavior.error_rate = ext.errorRate;
  if (ext?.rateLimit) {
    const r = ext.rateLimit;
    const rl: any = {};
    if (r.identifier != null) rl.by = r.identifier;
    if (r.window != null) rl.window = r.window;
    if (r.max != null) rl.max = r.max;
    if (r.perUser) rl.per_user = r.perUser;
    if (r.onLimit) rl.on_limit = r.onLimit;
    behavior.rate_limit = rl;
  }
  if (Object.keys(behavior).length) out.behavior = behavior;
  return out;
}

/** Status code → a stable variant name (mirrors the skill's naming table). */
/** Filename for the Nth response of a given status: response-404.json, response-404-v2.json, ... */
function responseFile(status: number, nth: number): string {
  return nth === 0 ? `response-${status}.json` : `response-${status}-v${nth + 1}.json`;
}

/** Case key for the Nth response of a given status: s404, s404_v2, ... (YAML keys can't start with a digit). */
function caseKey(status: number, nth: number): string {
  return nth === 0 ? `s${status}` : `s${status}_v${nth + 1}`;
}

interface ReverseResult {
  folders: number;
  files: string[];
  notes: string[];
}

/**
 * Deterministically regenerates an `api-spec/` tree from a `mock-fast.json` DSL.
 * Produces folders + spec.yml + response-*.json (templating materialized to samples,
 * lifted into `dynamic`). It's a SEED, not captured truth — see the returned notes.
 */
export async function reverseToApiSpec(
  dslFile: string,
  apiSpecDir: string,
  opts: { force?: boolean } = {}
): Promise<ReverseResult> {
  if (!existsSync(dslFile))
    throw new SyncError({
      kind: "no-api-spec",
      where: dslFile,
      problem: "mock-fast.json not found to reverse from",
      suggestion: "Point --file at an existing mock-fast.json.",
    });

  if (existsSync(apiSpecDir) && !opts.force)
    throw new SyncError({
      kind: "schema",
      where: apiSpecDir,
      problem: "api-spec/ already exists",
      suggestion: "Re-run with --force to overwrite it (this replaces your source of truth).",
    });

  const dsl = await loadDsl(dslFile); // validates + flattens-by-reading the tree

  // Flatten the route tree into endpoints with resolved url + inherited extensions/headers.
  interface Flat {
    url: string;
    method: string;
    ext: any;
    headers: any;
    response?: any;
    responses?: any[];
  }
  const flat: Flat[] = [];
  const walk = (nodes: any[], parentUrl: string, ext: any, headers: any) => {
    for (const n of nodes) {
      const url = joinUrl(parentUrl, n.url ?? "");
      const e = { ...ext, ...(n.extensions ?? {}) };
      const h = { ...headers, ...(n.headers ?? {}) };
      if (n.response || n.responses) flat.push({ url, method: n.method ?? "get", ext: e, headers: h, response: n.response, responses: n.responses });
      if (n.routes?.length) walk(n.routes, url, e, h);
    }
  };
  walk((dsl as any).routes ?? [], "", {}, {});

  if (opts.force && existsSync(apiSpecDir)) rmSync(apiSpecDir, { recursive: true, force: true });

  const files: string[] = [];
  const notes: string[] = [];
  const folderSet = new Set<string>();

  // Collapse the optional-catch-all pair (/x and /x/*) back into one [[...rest]] later if both exist.
  for (const ep of flat) {
    const folders = urlToFolders(ep.url);
    const dir = path.join(apiSpecDir, ...folders);
    mkdirSync(dir, { recursive: true });
    folderSet.add(dir);

    const spec: any = { method: String(ep.method).toUpperCase() };
    const es = extToSpec(ep.ext);
    if (es.auth) spec.auth = es.auth;
    if (es.behavior) spec.behavior = es.behavior;
    if (Object.keys(ep.headers).length) spec.headers = ep.headers;

    const cases: Record<string, any> = {};
    const dynAll = new Map<string, string>(); // path → expr, merged across cases
    const seenByStatus = new Map<number, number>(); // status → how many seen so far

    const list = ep.responses ?? [{ status: ep.response.status, body: ep.response.body, when: undefined }];
    list.forEach((r: any) => {
      const status = r.status ?? 200;
      const nth = seenByStatus.get(status) ?? 0;
      seenByStatus.set(status, nth + 1);
      const file = responseFile(status, nth);
      const key = caseKey(status, nth);

      const dyn: DynEntry[] = [];
      const body = materialize(r.body ?? {}, "", dyn);
      writeFileSync(path.join(dir, file), JSON.stringify(body, null, 2) + "\n");
      files.push(path.join(...folders, file));
      for (const d of dyn) dynAll.set(d.path, d.expr);

      const c: any = {};
      if (r.when) c.match = r.when;
      c.response = file;
      c.status = status;
      cases[key] = c;
    });

    spec.cases = cases;
    if (dynAll.size) spec.dynamic = Object.fromEntries(dynAll);

    const header =
      `# Generated by \`mock-fast sync --from-mock\` — SEED, not captured truth.\n` +
      `# Templated values were materialized to samples; replace with real captures.\n`;
    writeFileSync(path.join(dir, "spec.yml"), header + stringifyYaml(spec));
    files.push(path.join(...folders, "spec.yml"));
    if (dynAll.size) notes.push(`${ep.url}: ${dynAll.size} dynamic field(s) materialized to samples — confirm/replace`);
  }

  return { folders: folderSet.size, files, notes };
}

function joinUrl(a: string, b: string): string {
  const j = `${a}/${b}`.replace(/\/+/g, "/");
  return j.length > 1 && j.endsWith("/") ? j.slice(0, -1) : j;
}
