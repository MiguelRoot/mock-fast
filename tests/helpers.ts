import { createMockFast, type MockFastInstance } from "../src/index.js";
import type { DslDocument } from "../src/types.js";

export interface TestServerHandle extends MockFastInstance {
  base: string;
}

export async function startTestServer(
  dsl: DslDocument
): Promise<TestServerHandle> {
  const server = await createMockFast({
    dsl,
    port: 0,
    adminPort: 0,
    watch: false,
    silent: true,
  });
  await server.start();
  return Object.assign(server, { base: server.url() });
}

export function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" }))
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  const body = Buffer.from(JSON.stringify(payload))
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `${header}.${body}.fakesig`;
}

export function bearer(payload: Record<string, unknown>): string {
  return `Bearer ${makeJwt(payload)}`;
}
