import { describe, it, expect, afterEach } from "vitest";
import { startTestServer, bearer, type TestServerHandle } from "./helpers.js";
import type { DslDocument } from "../src/types.js";

let server: TestServerHandle | null = null;

afterEach(async () => {
  if (server) {
    await server.stop();
    server = null;
  }
});

async function withDsl(dsl: DslDocument): Promise<TestServerHandle> {
  server = await startTestServer(dsl);
  return server;
}

describe("integration — basic response", () => {
  it("serves a plain GET", async () => {
    const s = await withDsl({
      routes: [
        {
          id: "health",
          url: "/health",
          response: { status: 200, body: { ok: true } },
        },
      ],
    });
    const res = await fetch(`${s.base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("uses the route method (POST)", async () => {
    const s = await withDsl({
      routes: [
        {
          id: "p",
          url: "/p",
          method: "post",
          response: { status: 201, body: { created: true } },
        },
      ],
    });
    const post = await fetch(`${s.base}/p`, { method: "POST" });
    expect(post.status).toBe(201);

    const get = await fetch(`${s.base}/p`);
    expect(get.status).toBe(404);
  });

  it("concatenates URLs from nested routes", async () => {
    const s = await withDsl({
      routes: [
        {
          url: "/api",
          routes: [
            {
              url: "/v1",
              routes: [
                {
                  id: "leaf",
                  url: "/ping",
                  response: { status: 200, body: { pong: true } },
                },
              ],
            },
          ],
        },
      ],
    });
    const res = await fetch(`${s.base}/api/v1/ping`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pong: true });
  });
});

describe("integration — requireAuth", () => {
  const dsl: DslDocument = {
    routes: [
      {
        url: "/private",
        extensions: { requireAuth: true },
        routes: [
          {
            id: "secret",
            url: "/secret",
            response: { status: 200, body: { ok: true } },
          },
          {
            id: "open",
            url: "/open",
            extensions: { requireAuth: false },
            response: { status: 200, body: { ok: true } },
          },
        ],
      },
    ],
  };

  it("returns 401 without token", async () => {
    const s = await withDsl(dsl);
    const res = await fetch(`${s.base}/private/secret`);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "Unauthorized" });
  });

  it("returns 200 with valid Bearer", async () => {
    const s = await withDsl(dsl);
    const res = await fetch(`${s.base}/private/secret`, {
      headers: { Authorization: "Bearer abc.def.ghi" },
    });
    expect(res.status).toBe(200);
  });

  it("child can opt out with requireAuth: false", async () => {
    const s = await withDsl(dsl);
    const res = await fetch(`${s.base}/private/open`);
    expect(res.status).toBe(200);
  });

  it("rejects token that does not match auth.pattern", async () => {
    const s = await withDsl({
      auth: { headerName: "Authorization", pattern: "^Bearer X-.+" },
      routes: [
        {
          id: "x",
          url: "/x",
          extensions: { requireAuth: true },
          response: { status: 200 },
        },
      ],
    });
    const bad = await fetch(`${s.base}/x`, {
      headers: { Authorization: "Bearer notxprefix" },
    });
    expect(bad.status).toBe(401);

    const good = await fetch(`${s.base}/x`, {
      headers: { Authorization: "Bearer X-token" },
    });
    expect(good.status).toBe(200);
  });
});

describe("integration — errorRate", () => {
  it("never errors with errorRate=0", async () => {
    const s = await withDsl({
      routes: [
        {
          id: "x",
          url: "/x",
          extensions: { errorRate: 0 },
          response: { status: 200, body: { ok: true } },
        },
      ],
    });
    for (let i = 0; i < 20; i++) {
      const res = await fetch(`${s.base}/x`);
      expect(res.status).toBe(200);
    }
  });

  it("always errors with errorRate=1", async () => {
    const s = await withDsl({
      routes: [
        {
          id: "x",
          url: "/x",
          extensions: { errorRate: 1 },
          response: { status: 200, body: { ok: true } },
        },
      ],
    });
    for (let i = 0; i < 10; i++) {
      const res = await fetch(`${s.base}/x`);
      expect(res.status).toBe(500);
    }
    const body = await (await fetch(`${s.base}/x`)).json();
    expect(body).toMatchObject({ error: "Injected error" });
  });
});

describe("integration — delayRange", () => {
  it("waits at least min ms before responding", async () => {
    const s = await withDsl({
      routes: [
        {
          id: "x",
          url: "/x",
          extensions: { delayRange: [150, 250] },
          response: { status: 200, body: { ok: true } },
        },
      ],
    });
    const t0 = Date.now();
    const res = await fetch(`${s.base}/x`);
    const dt = Date.now() - t0;
    expect(res.status).toBe(200);
    expect(dt).toBeGreaterThanOrEqual(140); // small slack for timer rounding
    expect(dt).toBeLessThan(600); // generous upper bound for CI jitter
  });
});

describe("integration — rateLimit", () => {
  it("returns 429 after exceeding max for default identifier (IP)", async () => {
    const s = await withDsl({
      routes: [
        {
          id: "x",
          url: "/x",
          extensions: {
            rateLimit: { window: "1m", max: 2 },
          },
          response: { status: 200, body: { ok: true } },
        },
      ],
    });
    expect((await fetch(`${s.base}/x`)).status).toBe(200);
    expect((await fetch(`${s.base}/x`)).status).toBe(200);
    expect((await fetch(`${s.base}/x`)).status).toBe(429);
  });

  it("perUser override (max=0) locks the user immediately", async () => {
    const s = await withDsl({
      routes: [
        {
          id: "x",
          url: "/x",
          extensions: {
            requireAuth: true,
            rateLimit: {
              identifier: "{{token.sub}}",
              window: "1m",
              max: 10,
              perUser: { "user-locked": 0 },
            },
          },
          response: { status: 200, body: { ok: true } },
        },
      ],
    });
    const res = await fetch(`${s.base}/x`, {
      headers: { Authorization: bearer({ sub: "user-locked" }) },
    });
    expect(res.status).toBe(429);
  });

  it("perUser override grants higher max", async () => {
    const s = await withDsl({
      routes: [
        {
          id: "x",
          url: "/x",
          extensions: {
            requireAuth: true,
            rateLimit: {
              identifier: "{{token.sub}}",
              window: "1m",
              max: 1,
              perUser: { "user-vip": 100 },
            },
          },
          response: { status: 200, body: { ok: true } },
        },
      ],
    });
    const headers = { Authorization: bearer({ sub: "user-vip" }) };
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${s.base}/x`, { headers });
      expect(res.status).toBe(200);
    }
  });

  it("on-success window resets counter on 2xx", async () => {
    const s = await withDsl({
      routes: [
        {
          id: "login",
          url: "/login",
          method: "post",
          extensions: {
            rateLimit: {
              identifier: "{{body.username}}",
              window: "on-success",
              max: 2,
            },
          },
          response: { status: 200, body: { token: "ok" } },
        },
      ],
    });
    const post = () =>
      fetch(`${s.base}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "alice" }),
      });

    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(200);
  });
});

describe("integration — templating", () => {
  it("renders {{params.id}}, {{body.x}}, {{token.sub}}, {{now}}", async () => {
    const s = await withDsl({
      routes: [
        {
          id: "echo",
          url: "/echo/:id",
          method: "post",
          extensions: { requireAuth: true },
          response: {
            status: 200,
            body: {
              id: "{{params.id}}",
              tokenSub: "{{token.sub}}",
              body: "{{body.name}}",
              now: "{{now}}",
            },
          },
        },
      ],
    });
    const res = await fetch(`${s.base}/echo/42`, {
      method: "POST",
      headers: {
        Authorization: bearer({ sub: "user-99" }),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "renato" }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toBe("42");
    expect(body.tokenSub).toBe("user-99");
    expect(body.body).toBe("renato");
    expect(typeof body.now).toBe("string");
    expect((body.now as string).length).toBeGreaterThan(10);
  });

  it("faker helper generates different values per request", async () => {
    const s = await withDsl({
      routes: [
        {
          id: "x",
          url: "/x",
          response: {
            status: 200,
            body: { name: "{{faker 'person.firstName'}}" },
          },
        },
      ],
    });
    const seen = new Set<string>();
    for (let i = 0; i < 6; i++) {
      const b = (await (await fetch(`${s.base}/x`)).json()) as { name: string };
      seen.add(b.name);
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe("integration — conditional responses", () => {
  const dsl: DslDocument = {
    routes: [
      {
        id: "verify",
        url: "/verify",
        method: "post",
        responses: [
          {
            when: { "body.dni": "111" },
            status: 200,
            body: { kind: "ok", name: "Renato" },
          },
          {
            when: { "body.dni": "222" },
            status: 200,
            body: { kind: "ok", name: "Juan" },
          },
          {
            when: { "body.dni": "000" },
            status: 422,
            body: { kind: "blocked" },
          },
          { status: 200, body: { kind: "fallback" } },
        ],
      },
    ],
  };

  async function verify(s: TestServerHandle, dni: string | number) {
    const r = await fetch(`${s.base}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dni }),
    });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  }

  it("selects first matching when", async () => {
    const s = await withDsl(dsl);
    expect((await verify(s, "111")).body).toMatchObject({ name: "Renato" });
    expect((await verify(s, "222")).body).toMatchObject({ name: "Juan" });
  });

  it("uses fallback when no when matches", async () => {
    const s = await withDsl(dsl);
    expect((await verify(s, "999")).body).toMatchObject({ kind: "fallback" });
  });

  it("supports number-to-string coercion in when matching", async () => {
    const s = await withDsl(dsl);
    const r = await verify(s, 111);
    expect(r.body).toMatchObject({ name: "Renato" });
  });

  it("non-success status is honored for matched when", async () => {
    const s = await withDsl(dsl);
    const r = await verify(s, "000");
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ kind: "blocked" });
  });

  it("404 when no fallback and nothing matches", async () => {
    const s = await withDsl({
      routes: [
        {
          id: "no-fallback",
          url: "/x",
          method: "post",
          responses: [
            { when: { "body.k": "A" }, status: 200, body: {} },
            { when: { "body.k": "B" }, status: 200, body: {} },
          ],
        },
      ],
    });
    const r = await fetch(`${s.base}/x`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ k: "Z" }),
    });
    expect(r.status).toBe(404);
    expect(await r.json()).toMatchObject({ error: "No response matched" });
  });
});
