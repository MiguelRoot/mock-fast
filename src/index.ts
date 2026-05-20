import { watch, type FSWatcher } from "node:fs";
import net from "node:net";
import path from "node:path";

import { resolveDslPath, loadDsl, LoaderError } from "./loader.js";
import { flattenRoutes } from "./flatten.js";
import { compileRoutes } from "./compile.js";
import { dslDocument, type DslDocumentParsed } from "./schema.js";
import type { RuntimeContext, ServerConfig, AuthConfig } from "./types.js";

const DEFAULT_AUTH: Required<AuthConfig> = {
  headerName: "Authorization",
  pattern: "^Bearer [A-Za-z0-9._\\-]+$",
};

const DEFAULT_SERVER = {
  port: 3001,
  host: "127.0.0.1",
  cors: true,
  adminPort: 3110,
} satisfies Required<ServerConfig>;

const COLLECTION_ID = "default";

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close();
        reject(new Error("could not allocate free port"));
      }
    });
  });
}

export interface CreateMockFastOptions {
  file?: string;
  dsl?: unknown;
  cwd?: string;
  port?: number;
  host?: string;
  adminPort?: number;
  watch?: boolean;
  silent?: boolean;
}

export interface MockFastInstance {
  start(): Promise<void>;
  stop(): Promise<void>;
  reload(): Promise<void>;
  url(): string;
  adminUrl(): string;
}

function parseInlineDsl(input: unknown): DslDocumentParsed {
  const result = dslDocument.safeParse(input);
  if (!result.success) {
    const lines = result.error.errors.map((e) => {
      const p = e.path.length ? e.path.join(".") : "<root>";
      return `  ${p}: ${e.message}`;
    });
    throw new LoaderError(`Invalid inline DSL:\n${lines.join("\n")}`);
  }
  return result.data;
}

export async function createMockFast(
  opts: CreateMockFastOptions = {}
): Promise<MockFastInstance> {
  if (opts.dsl !== undefined && opts.file !== undefined) {
    throw new Error("Pass either 'dsl' (inline) or 'file' (path), not both");
  }

  const cwd = opts.cwd ?? process.cwd();

  let absPath: string | null = null;
  let dsl: DslDocumentParsed;

  if (opts.dsl !== undefined) {
    dsl = parseInlineDsl(opts.dsl);
  } else {
    absPath = await resolveDslPath(cwd, opts.file);
    dsl = await loadDsl(absPath);
  }

  const ctx: RuntimeContext = {
    auth: {
      headerName: dsl.auth?.headerName ?? DEFAULT_AUTH.headerName,
      pattern: dsl.auth?.pattern ?? DEFAULT_AUTH.pattern,
    },
    rateLimitStore: new Map(),
  };

  const requestedPort = opts.port ?? dsl.server?.port ?? DEFAULT_SERVER.port;
  const port = requestedPort === 0 ? await getFreePort() : requestedPort;
  const host = opts.host ?? dsl.server?.host ?? DEFAULT_SERVER.host;
  const requestedAdminPort =
    opts.adminPort ?? dsl.server?.adminPort ?? DEFAULT_SERVER.adminPort;
  const adminPort =
    requestedAdminPort === 0 ? await getFreePort() : requestedAdminPort;
  const corsEnabled = dsl.server?.cors ?? DEFAULT_SERVER.cors;

  const { createServer } = await import("@mocks-server/main");

  const core = createServer({
    log: opts.silent ? "warn" : "info",
    server: {
      port,
      host,
      cors: { enabled: corsEnabled },
    },
    plugins: {
      adminApi: { port: adminPort },
    },
    mock: {
      collections: { selected: COLLECTION_ID },
    },
  });

  await core.init();

  const loaders = core.mock.createLoaders();

  const applyDsl = () => {
    const flat = flattenRoutes(dsl.routes);
    const { routes, collection } = compileRoutes(flat, ctx);
    loaders.loadRoutes(routes);
    loaders.loadCollections([collection]);
  };

  applyDsl();

  let watcher: FSWatcher | null = null;

  const setupWatch = () => {
    if (opts.watch === false) return;
    if (!absPath) return; // inline DSL: nothing to watch
    let debounce: NodeJS.Timeout | null = null;
    watcher = watch(absPath, { persistent: true }, () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(async () => {
        try {
          dsl = await loadDsl(absPath!);
          ctx.auth.headerName =
            dsl.auth?.headerName ?? DEFAULT_AUTH.headerName;
          ctx.auth.pattern = dsl.auth?.pattern ?? DEFAULT_AUTH.pattern;
          ctx.rateLimitStore.clear();
          applyDsl();
          if (!opts.silent) {
            console.log(`[mock-fast] reloaded ${path.basename(absPath!)}`);
          }
        } catch (err) {
          if (err instanceof LoaderError) {
            console.error(`[mock-fast] reload failed:\n${err.message}`);
          } else {
            console.error(`[mock-fast] reload failed:`, err);
          }
        }
      }, 100);
    });
  };

  return {
    async start() {
      await core.start();
      setupWatch();
      if (!opts.silent) {
        console.log(`[mock-fast] listening on http://${host}:${port}`);
        console.log(`[mock-fast] admin API on http://${host}:${adminPort}`);
        if (absPath) console.log(`[mock-fast] DSL: ${absPath}`);
      }
    },
    async stop() {
      if (watcher) {
        watcher.close();
        watcher = null;
      }
      await core.stop();
    },
    async reload() {
      if (!absPath) {
        throw new Error("reload() requires a file-based DSL");
      }
      dsl = await loadDsl(absPath);
      ctx.rateLimitStore.clear();
      applyDsl();
    },
    url() {
      return `http://${host}:${port}`;
    },
    adminUrl() {
      return `http://${host}:${adminPort}`;
    },
  };
}

export type { DslDocument, DslRouteNode, Extensions } from "./types.js";
