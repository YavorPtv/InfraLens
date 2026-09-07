import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect } from "chai";
import { createApiApp, type CreateApiAppOptions } from "../src";

export function example(path: string): string {
  return readFileSync(resolve(__dirname, "../../../examples", path), "utf8");
}

export function sharedSourceFiles(): Record<string, string> {
  return Object.fromEntries([
    "ordersHandler.ts", "orderService.ts", "sharedDb.ts", "auditHandler.ts",
    "queueHandler.ts", "queueClient.ts", "unrelated.ts"
  ].map((path) => [path, example(`shared-source-import-graph/${path}`)]));
}

// Each suite owns a temporary HTTP server; no frontend or external network is used.
export function localApi(options: CreateApiAppOptions = {}) {
  let server: Server;
  let baseUrl: string;
  before(async () => {
    server = createApiApp({ writeLog: () => {}, ...options }).listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    if (server !== undefined) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    }
  });
  return async function post<T>(path: string, body?: unknown, expectedStatus = 200): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000)
    });
    const payload = await response.json();
    expect(response.status, JSON.stringify(payload)).to.equal(expectedStatus);
    expect(response.headers.get("content-type")).to.contain("application/json");
    return payload as T;
  };
}
