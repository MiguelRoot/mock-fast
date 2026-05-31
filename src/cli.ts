#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import path from "node:path";

import { createMockFast } from "./index.js";
import { LoaderError } from "./loader.js";
import { runDeploy } from "./deploy.js";
import { generateDsl, SyncError } from "./sync/generate.js";

interface CliArgs {
  command: string;
  file?: string;
  port?: number;
  host?: string;
  adminPort?: number;
  watch?: boolean;
  out?: string;
  compose?: boolean;
  dir?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { command: "start" };
  const rest = argv.slice(2);
  if (rest.length > 0 && !rest[0]!.startsWith("-")) {
    args.command = rest.shift()!;
  }
  while (rest.length > 0) {
    const flag = rest.shift()!;
    switch (flag) {
      case "-f":
      case "--file":
        args.file = rest.shift();
        break;
      case "-p":
      case "--port":
        args.port = Number(rest.shift());
        break;
      case "-h":
      case "--host":
        args.host = rest.shift();
        break;
      case "--admin-port":
        args.adminPort = Number(rest.shift());
        break;
      case "--no-watch":
        args.watch = false;
        break;
      case "-o":
      case "--out":
        args.out = rest.shift();
        break;
      case "-d":
      case "--dir":
        args.dir = rest.shift();
        break;
      case "--compose":
        args.compose = true;
        break;
      case "--help":
        printHelp();
        process.exit(0);
      default:
        console.error(`Unknown flag: ${flag}`);
        printHelp();
        process.exit(1);
    }
  }
  return args;
}

function printHelp() {
  console.log(`mock-fast — zero-config mock server with a small DSL

Usage:
  mock-fast start [options]
  mock-fast deploy [options]
  mock-fast sync [options]

Options (start):
  -f, --file <path>      Path to the DSL JSON file
                         (defaults: mock-fast.json, mocks.json, mock.json)
  -p, --port <n>         HTTP port (default: 3001)
  -h, --host <h>         HTTP host (default: 127.0.0.1)
      --admin-port <n>   Admin API port (default: 3110)
      --no-watch         Disable hot reload of the DSL file

Options (deploy — generate a Docker-ready bundle):
  -f, --file <path>      DSL to package (same defaults as start)
  -o, --out <dir>        Output folder (default: mock-deploy)
  -p, --port <n>         Port baked into the Dockerfile (default: 3001)
      --compose          Also emit a docker-compose.yml

Options (sync — generate mock-fast.json from an api-spec/ tree):
  -d, --dir <path>       api-spec folder (default: api-spec)
  -o, --out <path>       Output DSL file (default: mock-fast.json)

      --help             Show this help

Examples:
  mock-fast start
  mock-fast start --file ./fixtures/mock.json --port 4000
  mock-fast deploy --out build/mock --port 8080 --compose
  mock-fast sync
  mock-fast sync --dir api-spec --out mock-fast.json
`);
}

async function deploy(args: CliArgs) {
  try {
    const { outDir, files } = await runDeploy({
      file: args.file,
      out: args.out,
      port: args.port,
      compose: args.compose,
    });
    console.log(`[mock-fast] deploy bundle written to ${outDir}`);
    for (const f of files) console.log(`  - ${f}`);
    console.log(`\nNext:\n  cd ${outDir}\n  docker build -t my-mock .\n  docker run --rm -p ${args.port ?? 3001}:${args.port ?? 3001} my-mock`);
  } catch (err) {
    if (err instanceof LoaderError) {
      console.error(`[mock-fast] ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

function sync(args: CliArgs) {
  const dir = path.resolve(process.cwd(), args.dir ?? "api-spec");
  const out = path.resolve(process.cwd(), args.out ?? "mock-fast.json");
  try {
    const dsl = generateDsl(dir);
    writeFileSync(out, JSON.stringify(dsl, null, 2) + "\n");
    console.log(`[mock-fast] sync: ${dsl.routes.length} route(s) from ${dir} → ${out}`);
  } catch (err) {
    if (err instanceof SyncError) {
      console.error(`[mock-fast] sync failed:\n${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.command === "deploy") {
    await deploy(args);
    return;
  }

  if (args.command === "sync") {
    sync(args);
    return;
  }

  if (args.command !== "start") {
    console.error(`Unknown command: ${args.command}`);
    printHelp();
    process.exit(1);
  }

  let instance;
  try {
    instance = await createMockFast({
      file: args.file,
      port: args.port,
      host: args.host,
      adminPort: args.adminPort,
      watch: args.watch,
    });
  } catch (err) {
    if (err instanceof LoaderError) {
      console.error(`[mock-fast] ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  await instance.start();

  const shutdown = async (signal: string) => {
    console.log(`\n[mock-fast] received ${signal}, stopping...`);
    try {
      await instance.stop();
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[mock-fast] fatal:", err);
  process.exit(1);
});
