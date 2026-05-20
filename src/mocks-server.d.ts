declare module "@mocks-server/main" {
  interface MocksServerConfig {
    log?: string;
    server?: {
      port?: number;
      host?: string;
      cors?: { enabled?: boolean; options?: Record<string, unknown> };
    };
    plugins?: {
      adminApi?: { port?: number; host?: string };
      inquirerCli?: { enabled?: boolean };
      [k: string]: unknown;
    };
    mock?: {
      collections?: { selected?: string };
      routes?: { delay?: number };
    };
    files?: { enabled?: boolean };
    [k: string]: unknown;
  }

  interface MocksServerLoaders {
    loadRoutes(routes: unknown[]): void;
    loadCollections(collections: unknown[]): void;
  }

  interface MocksServerCore {
    init(): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
    mock: {
      createLoaders(): MocksServerLoaders;
    };
    config: unknown;
    server: unknown;
    variantHandlers: unknown;
    files: unknown;
    alerts: unknown;
    logger: unknown;
    version: string;
  }

  export function createServer(config?: MocksServerConfig): MocksServerCore;
}
