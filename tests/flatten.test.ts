import { describe, it, expect } from "vitest";
import { flattenRoutes } from "../src/flatten.js";

describe("flattenRoutes — response normalization", () => {
  it("normalizes singular response to responses[0]", () => {
    const out = flattenRoutes([
      {
        id: "r",
        url: "/x",
        response: { status: 200, body: { ok: true } },
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.responses).toEqual([{ status: 200, body: { ok: true } }]);
  });

  it("keeps responses[] untouched", () => {
    const out = flattenRoutes([
      {
        id: "r",
        url: "/x",
        responses: [
          { when: { "body.k": "A" }, status: 200, body: { v: "a" } },
          { status: 200, body: { v: "fallback" } },
        ],
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.responses).toHaveLength(2);
    expect(out[0]!.responses[0]!.when).toEqual({ "body.k": "A" });
  });

  it("does not register an endpoint for grouping-only nodes (no response, no responses)", () => {
    const out = flattenRoutes([
      {
        url: "/api",
        routes: [
          { id: "child", url: "/x", response: { status: 200, body: { v: 1 } } },
        ],
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("child");
    expect(out[0]!.url).toBe("/api/x");
  });

  it("treats empty responses[] as no-endpoint (defensive)", () => {
    const out = flattenRoutes([
      {
        url: "/empty",
        responses: [],
      },
    ]);
    expect(out).toHaveLength(0);
  });
});
