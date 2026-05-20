import type { ExtensionHandler } from "../types.js";
import { buildContext, renderString } from "../templating.js";

const WINDOW_MS: Record<string, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "1h": 3_600_000,
  session: Number.POSITIVE_INFINITY,
  "on-success": Number.POSITIVE_INFINITY,
};

export interface OnSuccessHook {
  resetKeys(): void;
}

declare module "express-serve-static-core" {
  interface Request {
    __mockFastOnSuccessKeys?: string[];
  }
}

export const rateLimit: ExtensionHandler = ({ req, res, route, ctx }) => {
  const cfg = route.extensions.rateLimit;
  if (!cfg) return "continue";

  const tCtx = buildContext(req, ctx.auth.headerName);
  const identifier = cfg.identifier
    ? renderString(cfg.identifier, tCtx).trim() || req.ip || "anonymous"
    : req.ip || "anonymous";

  const max =
    cfg.perUser && cfg.perUser[identifier] !== undefined
      ? cfg.perUser[identifier]
      : cfg.max;

  const window = cfg.window ?? "1m";
  const windowMs = WINDOW_MS[window] ?? 60_000;
  const key = `${route.id}::${identifier}`;
  const now = Date.now();

  let entry = ctx.rateLimitStore.get(key);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + windowMs };
    ctx.rateLimitStore.set(key, entry);
  }

  entry.count += 1;

  if (window === "on-success") {
    (req.__mockFastOnSuccessKeys ??= []).push(key);
  }

  if (entry.count > (max ?? 0)) {
    const retryAfterSec =
      window === "session" || window === "on-success"
        ? -1
        : Math.max(0, Math.ceil((entry.resetAt - now) / 1000));

    const onLimit = cfg.onLimit ?? {
      status: 429,
      body: {
        error: "Too Many Requests",
        identifier,
        retryAfter: retryAfterSec >= 0 ? retryAfterSec : undefined,
      },
    };
    if (retryAfterSec >= 0) {
      res.setHeader("Retry-After", String(retryAfterSec));
    }
    res.status(onLimit.status ?? 429);
    if (onLimit.headers) {
      for (const [k, v] of Object.entries(onLimit.headers)) {
        res.setHeader(k, v);
      }
    }
    res.json(onLimit.body ?? { error: "Too Many Requests" });
    return "halt";
  }

  return "continue";
};

export function clearOnSuccessKeys(
  req: { __mockFastOnSuccessKeys?: string[] },
  store: Map<string, { count: number; resetAt: number }>
): void {
  const keys = req.__mockFastOnSuccessKeys;
  if (!keys || keys.length === 0) return;
  for (const k of keys) store.delete(k);
}
