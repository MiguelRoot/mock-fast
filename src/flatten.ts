import type {
  DslRouteNode,
  FlatRoute,
  Extensions,
  MatchableResponseDef,
} from "./types.js";

function joinUrl(parent: string, child: string): string {
  const p = parent.replace(/\/+$/, "");
  const c = child.replace(/^\/+/, "");
  if (!p) return "/" + c;
  if (!c) return p || "/";
  return `${p}/${c}`;
}

function mergeExtensions(parent: Extensions, child: Extensions): Extensions {
  const out: Extensions = { ...parent };
  for (const [k, v] of Object.entries(child) as [keyof Extensions, unknown][]) {
    if (v === undefined) continue;
    (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

function deriveId(method: string, url: string): string {
  const cleaned = url
    .replace(/^\/+/, "")
    .replace(/[:/]+/g, "-")
    .replace(/[^a-zA-Z0-9-]/g, "");
  return `${method}-${cleaned || "root"}`;
}

function normalizeResponses(node: DslRouteNode): MatchableResponseDef[] | null {
  if (node.responses && node.responses.length > 0) return node.responses;
  if (node.response) return [node.response];
  return null;
}

export function flattenRoutes(roots: DslRouteNode[]): FlatRoute[] {
  const out: FlatRoute[] = [];

  const walk = (
    node: DslRouteNode,
    parentUrl: string,
    parentHeaders: Record<string, string>,
    parentExtensions: Extensions
  ) => {
    const url = joinUrl(parentUrl, node.url);
    const headers = { ...parentHeaders, ...(node.headers ?? {}) };
    const extensions = mergeExtensions(parentExtensions, node.extensions ?? {});

    const responses = normalizeResponses(node);
    if (responses) {
      const method = node.method ?? "get";
      out.push({
        id: node.id ?? deriveId(method, url),
        url,
        method,
        headers,
        extensions,
        ...(node.filter ? { filter: node.filter } : {}),
        responses,
      });
    }

    if (node.routes) {
      for (const child of node.routes) {
        walk(child, url, headers, extensions);
      }
    }
  };

  for (const root of roots) {
    walk(root, "", {}, {});
  }

  return out;
}
