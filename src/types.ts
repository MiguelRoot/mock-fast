import type { Request, Response, NextFunction } from "express";

export type HttpMethod =
  | "get"
  | "post"
  | "put"
  | "patch"
  | "delete"
  | "options"
  | "head";

export interface ResponseDef {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}

export type WhenValue = string | number | boolean | null;
export type WhenClause = Record<string, WhenValue>;

export interface MatchableResponseDef extends ResponseDef {
  when?: WhenClause;
}

export interface RateLimitConfig {
  identifier?: string;
  window?: "1m" | "5m" | "1h" | "session" | "on-success";
  max: number;
  perUser?: Record<string, number>;
  onLimit?: ResponseDef;
}

export interface Extensions {
  requireAuth?: boolean;
  errorRate?: number;
  delayRange?: [number, number];
  rateLimit?: RateLimitConfig;
}

export interface FilterConfig {
  in: string;
  fields: string[];
  by: string;
  op?: "contains" | "equals" | "startsWith";
  caseSensitive?: boolean;
}

export interface PaginateConfig {
  of: string;
  page: string;
  size: string;
  defaultSize?: number;
  total?: string;
}

export interface DslRouteNode {
  id?: string;
  url: string;
  method?: HttpMethod;
  headers?: Record<string, string>;
  extensions?: Extensions;
  filter?: FilterConfig;
  filters?: FilterConfig[];
  paginate?: PaginateConfig;
  response?: ResponseDef;
  responses?: MatchableResponseDef[];
  routes?: DslRouteNode[];
}

export interface AuthConfig {
  headerName?: string;
  pattern?: string;
}

export interface ServerConfig {
  port?: number;
  host?: string;
  cors?: boolean;
  adminPort?: number;
}

export interface DslDocument {
  server?: ServerConfig;
  auth?: AuthConfig;
  routes: DslRouteNode[];
}

export interface FlatRoute {
  id: string;
  url: string;
  method: HttpMethod;
  headers: Record<string, string>;
  extensions: Extensions;
  filter?: FilterConfig;
  filters?: FilterConfig[];
  paginate?: PaginateConfig;
  responses: MatchableResponseDef[];
}

export interface RuntimeContext {
  auth: Required<AuthConfig>;
  rateLimitStore: Map<string, { count: number; resetAt: number }>;
}

export type ExtensionHandler = (args: {
  req: Request;
  res: Response;
  next: NextFunction;
  route: FlatRoute;
  ctx: RuntimeContext;
}) => Promise<"continue" | "halt"> | "continue" | "halt";
