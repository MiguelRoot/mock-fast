import { z } from "zod";

const httpMethod = z.enum([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "options",
  "head",
]);

const responseDef = z.object({
  status: z.number().int().min(100).max(599).optional(),
  headers: z.record(z.string()).optional(),
  body: z.unknown().optional(),
});

const whenValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

const whenClause = z.record(whenValue);

const matchableResponseDef = responseDef.extend({
  when: whenClause.optional(),
});

const rateLimitConfig = z.object({
  identifier: z.string().optional(),
  window: z.enum(["1m", "5m", "1h", "session", "on-success"]).optional(),
  max: z.number().int().min(0),
  perUser: z.record(z.number().int().min(0)).optional(),
  onLimit: responseDef.optional(),
});

const extensions = z
  .object({
    requireAuth: z.boolean().optional(),
    errorRate: z.number().min(0).max(1).optional(),
    delayRange: z
      .tuple([z.number().int().min(0), z.number().int().min(0)])
      .refine(([min, max]) => min <= max, {
        message: "delayRange: min must be <= max",
      })
      .optional(),
    rateLimit: rateLimitConfig.optional(),
  })
  .strict();

// Optional, non-breaking: filters an array inside the response body before sending.
const filterConfig = z
  .object({
    in: z.string().min(1), // dotted path to the array in the body (e.g. "data")
    fields: z.array(z.string().min(1)).min(1), // which item fields to search
    by: z.string().min(1), // dotted path to the search term (e.g. "body.filtro")
    op: z.enum(["contains", "equals", "startsWith"]).optional(), // default: contains
    caseSensitive: z.boolean().optional(), // default: false
  })
  .strict();

// Optional: page a (possibly already-filtered) array, returning just that page.
const paginateConfig = z
  .object({
    of: z.string().min(1), // dotted path to the array (e.g. "data")
    page: z.string().min(1), // dotted path to the 1-based page number (e.g. "body.page")
    size: z.string().min(1), // dotted path to the page size (e.g. "body.pageSize")
    defaultSize: z.number().int().min(1).optional(), // used when size is missing (default 20)
    total: z.string().min(1).optional(), // optional body path to write the total count into
  })
  .strict();

type RouteNodeIn = {
  id?: string;
  url: string;
  method?: z.infer<typeof httpMethod>;
  headers?: Record<string, string>;
  extensions?: z.infer<typeof extensions>;
  filter?: z.infer<typeof filterConfig>;
  filters?: z.infer<typeof filterConfig>[];
  paginate?: z.infer<typeof paginateConfig>;
  response?: z.infer<typeof responseDef>;
  responses?: z.infer<typeof matchableResponseDef>[];
  routes?: RouteNodeIn[];
};

const routeNode: z.ZodType<RouteNodeIn> = z.lazy(() =>
  z
    .object({
      id: z.string().min(1).optional(),
      url: z.string().min(1),
      method: httpMethod.optional(),
      headers: z.record(z.string()).optional(),
      extensions: extensions.optional(),
      filter: filterConfig.optional(),
      filters: z.array(filterConfig).min(1).optional(),
      paginate: paginateConfig.optional(),
      response: responseDef.optional(),
      responses: z.array(matchableResponseDef).min(1).optional(),
      routes: z.array(routeNode).optional(),
    })
    .strict()
    .refine((node) => !(node.response && node.responses), {
      message:
        "use either 'response' (single) or 'responses' (array), not both",
      path: ["responses"],
    })
);

export const dslDocument = z
  .object({
    server: z
      .object({
        port: z.number().int().min(1).max(65535).optional(),
        host: z.string().optional(),
        cors: z.boolean().optional(),
        adminPort: z.number().int().min(1).max(65535).optional(),
      })
      .strict()
      .optional(),
    auth: z
      .object({
        headerName: z.string().optional(),
        pattern: z.string().optional(),
      })
      .strict()
      .optional(),
    routes: z.array(routeNode),
  })
  .strict();

export type DslDocumentParsed = z.infer<typeof dslDocument>;
