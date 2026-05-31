import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { generateDsl, SyncError } from "../src/sync/generate.js";
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
        strip(fixture("autenticacion-mobile-service/autenticacion/response-200-step1.json"), ["timestamp"])
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

describe("sync — errors are descriptive (SyncError)", () => {
  it("throws on a missing api-spec dir", () => {
    expect(() => generateDsl(path.resolve(process.cwd(), "tests/does-not-exist"))).toThrow(SyncError);
  });
});
