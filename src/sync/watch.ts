import {
  writeFileSync,
  readFileSync,
  mkdirSync,
  rmSync,
  existsSync,
  readdirSync,
  watch as fsWatch,
  type FSWatcher,
} from "node:fs";
import path from "node:path";

import { createMockFast, type MockFastInstance } from "../index.js";
import { SyncError } from "./generate.js";
import { reverseToApiSpec } from "./reverse.js";

export interface WatchOptions {
  cwd?: string;
  dir?: string; // api-spec folder (the readable view)
  file?: string; // mock-fast.json (the source of truth)
  port?: number;
  host?: string;
  adminPort?: number;
}

const DIR = ".mock-fast";
const CHANGES_FILE = `${DIR}/changes.json`;

interface ChangeEntry {
  file: string; // path relative to api-spec/
  line: number; // 1-based line number in the current file
  kind: "added" | "removed" | "changed";
  before: string | null;
  after: string | null;
}

/**
 * Watcher where the **mock-fast.json is the source of truth**:
 *  - on start / `r`: reverse (mock → api-spec view) and snapshot it; clears the change log.
 *  - `m`: diff the current api-spec against the last snapshot → write .mock-fast/changes.json
 *    (file + line + before/after) so the AI can apply just that change back to the mock.
 *  - `q`: quit.
 */
