import type { MatchableResponseDef, WhenClause, WhenValue } from "./types.js";
import type { TemplateContext } from "./templating.js";

export function getByPath(root: unknown, path: string): unknown {
  if (!path) return undefined;
  const segments = path.split(".");
  let cursor: unknown = root;
  for (const seg of segments) {
    if (cursor === null || cursor === undefined) return undefined;
    if (typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[seg];
  }
  return cursor;
}

function equalsCoerced(actual: unknown, expected: WhenValue): boolean {
  if (expected === null) {
    return actual === null || actual === undefined;
  }
  if (actual === null || actual === undefined) return false;
  if (Array.isArray(actual)) {
    return actual.some((item) => equalsCoerced(item, expected));
  }
  return String(actual) === String(expected);
}

export function matchesWhen(when: WhenClause, ctx: TemplateContext): boolean {
  for (const [path, expected] of Object.entries(when)) {
    const actual = getByPath(ctx, path);
    if (!equalsCoerced(actual, expected)) return false;
  }
  return true;
}

export function pickResponse(
  responses: MatchableResponseDef[],
  ctx: TemplateContext
): MatchableResponseDef | null {
  for (const r of responses) {
    if (!r.when || matchesWhen(r.when, ctx)) return r;
  }
  return null;
}
