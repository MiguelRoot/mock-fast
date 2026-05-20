import { describe, it, expect } from "vitest";
import { renderString } from "../src/templating.js";
import type { TemplateContext } from "../src/templating.js";

const emptyCtx: TemplateContext = {
  params: {},
  query: {},
  headers: {},
  body: undefined,
  token: {},
};

describe("templating — faker helper", () => {
  it("honors hash params (length=48) as options object", () => {
    const out = renderString(
      "{{faker 'string.alphanumeric' length=48}}",
      emptyCtx
    );
    expect(out).toHaveLength(48);
  });

  it("honors hash params for number.int (min/max)", () => {
    for (let i = 0; i < 25; i++) {
      const out = renderString(
        "{{faker 'number.int' min=10 max=20}}",
        emptyCtx
      );
      const n = Number(out);
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(10);
      expect(n).toBeLessThanOrEqual(20);
    }
  });

  it("still works with positional args", () => {
    const out = renderString("{{faker 'string.alphanumeric' 32}}", emptyCtx);
    expect(out).toHaveLength(32);
  });

  it("still works with no args", () => {
    const out = renderString("{{faker 'person.firstName'}}", emptyCtx);
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });

  it("returns empty string for invalid faker path", () => {
    const out = renderString("{{faker 'does.not.exist'}}", emptyCtx);
    expect(out).toBe("");
  });
});
