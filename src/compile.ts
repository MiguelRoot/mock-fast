import type { Request, Response, NextFunction } from "express";
import type { FlatRoute, RuntimeContext } from "./types.js";
import { pipeline, clearOnSuccessKeys } from "./extensions/index.js";
import { buildContext, renderValue } from "./templating.js";
import { pickResponse } from "./matcher.js";
import { applyFilter, applyFilters, applyPaginate } from "./filter.js";

interface MocksServerRoute {
  id: string;
  url: string;
  method: string;
  variants: Array<{
    id: string;
    type: "middleware";
    options: { middleware: (req: Request, res: Response, next: NextFunction) => void };
  }>;
}

function buildMiddleware(route: FlatRoute, ctx: RuntimeContext) {
  return async (req: Request, res: Response, _next: NextFunction) => {
    try {
      for (const handler of pipeline) {
        const result = await handler({ req, res, next: _next, route, ctx });
        if (result === "halt") {
          clearOnSuccessKeys(req, ctx.rateLimitStore);
          return;
        }
      }

      const tCtx = buildContext(req, ctx.auth.headerName);
      const chosen = pickResponse(route.responses, tCtx);

      if (!chosen) {
        res.status(404).json({
          error: "No response matched",
          route: route.id,
          method: route.method,
          url: route.url,
        });
        return;
      }

      const status = chosen.status ?? 200;
      const mergedHeaders = { ...route.headers, ...(chosen.headers ?? {}) };
      for (const [k, v] of Object.entries(mergedHeaders)) {
        res.setHeader(k, renderValue(v, tCtx));
      }

      res.status(status);

      const body = chosen.body;
      if (body === undefined || body === null) {
        res.end();
      } else if (typeof body === "string") {
        res.send(renderValue(body, tCtx));
      } else {
        // Optional, opt-in transforms over the rendered body, in order:
        // single filter → multi-filter (AND) → pagination. Each is a no-op if absent.
        let finalBody: unknown = renderValue(body, tCtx);
        if (route.filter) finalBody = applyFilter(finalBody, route.filter, tCtx);
        if (route.filters) finalBody = applyFilters(finalBody, route.filters, tCtx);
        if (route.paginate) finalBody = applyPaginate(finalBody, route.paginate, tCtx);
        res.json(finalBody);
      }

      if (status >= 200 && status < 300) {
        clearOnSuccessKeys(req, ctx.rateLimitStore);
      }
    } catch (err) {
      res.status(500).json({
        error: "mock-fast internal error",
        message: (err as Error).message,
      });
    }
  };
}

export function compileRoutes(
  routes: FlatRoute[],
  ctx: RuntimeContext
): { routes: MocksServerRoute[]; collection: { id: string; routes: string[] } } {
  const compiled: MocksServerRoute[] = routes.map((route) => ({
    id: route.id,
    url: route.url,
    method: route.method,
    variants: [
      {
        id: "default",
        type: "middleware",
        options: { middleware: buildMiddleware(route, ctx) },
      },
    ],
  }));

  return {
    routes: compiled,
    collection: {
      id: "default",
      routes: compiled.map((r) => `${r.id}:default`),
    },
  };
}
