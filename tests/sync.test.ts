import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";

import { generateDsl, SyncError } from "../src/sync/generate.js";
import { reverseToApiSpec } from "../src/sync/reverse.js";
import { createMockFast, type MockFastInstance } from "../src/index.js";

const SPEC = path.resolve(process.cwd(), "example/api-spec");
const fixture = (p: string) => JSON.parse(readFileSync(path.join(SPEC, p), "utf8"));

function strip(obj: any, paths: string[]): string {
  const c = JSON.parse(JSON.stringify(obj));
  for (const dotted of paths) {
    const ks = dotted.split(".");
    let cur: any = c;
    for (let i = 0; i < ks.length - 1 && cur != null; i++) cur = cur[ks[i]!];
    if (cur) delete cur[ks[ks.length - 1]!];
  }
  return JSON.stringify(c);
}

describe("sync — deterministic generator from example/api-spec", () => {
  it("generates a valid DSL", () => {
    const dsl = generateDsl(SPEC);
    expect(Array.isArray(dsl.routes)).toBe(true);
    expect(dsl.routes.length).toBeGreaterThan(5);
  });

  it("orders catch-all routes last", () => {
    const dsl = generateDsl(SPEC);
    const firstStar = dsl.routes.findIndex((r: any) => r.url.includes("*"));
    const lastPlain = dsl.routes.map((r: any) => r.url.includes("*")).lastIndexOf(false);
    expect(firstStar).toBeGreaterThan(lastPlain);
  });

  describe("served responses reflect fixtures + inheritance", () => {
    let server: MockFastInstance & { base?: string };
    let base: string;

    beforeAll(async () => {
      const dsl = generateDsl(SPEC);
      server = await createMockFast({ dsl, port: 0, adminPort: 0, watch: false, silent: true });
      await server.start();
      base = server.url();
    });
    afterAll(async () => server?.stop());

    const B = { headers: { Authorization: "Bearer mock.abc" } };
    const get = async (p: string, auth = false) => {
      for (let i = 0; i < 15; i++) {
        const r = await fetch(base + p, auth ? B : {});
        if (r.status !== 500) return { status: r.status, body: await r.json() };
      }
      return { status: 500, body: {} };
    };
    const post = async (p: string, b: unknown) => {
      const r = await fetch(base + p, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(b),
      });
      return { status: r.status, body: await r.json() };
    };

    it("login step1/step2/fallback (conditional + dynamic + array)", async () => {
      const A = "/autenticacion-mobile-service/autenticacion";
      const s1 = await post(A, { usuario: "jperez", contrasena: "test1234", aplicaciones: ["VS"], totp: null });
      expect(s1.status).toBe(200);
      expect(strip(s1.body, ["timestamp"])).toBe(
        strip(fixture("autenticacion-mobile-service/autenticacion/response-200.json"), ["timestamp"])
      );
      const s2 = await post(A, { usuario: "jperez", contrasena: "test1234", aplicaciones: ["VS"], totp: "123456" });
      expect(s2.status).toBe(200);
      expect(s2.body.data.aplicaciones[0].token).toMatch(/^Bearer mock\./);
      const f = await post(A, { usuario: "x" });
      expect(f.status).toBe(401);
    });

    it("inherits auth from _group.yml (401 without token, 200 with)", async () => {
      expect((await get("/api/protegida/perfil")).status).toBe(401);
      expect((await get("/api/protegida/perfil", true)).status).toBe(200);
    });

    it("auth: none overrides the inherited guard (pricing public)", async () => {
      const r = await get("/api/protegida/pricing");
      expect(r.status).toBe(200);
      expect(r.body.free).toBe(0);
    });

    it("route group adds no URL segment (estado at /api/estado)", async () => {
      expect((await get("/api/estado")).status).toBe(200);
    });

    it("dynamic param match + 404 fallback", async () => {
      expect((await get("/api/protegida/usuarios/1", true)).status).toBe(200);
      expect((await get("/api/protegida/usuarios/9", true)).status).toBe(404);
    });

    it("catch-all serves subpaths and reads {{params.[0]}}", async () => {
      const r = await get("/api/protegida/archivos/docs/x.pdf", true);
      expect(r.status).toBe(200);
      expect(r.body.ruta).toBe("docs/x.pdf");
    });
  });
});

