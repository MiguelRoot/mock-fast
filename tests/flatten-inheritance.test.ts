import { describe, it, expect } from "vitest";
import { flattenRoutes } from "../src/flatten.js";
import type { DslRouteNode } from "../src/types.js";

describe("flattenRoutes — URL concatenation", () => {
  it("joins parent + child with a single slash", () => {
    const tree: DslRouteNode[] = [
      {
        url: "/api/",
        routes: [
          { id: "a", url: "/users", response: { status: 200 } },
          { id: "b", url: "items", response: { status: 200 } },
        ],
      },
    ];
    const urls = flattenRoutes(tree)
      .map((r) => r.url)
      .sort();
    expect(urls).toEqual(["/api/items", "/api/users"]);
  });

  it("walks deeply nested trees", () => {
    const tree: DslRouteNode[] = [
      {
        url: "/a",
        routes: [
          {
            url: "/b",
            routes: [
              {
                url: "/c",
                routes: [
                  {
                    id: "deep",
                    url: "/d",
                    response: { status: 200 },
                  },
                ],
              },
            ],
          },
        ],
      },
    ];
    const flat = flattenRoutes(tree);
    expect(flat).toHaveLength(1);
    expect(flat[0]!.url).toBe("/a/b/c/d");
  });

  it("auto-derives id from method+url when omitted", () => {
    const tree: DslRouteNode[] = [
      {
        url: "/api/users/:id",
        method: "post",
        response: { status: 200 },
      },
    ];
    const flat = flattenRoutes(tree);
    expect(flat[0]!.id).toMatch(/^post-/);
  });
});

describe("flattenRoutes — extension inheritance", () => {
  it("children inherit parent extensions", () => {
    const tree: DslRouteNode[] = [
      {
        url: "/api",
        extensions: { requireAuth: true, errorRate: 0.1 },
        routes: [
          { id: "leaf", url: "/x", response: { status: 200 } },
        ],
      },
    ];
    const flat = flattenRoutes(tree);
    expect(flat[0]!.extensions).toMatchObject({
      requireAuth: true,
      errorRate: 0.1,
    });
  });

  it("child can override individual keys (requireAuth: false to disable)", () => {
    const tree: DslRouteNode[] = [
      {
        url: "/api",
        extensions: { requireAuth: true, errorRate: 0.1 },
        routes: [
          {
            id: "public",
            url: "/x",
            extensions: { requireAuth: false },
            response: { status: 200 },
          },
        ],
      },
    ];
    const flat = flattenRoutes(tree);
    expect(flat[0]!.extensions.requireAuth).toBe(false);
    expect(flat[0]!.extensions.errorRate).toBe(0.1);
  });
});

describe("flattenRoutes — headers merge", () => {
  it("merges parent and child headers; child wins on collision", () => {
    const tree: DslRouteNode[] = [
      {
        url: "/api",
        headers: { "X-Tier": "free", "X-Common": "yes" },
        routes: [
          {
            id: "leaf",
            url: "/x",
            headers: { "X-Tier": "pro" },
            response: { status: 200 },
          },
        ],
      },
    ];
    const flat = flattenRoutes(tree);
    expect(flat[0]!.headers).toEqual({ "X-Tier": "pro", "X-Common": "yes" });
  });
});
