import type { FilterConfig } from "./types.js";
import type { TemplateContext } from "./templating.js";

/** Reads a dotted path from an object (e.g. "data" or "result.items"). */
function getPath(obj: unknown, dotted: string): unknown {
  return dotted.split(".").reduce<unknown>((acc, key) => {
    if (acc != null && typeof acc === "object") return (acc as Record<string, unknown>)[key];
    return undefined;
  }, obj);
}

/** Writes a value at a dotted path, mutating `obj` in place. */
function setPath(obj: Record<string, unknown>, dotted: string, value: unknown): void {
  const keys = dotted.split(".");
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i]!;
    if (cur[k] == null || typeof cur[k] !== "object") cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]!] = value;
}

function matches(fieldValue: unknown, term: string, op: string, caseSensitive: boolean): boolean {
  if (fieldValue == null) return false;
  let a = String(fieldValue);
  let b = term;
  if (!caseSensitive) {
    a = a.toLowerCase();
    b = b.toLowerCase();
  }
  switch (op) {
    case "equals":
      return a === b;
    case "startsWith":
      return a.startsWith(b);
    case "contains":
    default:
      return a.includes(b);
  }
}

/**
 * Applies a `filter` to an already-rendered response body: keeps only the items of
 * `cfg.in` whose `cfg.fields` match the search term at `cfg.by`. Non-mutating on the
 * source — returns a new body. If the term is empty/missing, the array is returned
 * unchanged (no filter). If `cfg.in` isn't an array, the body is returned untouched.
 */
export function applyFilter(
  body: unknown,
  cfg: FilterConfig,
  templateCtx: TemplateContext
): unknown {
  if (body == null || typeof body !== "object") return body;

  const arr = getPath(body, cfg.in);
  if (!Array.isArray(arr)) return body;

  const term = getPath(templateCtx, cfg.by);
  // empty / missing search term → no filtering (return everything)
  if (term == null || String(term).trim() === "") return body;

  const op = cfg.op ?? "contains";
  const caseSensitive = cfg.caseSensitive ?? false;
  const termStr = String(term);

  const filtered = arr.filter((item) =>
    cfg.fields.some((f) => matches(getPath(item, f), termStr, op, caseSensitive))
  );

  const clone = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
  setPath(clone, cfg.in, filtered);
  return clone;
}
