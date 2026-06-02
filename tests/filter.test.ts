import { describe, it, expect, afterEach } from "vitest";
import { startTestServer, type TestServerHandle } from "./helpers.js";
import type { DslDocument } from "../src/types.js";

let server: TestServerHandle | null = null;

afterEach(async () => {
  if (server) {
    await server.stop();
    server = null;
  }
});

const ANEXOS = [
  { codigo: "11", titulo: "Anexo Museo", descripcion: "11 - ANEXO MUSEO DE LA INQUISICION" },
  { codigo: "12", titulo: "Sede Central", descripcion: "12 - SEDE CENTRAL LIMA" },
  { codigo: "13", titulo: "Otro", descripcion: "13 - ANEXO BIBLIOTECA NEXO" },
];

function dslWith(filter: unknown): DslDocument {
  return {
    routes: [
      {
        url: "/anexos",
        method: "post",
        filter: filter as never,
        response: { status: 200, body: { code: 200, status: "success", data: ANEXOS } },
      },
    ],
  };
}

const post = (base: string, body: unknown) =>
  fetch(base + "/anexos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json());

describe("filter — search an array in the response body (opt-in)", () => {
  it("searches across multiple fields, contains + case-insensitive by default", async () => {
    server = await startTestServer(dslWith({ in: "data", fields: ["titulo", "descripcion"], by: "body.filtro" }));
    const r = await post(server.base, { filtro: "nex" });
    expect(r.data.map((x: any) => x.codigo)).toEqual(["11", "13"]); // ANEXO + NEXO
  });

  it("matches a single field", async () => {
    server = await startTestServer(dslWith({ in: "data", fields: ["titulo"], by: "body.filtro" }));
    const r = await post(server.base, { filtro: "central" });
    expect(r.data.map((x: any) => x.codigo)).toEqual(["12"]);
  });

  it("returns an empty array when nothing matches", async () => {
    server = await startTestServer(dslWith({ in: "data", fields: ["descripcion"], by: "body.filtro" }));
    const r = await post(server.base, { filtro: "zzz" });
    expect(r.data).toEqual([]);
  });

  it("returns everything when the search term is missing or empty", async () => {
    server = await startTestServer(dslWith({ in: "data", fields: ["descripcion"], by: "body.filtro" }));
    expect((await post(server.base, {})).data).toHaveLength(3);
    expect((await post(server.base, { filtro: "" })).data).toHaveLength(3);
  });

  it("op: equals matches exactly", async () => {
    server = await startTestServer(dslWith({ in: "data", fields: ["codigo"], by: "body.filtro", op: "equals" }));
    const r = await post(server.base, { filtro: "12" });
    expect(r.data.map((x: any) => x.codigo)).toEqual(["12"]);
  });

  it("caseSensitive: true respects case", async () => {
    server = await startTestServer(
      dslWith({ in: "data", fields: ["descripcion"], by: "body.filtro", caseSensitive: true })
    );
    expect((await post(server.base, { filtro: "anexo" })).data).toHaveLength(0); // lowercase, no match
    expect((await post(server.base, { filtro: "ANEXO" })).data).toHaveLength(2); // uppercase, matches
  });

  it("leaves the body untouched when there is no filter (default behavior preserved)", async () => {
    server = await startTestServer({
      routes: [{ url: "/anexos", method: "post", response: { status: 200, body: { data: ANEXOS } } }],
    });
    const r = await post(server.base, { filtro: "nex" });
    expect(r.data).toHaveLength(3); // no filter declared → nothing is filtered
  });
});
