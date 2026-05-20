import { describe, it, expect } from "vitest";
import { dslDocument } from "../src/schema.js";

describe("schema — response / responses mutual exclusion", () => {
  it("accepts singular response", () => {
    const r = dslDocument.safeParse({
      routes: [{ url: "/a", response: { status: 200, body: {} } }],
    });
    expect(r.success).toBe(true);
  });

  it("accepts responses[]", () => {
    const r = dslDocument.safeParse({
      routes: [
        {
          url: "/a",
          responses: [
            { when: { "body.k": "x" }, status: 200, body: {} },
            { status: 200, body: {} },
          ],
        },
      ],
    });
    expect(r.success).toBe(true);
  });

  it("rejects when both response and responses are present", () => {
    const r = dslDocument.safeParse({
      routes: [
        {
          url: "/a",
          response: { status: 200 },
          responses: [{ status: 200 }],
        },
      ],
    });
    expect(r.success).toBe(false);
  });

  it("rejects empty responses[]", () => {
    const r = dslDocument.safeParse({
      routes: [{ url: "/a", responses: [] }],
    });
    expect(r.success).toBe(false);
  });

  it("accepts grouping-only node (no response, no responses)", () => {
    const r = dslDocument.safeParse({
      routes: [
        {
          url: "/api",
          routes: [{ url: "/x", response: { status: 200 } }],
        },
      ],
    });
    expect(r.success).toBe(true);
  });

  it("rejects when value of unsupported type (object) in v1", () => {
    const r = dslDocument.safeParse({
      routes: [
        {
          url: "/a",
          responses: [
            { when: { "body.amount": { gt: 100 } }, status: 200 },
          ],
        },
      ],
    });
    expect(r.success).toBe(false);
  });

  it("accepts primitive when values: string, number, boolean, null", () => {
    const r = dslDocument.safeParse({
      routes: [
        {
          url: "/a",
          responses: [
            {
              when: {
                "body.s": "x",
                "body.n": 1,
                "body.b": true,
                "body.nul": null,
              },
              status: 200,
            },
          ],
        },
      ],
    });
    expect(r.success).toBe(true);
  });
});