export async function runWatch(opts: WatchOptions = {}): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const specDir = path.resolve(cwd, opts.dir ?? "api-spec");
  const mockFile = path.resolve(cwd, opts.file ?? "mock-fast.json");
  const changesFile = path.resolve(cwd, CHANGES_FILE);

  // snapshot of every api-spec file as it was right after the last reverse (baseline for `m`)
  let snapshot = new Map<string, string>();

  const listSpecFiles = (): string[] => {
    const out: string[] = [];
    const walk = (d: string) => {
      if (!existsSync(d)) return;
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(json|ya?ml)$/i.test(e.name)) out.push(p);
      }
    };
    walk(specDir);
    return out;
  };

  const takeSnapshot = () => {
    snapshot = new Map();
    for (const f of listSpecFiles()) {
      try {
        snapshot.set(f, readFileSync(f, "utf8"));
      } catch {
        /* ignore unreadable */
      }
    }
  };

  const clearChanges = () => {
    if (existsSync(changesFile)) rmSync(changesFile);
  };

  // `r` / startup: regenerate the api-spec view FROM the mock, re-snapshot, reset the change log.
  const reverse = async (): Promise<boolean> => {
    try {
      const r = await reverseToApiSpec(mockFile, specDir, { force: true });
      takeSnapshot();
      clearChanges();
      console.log(`\x1b[32m✓\x1b[0m view refreshed — ${r.folders} folder(s) from ${path.basename(mockFile)} (changes reset)`);
      return true;
    } catch (err) {
      if (err instanceof SyncError) {
        console.error(`\x1b[31m✗ reverse failed:\x1b[0m ${err.message}`);
        return false;
      }
      throw err;
    }
  };

  // `m`: diff current files vs snapshot → structured change log for the AI.
  const mapChanges = () => {
    const changes: ChangeEntry[] = [];
    const current = listSpecFiles();
    const seen = new Set<string>();

    for (const f of current) {
      seen.add(f);
      const rel = path.relative(specDir, f);
      const now = safeRead(f);
      const was = snapshot.get(f);
      if (was === undefined) {
        changes.push({ file: rel, line: 1, kind: "added", before: null, after: firstMeaningfulLine(now) });
      } else if (was !== now) {
        for (const d of lineDiff(was, now)) changes.push({ file: rel, ...d });
      }
    }
    // files that existed in the snapshot but are gone now
    for (const [f] of snapshot) {
      if (!seen.has(f)) {
        changes.push({ file: path.relative(specDir, f), line: 0, kind: "removed", before: "(file)", after: null });
      }
    }

    mkdirSync(path.dirname(changesFile), { recursive: true });
    const payload = {
      note: "Changes in api-spec since the last reverse (r). The AI applies these to mock-fast.json, then the user presses r.",
      baseline: "last reverse / r",
      mock: path.relative(cwd, mockFile),
      apiSpec: path.relative(cwd, specDir),
      changes,
    };
    writeFileSync(changesFile, JSON.stringify(payload, null, 2) + "\n");

    if (!changes.length) {
      console.log(`\x1b[33m•\x1b[0m no changes since last r — ${CHANGES_FILE} written (empty)`);
    } else {
      console.log(`\x1b[36m⌖\x1b[0m mapped ${changes.length} change(s) → ${CHANGES_FILE}:`);
      for (const c of changes.slice(0, 8)) {
        console.log(`  ${c.file}:${c.line}  [${c.kind}]  ${truncate(c.after ?? c.before ?? "")}`);
      }
      if (changes.length > 8) console.log(`  …and ${changes.length - 8} more`);
      console.log(`  Tell the AI: "actualizá el último cambio en el mock" — it reads ${CHANGES_FILE}.`);
    }
  };

  // --- boot: reverse the view from the mock, start the server on the mock ---
  if (!existsSync(mockFile)) {
    console.error(`\x1b[31m✗\x1b[0m mock-fast.json not found at ${mockFile} — nothing to watch.`);
    return;
  }
  await reverse();

  const server: MockFastInstance = await createMockFast({
    file: mockFile,
    port: opts.port,
    host: opts.host,
    adminPort: opts.adminPort,
    watch: true, // server hot-reloads when the AI rewrites the mock
    silent: true,
  });
  await server.start();
  console.log(`\x1b[36mmock-fast\x1b[0m source: ${path.basename(mockFile)} → serving ${server.url()}`);
  console.log(`  view: ${path.relative(cwd, specDir) || "."}`);

  let watcher: FSWatcher | null = null;
  try {
    watcher = fsWatch(specDir, { recursive: true }, () => {
      // passive: the user decides when to map (m) or refresh (r)
    });
  } catch {
    /* recursive watch unsupported on some platforms; keys still work */
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
        void reverse();
        break;
      case "m":
      case "M":
        mapChanges();
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

function safeRead(f: string): string {
  try {
    return readFileSync(f, "utf8");
  } catch {
    return "";
  }
}

/**
 * Line-level diff that trims the common prefix/suffix, so a pure insertion shows up as
 * the inserted line(s) only — not a cascade of "changed" lines. Line numbers are 1-based
 * into the AFTER file (where the user/AI will look).
 */
function lineDiff(before: string, after: string): Omit<ChangeEntry, "file">[] {
  const a = before.split("\n");
  const b = after.split("\n");

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;

  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }

  const removed = a.slice(start, endA + 1);
  const added = b.slice(start, endB + 1);
  const out: Omit<ChangeEntry, "file">[] = [];

  if (!removed.length && added.length) {
    // pure insertion
    added.forEach((y, i) => out.push({ line: start + 1 + i, kind: "added", before: null, after: y.trim() }));
  } else if (removed.length && !added.length) {
    // pure deletion
    removed.forEach((x) => out.push({ line: start + 1, kind: "removed", before: x.trim(), after: null }));
  } else {
    // replaced block: pair them up, surface the rest
    const n = Math.max(removed.length, added.length);
    for (let i = 0; i < n; i++) {
      const x = removed[i];
      const y = added[i];
      if (x !== undefined && y !== undefined) out.push({ line: start + 1 + i, kind: "changed", before: x.trim(), after: y.trim() });
      else if (y !== undefined) out.push({ line: start + 1 + i, kind: "added", before: null, after: y.trim() });
      else if (x !== undefined) out.push({ line: start + 1 + i, kind: "removed", before: x.trim(), after: null });
    }
  }
  return out;
}

function firstMeaningfulLine(s: string): string {
  for (const l of s.split("\n")) if (l.trim()) return l.trim();
  return "";
}

const truncate = (s: string, n = 60) => (s.length > n ? s.slice(0, n) + "…" : s);

function printHelp() {
  console.log(`  \x1b[1mr\x1b[0m refresh view from mock (resets changes)   \x1b[1mm\x1b[0m map changes since last r   \x1b[1mh\x1b[0m help   \x1b[1mq\x1b[0m quit`);
}
