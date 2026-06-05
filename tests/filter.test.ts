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

const UBIC = [
  { codigoSede: "11", codigoOficina: "1", codigoEstado: "A", nombre: "U1" },
  { codigoSede: "11", codigoOficina: "1", codigoEstado: "I", nombre: "U2" },
  { codigoSede: "11", codigoOficina: "2", codigoEstado: "A", nombre: "U3" },
  { codigoSede: "22", codigoOficina: "1", codigoEstado: "A", nombre: "U4" },
];

const eqFilter = (field: string) => ({ in: "data", fields: [field], by: `body.${field}`, op: "equals" });

const postU = (base: string, body: unknown) =>
  fetch(base + "/ubic", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json());

describe("filters (AND) — several optional filters narrowing one array", () => {
  function dsl(extra: Record<string, unknown> = {}) {
    return {
      routes: [
        {
          url: "/ubic",
          method: "post",
          filters: [eqFilter("codigoSede"), eqFilter("codigoOficina"), eqFilter("codigoEstado")],
          ...extra,
          response: { status: 200, body: { data: UBIC, total: 0 } },
        },
      ],
    } as unknown as DslDocument;
  }

  it("AND of three filters", async () => {
    server = await startTestServer(dsl());
    const r = await postU(server.base, { codigoSede: "11", codigoOficina: "1", codigoEstado: "A" });
    expect(r.data.map((x: any) => x.nombre)).toEqual(["U1"]);
  });

  it("skips filters whose term is empty (optional params)", async () => {
    server = await startTestServer(dsl());
    const r = await postU(server.base, { codigoSede: "11", codigoOficina: "", codigoEstado: "" });
    expect(r.data.map((x: any) => x.nombre)).toEqual(["U1", "U2", "U3"]); // only sede applied
  });

  it("no filters at all → full list", async () => {
    server = await startTestServer(dsl());
    const r = await postU(server.base, {});
    expect(r.data).toHaveLength(4);
  });
});

describe("paginate — returns one page and (optionally) the total", () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ id: i + 1 }));

  function dsl(paginate: Record<string, unknown>) {
    return {
      routes: [
        {
          url: "/ubic",
          method: "post",
          paginate,
          response: { status: 200, body: { data: many, total: 0 } },
        },
      ],
    } as unknown as DslDocument;
  }

  it("returns the requested page and writes the total (before paging)", async () => {
    server = await startTestServer(dsl({ of: "data", page: "body.page", size: "body.pageSize", total: "total" }));
    const r = await postU(server.base, { page: "1", pageSize: "10" });
    expect(r.data).toHaveLength(10);
    expect(r.data[0].id).toBe(1);
    expect(r.total).toBe(25);
  });

  it("last partial page", async () => {
    server = await startTestServer(dsl({ of: "data", page: "body.page", size: "body.pageSize" }));
    const r = await postU(server.base, { page: "3", pageSize: "10" });
    expect(r.data.map((x: any) => x.id)).toEqual([21, 22, 23, 24, 25]);
  });

  it("missing page/size → page 1 with defaultSize", async () => {
    server = await startTestServer(dsl({ of: "data", page: "body.page", size: "body.pageSize", defaultSize: 5 }));
    const r = await postU(server.base, {});
    expect(r.data).toHaveLength(5);
  });

  it("filters then paginate (combined)", async () => {
    server = await startTestServer({
      routes: [
        {
          url: "/ubic",
          method: "post",
          filters: [eqFilter("codigoSede")],
          paginate: { of: "data", page: "body.page", size: "body.pageSize", total: "total" },
          response: { status: 200, body: { data: UBIC, total: 0 } },
        },
      ],
    } as unknown as DslDocument);
    const r = await postU(server.base, { codigoSede: "11", page: "1", pageSize: "2" });
    expect(r.data).toHaveLength(2); // 3 match, page size 2
    expect(r.total).toBe(3); // total = matched count, before paging
  });
});
