import Handlebars from "handlebars";
import { faker } from "@faker-js/faker";
import type { Request } from "express";
import { decodeJwt, extractBearer } from "./jwt.js";

const hb = Handlebars.create();

hb.registerHelper("faker", function (path: string, ...rest: unknown[]) {
  if (typeof path !== "string") return "";
  const segments = path.split(".");
  let cursor: unknown = faker;
  for (const seg of segments) {
    if (cursor && typeof cursor === "object" && seg in cursor) {
      cursor = (cursor as Record<string, unknown>)[seg];
    } else {
      return "";
    }
  }
  if (typeof cursor === "function") {
    const args = rest.slice(0, -1);
    try {
      return (cursor as (...a: unknown[]) => unknown)(...args);
    } catch {
      return "";
    }
  }
  return cursor as string | number;
});

hb.registerHelper("randomInt", function (min: unknown, max: unknown) {
  const mn = Number(min);
  const mx = Number(max);
  if (!Number.isFinite(mn) || !Number.isFinite(mx)) return 0;
  return Math.floor(Math.random() * (mx - mn + 1)) + mn;
});

hb.registerHelper("uuid", function () {
  return faker.string.uuid();
});

hb.registerHelper("now", function () {
  return new Date().toISOString();
});

export interface TemplateContext {
  params: Record<string, string>;
  query: Record<string, string | string[] | undefined>;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  token: Record<string, unknown>;
}

export function buildContext(req: Request, authHeader: string): TemplateContext {
  const headerValue = req.header(authHeader);
  const bearer = extractBearer(headerValue);
  const decoded = bearer ? decodeJwt(bearer) : null;
  return {
    params: req.params as Record<string, string>,
    query: req.query as Record<string, string | string[] | undefined>,
    headers: req.headers as Record<string, string | string[] | undefined>,
    body: req.body,
    token: decoded?.payload ?? {},
  };
}

export function renderString(template: string, ctx: TemplateContext): string {
  try {
    return hb.compile(template, { noEscape: true })(ctx);
  } catch {
    return template;
  }
}

export function renderValue<T>(value: T, ctx: TemplateContext): T {
  if (typeof value === "string") {
    return renderString(value, ctx) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => renderValue(v, ctx)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = renderValue(v, ctx);
    }
    return out as unknown as T;
  }
  return value;
}
