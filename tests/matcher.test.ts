import { describe, it, expect } from "vitest";
import { getByPath, matchesWhen, pickResponse } from "../src/matcher.js";
import type { TemplateContext } from "../src/templating.js";
import type { MatchableResponseDef } from "../src/types.js";

function ctx(partial: Partial<TemplateContext>): TemplateContext {
  return {
    params: {},
    query: {},
    headers: {},
    body: undefined,
    token: {},
    ...partial,
  };
}

describe("getByPath", () => {
  it("resolves a top-level field", () => {
    expect(getByPath({ a: 1 }, "a")).toBe(1);
  });

  it("resolves nested fields", () => {
    expect(getByPath({ a: { b: { c: 42 } } }, "a.b.c")).toBe(42);
  });

  it("returns undefined on missing segment", () => {
    expect(getByPath({ a: 1 }, "a.b.c")).toBeUndefined();
  });

  it("returns undefined on null intermediate", () => {
    expect(getByPath({ a: null }, "a.b")).toBeUndefined();
  });

  it("returns undefined for empty path", () => {
    expect(getByPath({ a: 1 }, "")).toBeUndefined();
  });

  it("resolves array indices by numeric segment", () => {
    expect(getByPath({ items: [{ id: 9 }] }, "items.0.id")).toBe(9);
  });
});

describe("matchesWhen", () => {
  it("matches a single body field with string equality", () => {
    const c = ctx({ body: { dni: "12345673" } });
    expect(matchesWhen({ "body.dni": "12345673" }, c)).toBe(true);
  });

  it("coerces number actual to string for comparison", () => {
    const c = ctx({ body: { dni: 12345673 } });
    expect(matchesWhen({ "body.dni": "12345673" }, c)).toBe(true);
  });

  it("coerces string actual against number expected", () => {
    const c = ctx({ body: { count: "5" } });
    expect(matchesWhen({ "body.count": 5 }, c)).toBe(true);
  });

  it("returns false when actual is missing", () => {
    const c = ctx({ body: {} });
    expect(matchesWhen({ "body.dni": "x" }, c)).toBe(false);
  });

  it("returns false when body itself is undefined", () => {
    const c = ctx({});
    expect(matchesWhen({ "body.dni": "x" }, c)).toBe(false);
  });

  it("treats expected=null as matching null or undefined actual", () => {
    expect(matchesWhen({ "body.x": null }, ctx({ body: {} }))).toBe(true);
    expect(matchesWhen({ "body.x": null }, ctx({ body: { x: null } }))).toBe(
      true
    );
    expect(matchesWhen({ "body.x": null }, ctx({ body: { x: "v" } }))).toBe(
      false
    );
  });

  it("ANDs multiple keys", () => {
    const c = ctx({ body: { a: 1, b: 2 } });
    expect(matchesWhen({ "body.a": 1, "body.b": 2 }, c)).toBe(true);
    expect(matchesWhen({ "body.a": 1, "body.b": 999 }, c)).toBe(false);
  });

  it("supports query, headers, params, token sources", () => {
    const c = ctx({
      query: { region: "PE" },
      headers: { "x-tenant": "acme" },
      params: { id: "42" },
      token: { role: "admin" },
    });
    expect(
      matchesWhen(
        {
          "query.region": "PE",
          "headers.x-tenant": "acme",
          "params.id": 42,
          "token.role": "admin",
        },
        c
      )
    ).toBe(true);
  });

  it("matches if any array element equals the expected primitive", () => {
    const c = ctx({ body: { tags: ["a", "b", "c"] } });
    expect(matchesWhen({ "body.tags": "b" }, c)).toBe(true);
    expect(matchesWhen({ "body.tags": "z" }, c)).toBe(false);
  });

  it("empty when always matches", () => {
    expect(matchesWhen({}, ctx({}))).toBe(true);
  });
});

describe("pickResponse", () => {
  const ok: MatchableResponseDef = { status: 200, body: { kind: "success" } };
  const okAlt: MatchableResponseDef = {
    status: 200,
    body: { kind: "success-alt" },
  };
  const fallback: MatchableResponseDef = {
    status: 200,
    body: { kind: "failure" },
  };

  it("picks the first response whose when matches", () => {
    const c = ctx({ body: { dni: "B" } });
    const out = pickResponse(
      [
        { ...ok, when: { "body.dni": "A" } },
        { ...okAlt, when: { "body.dni": "B" } },
        fallback,
      ],
      c
    );
    expect(out?.body).toEqual({ kind: "success-alt" });
  });

  it("falls back to the first response without when", () => {
    const c = ctx({ body: { dni: "Z" } });
    const out = pickResponse(
      [
        { ...ok, when: { "body.dni": "A" } },
        { ...okAlt, when: { "body.dni": "B" } },
        fallback,
      ],
      c
    );
    expect(out?.body).toEqual({ kind: "failure" });
  });

  it("returns null when nothing matches and no fallback exists", () => {
    const c = ctx({ body: { dni: "Z" } });
    const out = pickResponse(
      [
        { ...ok, when: { "body.dni": "A" } },
        { ...okAlt, when: { "body.dni": "B" } },
      ],
      c
    );
    expect(out).toBeNull();
  });

  it("order matters: first matching wins even if later one also matches", () => {
    const c = ctx({ body: { dni: "X" } });
    const out = pickResponse(
      [
        { ...ok, when: { "body.dni": "X" } },
        { ...okAlt, when: { "body.dni": "X" } },
      ],
      c
    );
    expect(out?.body).toEqual({ kind: "success" });
  });

  it("response without when in first position matches everything", () => {
    const c = ctx({ body: { dni: "anything" } });
    const out = pickResponse([fallback, ok, okAlt], c);
    expect(out?.body).toEqual({ kind: "failure" });
  });

  it("returns single response unchanged when only one and no when", () => {
    const out = pickResponse([ok], ctx({}));
    expect(out?.body).toEqual({ kind: "success" });
  });
});
