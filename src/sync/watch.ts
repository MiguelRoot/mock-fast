import { writeFileSync, mkdirSync, rmSync, existsSync, watch as fsWatch, type FSWatcher } from "node:fs";
import path from "node:path";

import { createMockFast, type MockFastInstance } from "../index.js";
import { generateDsl, SyncError, type SyncErrorDetail } from "./generate.js";

export interface WatchOptions {
  cwd?: string;
  dir?: string; // api-spec folder
  out?: string; // generated DSL file
  port?: number;
  host?: string;
  adminPort?: number;
}

const ERR_FILE = ".mock-fast/sync-error.json";

/** Flutter/Expo-style watcher: press `r` to sync api-spec/ → mock-fast.json and reload. */
export async function runWatch(opts: WatchOptions = {}): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const specDir = path.resolve(cwd, opts.dir ?? "api-spec");
  const outFile = path.resolve(cwd, opts.out ?? "mock-fast.json");
  const errFile = path.resolve(cwd, ERR_FILE);

  const writeErr = (d: SyncErrorDetail) => {
    mkdirSync(path.dirname(errFile), { recursive: true });
    writeFileSync(errFile, JSON.stringify({ ok: false, ...d }, null, 2) + "\n");
  };
  const clearErr = () => {
    if (existsSync(errFile)) rmSync(errFile);
  };

  // One sync pass. Never throws: a failure is reported, the server keeps the last good mock.
  const sync = (): boolean => {
    try {
      const dsl = generateDsl(specDir);
      writeFileSync(outFile, JSON.stringify(dsl, null, 2) + "\n");
      clearErr();
      console.log(`\x1b[32m✓\x1b[0m sync ok — ${dsl.routes.length} route(s) → ${path.basename(outFile)}`);
      return true;
    } catch (err) {
      if (err instanceof SyncError) {
        writeErr(err.detail);
        console.error(`\x1b[31m✗ sync failed:\x1b[0m ${err.message}`);
        console.error(`  (details written to ${ERR_FILE} — hand it to the AI to fix)`);
        return false;
      }
      throw err;
    }
  };

  // Initial sync. If it fails there's no mock yet → write a minimal empty mock so the server can boot.
  if (!sync() && !existsSync(outFile)) {
    writeFileSync(outFile, JSON.stringify({ routes: [] }, null, 2) + "\n");
    console.error(`  (started with an empty mock; fix the spec and press \x1b[1mr\x1b[0m)`);
  }

  const server: MockFastInstance = await createMockFast({
    file: outFile,
    port: opts.port,
    host: opts.host,
    adminPort: opts.adminPort,
    watch: true, // mock-fast hot-reloads when we rewrite outFile
    silent: true,
  });
  await server.start();
  console.log(`\x1b[36mmock-fast\x1b[0m watching ${path.relative(cwd, specDir) || "."} → serving ${server.url()}`);

  let pending = false;
  let watcher: FSWatcher | null = null;
  try {
    watcher = fsWatch(specDir, { recursive: true }, () => {
      if (!pending) {
        pending = true;
        console.log(`\x1b[33m•\x1b[0m changes detected — press \x1b[1mr\x1b[0m to sync`);
      }
    });
  } catch {
    // recursive watch unsupported on some platforms; `r` still works manually
  }

  printHelp();

  const stdin = process.stdin;
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  const shutdown = async () => {
    watcher?.close();
    if (stdin.isTTY) stdin.setRawMode(false);
    await server.stop();
    process.exit(0);
  };

  stdin.on("data", (key: string) => {
    switch (key) {
      case "r":
      case "R":
        pending = false;
        sync();
        break;
      case "q":
      case "Q":
      case "": // Ctrl-C
        console.log("\nbye");
        void shutdown();
        break;
      case "h":
      case "?":
        printHelp();
        break;
    }
  });

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

function printHelp() {
  console.log(`  \x1b[1mr\x1b[0m sync + reload   \x1b[1mh\x1b[0m help   \x1b[1mq\x1b[0m quit`);
}
