import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { runDeploy } from "../src/deploy.js";
import { LoaderError } from "../src/loader.js";

const VALID_DSL = JSON.stringify({
  routes: [{ id: "health", url: "/health", response: { status: 200, body: { ok: true } } }],
});

describe("deploy — generates a Docker-ready bundle", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), "mockfast-deploy-"));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("writes the bundle files and copies the DSL", async () => {
    writeFileSync(path.join(cwd, "mock-fast.json"), VALID_DSL);

    const { outDir, files } = await runDeploy({ cwd });

    expect(path.basename(outDir)).toBe("mock-deploy");
    for (const f of ["Dockerfile", ".dockerignore", "README.md", "mock-fast.json"]) {
      expect(files).toContain(f);
      expect(existsSync(path.join(outDir, f))).toBe(true);
    }

    const dockerfile = readFileSync(path.join(outDir, "Dockerfile"), "utf8");
    expect(dockerfile).toContain("--host");
    expect(dockerfile).toContain("0.0.0.0");
    expect(dockerfile).toContain("--no-watch");
    expect(dockerfile).toMatch(/npm install -g mock-fast@/);

    // the copied DSL is the same content
    expect(readFileSync(path.join(outDir, "mock-fast.json"), "utf8")).toBe(VALID_DSL);
  });

  it("respects --out and --port and emits compose when asked", async () => {
    writeFileSync(path.join(cwd, "mock-fast.json"), VALID_DSL);

    const { outDir, files } = await runDeploy({ cwd, out: "build/mock", port: 8080, compose: true });

    expect(outDir).toBe(path.resolve(cwd, "build/mock"));
    expect(files).toContain("docker-compose.yml");
    expect(readFileSync(path.join(outDir, "Dockerfile"), "utf8")).toContain("EXPOSE 8080");
    expect(readFileSync(path.join(outDir, "docker-compose.yml"), "utf8")).toContain('"8080:8080"');
  });

  it("fails fast on an invalid DSL without writing a bundle", async () => {
    writeFileSync(path.join(cwd, "mock-fast.json"), '{ "routes": [{ "url": "/a", "response": {}, "responses": [] }] }');

    await expect(runDeploy({ cwd })).rejects.toBeInstanceOf(LoaderError);
    expect(existsSync(path.join(cwd, "mock-deploy"))).toBe(false);
  });

  it("errors when no DSL file is present", async () => {
    await expect(runDeploy({ cwd })).rejects.toBeInstanceOf(LoaderError);
  });
});