describe("sync — errors are descriptive (SyncError) + AI-friendly detail", () => {
  const tmp = path.resolve(process.cwd(), "tests/.tmp-sync");
  beforeAll(() => mkdirSync(tmp, { recursive: true }));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it("missing api-spec dir → kind:no-api-spec", () => {
    try {
      generateDsl(path.join(tmp, "nope"));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SyncError);
      expect((e as SyncError).detail.kind).toBe("no-api-spec");
    }
  });

  it("orphan JSON (fixtures but no spec.yml) → kind:missing-bridge with a suggestion", () => {
    const dir = path.join(tmp, "api-spec", "saludo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "response-200.json"), '{"mensaje":"hola"}');
    try {
      generateDsl(path.join(tmp, "api-spec"));
      expect.unreachable();
    } catch (e) {
      const d = (e as SyncError).detail;
      expect(d.kind).toBe("missing-bridge");
      expect(d.where).toContain("saludo");
      expect(d.suggestion).toBeTruthy();
    }
  });

  it("once the bridge spec.yml exists, it generates the route", () => {
    const dir = path.join(tmp, "api-spec", "saludo");
    writeFileSync(
      path.join(dir, "spec.yml"),
      "method: GET\nauth: none\ncases:\n  ok:\n    response: response-200.json\n    status: 200\n"
    );
    const dsl = generateDsl(path.join(tmp, "api-spec"));
    expect(dsl.routes).toEqual([
      {
        url: "/saludo",
        method: "get",
        extensions: { requireAuth: false }, // auth: none → explicit requireAuth:false
        response: { status: 200, body: { mensaje: "hola" } },
      },
    ]);
  });
});

describe("sync --from-mock — reverse mock-fast.json → api-spec/ (round-trip)", () => {
  const tmp = path.resolve(process.cwd(), "tests/.tmp-reverse");
  const dslFile = path.join(tmp, "mock.json");
  const apiSpec = path.join(tmp, "api-spec");

  beforeAll(async () => {
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    writeFileSync(dslFile, JSON.stringify(generateDsl(SPEC), null, 2));
    await reverseToApiSpec(dslFile, apiSpec);
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it("recreates folders + spec.yml + response JSON (with [id]/[...rest] conventions)", () => {
    expect(existsSync(path.join(apiSpec, "api/protegida/perfil/spec.yml"))).toBe(true);
    expect(existsSync(path.join(apiSpec, "api/protegida/perfil/response-200.json"))).toBe(true);
    expect(existsSync(path.join(apiSpec, "api/protegida/usuarios/[id]/spec.yml"))).toBe(true);
    expect(existsSync(path.join(apiSpec, "api/protegida/archivos/[...rest]/spec.yml"))).toBe(true);
  });

  it("fixtures contain NO Handlebars (materialized); spec lifts them into dynamic", () => {
    const body = readFileSync(path.join(apiSpec, "api/protegida/perfil/response-200.json"), "utf8");
    expect(body).not.toContain("{{");
    const spec = readFileSync(path.join(apiSpec, "api/protegida/perfil/spec.yml"), "utf8");
    expect(spec).toContain("dynamic:");
    expect(spec).toContain("{{uuid}}");
  });

  it("round-trip is stable: reverse then forward yields the same route set", () => {
    const original = generateDsl(SPEC);
    const roundtrip = generateDsl(apiSpec);
    const norm = (d: { routes: any[] }) =>
      JSON.stringify(d.routes.map((r) => `${r.method ?? "get"} ${r.url}`).sort());
    expect(roundtrip.routes.length).toBe(original.routes.length);
    expect(norm(roundtrip)).toBe(norm(original));
  });

  it("refuses to overwrite existing api-spec without --force, succeeds with it", async () => {
    await expect(reverseToApiSpec(dslFile, apiSpec)).rejects.toBeInstanceOf(SyncError);
    await expect(reverseToApiSpec(dslFile, apiSpec, { force: true })).resolves.toBeTruthy();
  });
});
