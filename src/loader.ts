import { promises as fs } from "node:fs";
import path from "node:path";
import { dslDocument, type DslDocumentParsed } from "./schema.js";

const DEFAULT_FILES = ["mock-fast.json", "mocks.json", "mock.json"];

export class LoaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoaderError";
  }
}

export async function resolveDslPath(cwd: string, file?: string): Promise<string> {
  if (file) {
    const abs = path.isAbsolute(file) ? file : path.resolve(cwd, file);
    try {
      await fs.access(abs);
    } catch {
      throw new LoaderError(`DSL file not found: ${abs}`);
    }
    return abs;
  }
  for (const candidate of DEFAULT_FILES) {
    const abs = path.resolve(cwd, candidate);
    try {
      await fs.access(abs);
      return abs;
    } catch {
      // try next
    }
  }
  throw new LoaderError(
    `No DSL file found. Looked for: ${DEFAULT_FILES.join(", ")} in ${cwd}`
  );
}

function formatZodError(error: import("zod").ZodError): string {
  return error.errors
    .map((e) => {
      const path = e.path.length ? e.path.join(".") : "<root>";
      return `  ${path}: ${e.message}`;
    })
    .join("\n");
}

export async function loadDsl(absPath: string): Promise<DslDocumentParsed> {
  let raw: string;
  try {
    raw = await fs.readFile(absPath, "utf8");
  } catch (e) {
    throw new LoaderError(`Cannot read DSL file at ${absPath}: ${(e as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new LoaderError(`Invalid JSON in ${absPath}: ${(e as Error).message}`);
  }

  const result = dslDocument.safeParse(parsed);
  if (!result.success) {
    throw new LoaderError(
      `Invalid DSL in ${absPath}:\n${formatZodError(result.error)}`
    );
  }
  return result.data;
}
