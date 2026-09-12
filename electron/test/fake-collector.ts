import type { Socket } from "node:net";
import type { AddressInfo } from "node:net";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
const lines = (
  await readFile(new URL("../../protocol/fixtures/stream.jsonl", import.meta.url), "utf8")
)
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
export const fixtureHello = lines[0],
  fixtureEvent = lines[1],
  fixtureHealth = lines[2];
export const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export async function until(test: () => unknown, ms = 8000) {
  const deadline = performance.now() + ms;
  while (!test()) {
    if (performance.now() > deadline)
      throw new Error("Timed out waiting for synthetic transport state.");
    await wait(10);
  }
}
export async function fakeCollector({
  status = 200,
  heartbeatStatus = 204,
  health = true,
  hello = true,
  rawHello,
  contentType = "application/x-ndjson",
}: {
  status?: number;
  heartbeatStatus?: number;
  health?: boolean;
  hello?: boolean;
  rawHello?: string;
  contentType?: string;
} = {}) {
  const sockets = new Set<Socket>();
  const state = {
    status,
    heartbeatStatus,
    health,
    hello,
    stream: null as http.ServerResponse | null,
    connectionId: null as string | null,
    sequence: 0,
    lease: 0,
    requests: [] as {
      path?: string;
      method?: string;
      authorization: boolean;
      connection: string | string[] | undefined;
      port?: number;
    }[],
    requestCount: 0,
    streamCount: 0,
    heartbeats: 0,
    peakSockets: 0,
    knownDrops: { ...fixtureHealth.known_drops },
    expired: 0,
    written: 0,
    refused: 0,
  };
  const server = http.createServer((request, response) => {
    state.requestCount++;
    if (state.requests.length < 256)
      state.requests.push({
        path: request.url,
        method: request.method,
        authorization: request.headers.authorization === "Bearer synthetic-test-token",
        connection: request.headers["x-connection-id"],
        port: request.socket.remotePort,
      });
    if (request.headers.authorization !== "Bearer synthetic-test-token") {
      response.writeHead(401).end();
      return;
    }
    if (request.url === "/v1/heartbeat" && request.method === "POST") {
      state.heartbeats++;
      const code =
        state.heartbeatStatus === 204 && request.headers["x-connection-id"] !== state.connectionId
          ? 409
          : state.heartbeatStatus;
      if (code === 204) state.lease = performance.now();
      if (code !== 0) response.writeHead(code).end();
      return;
    }
    if (request.url !== "/v1/stream" || request.method !== "GET") {
      response.writeHead(404).end();
      return;
    }
    state.streamCount++;
    if (state.status !== 200) {
      if (state.status)
        response.writeHead(state.status, { Location: "http://127.0.0.1:1/forbidden" }).end();
      return;
    }
    if (state.stream && !state.stream.destroyed) {
      response.writeHead(409).end();
      return;
    }
    response.useChunkedEncodingByDefault = false;
    response.writeHead(200, { "Content-Type": contentType, Connection: "close" });
    response.flushHeaders();
    state.stream = response;
    state.connectionId = randomUUID();
    state.sequence = 0;
    state.lease = performance.now();
    if (hello)
      response.write(
        rawHello ?? JSON.stringify({ ...fixtureHello, connection_id: state.connectionId }) + "\n",
      );
  });
  server.maxConnections = 4;
  server.on("connection", (socket) => {
    sockets.add(socket);
    state.peakSockets = Math.max(state.peakSockets, sockets.size);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const raw = (data: string | Buffer) => {
    if (
      !state.stream ||
      state.stream.destroyed ||
      state.stream.writableLength + data.length > 512 * 1024
    ) {
      state.refused++;
      return false;
    }
    state.written += data.length;
    state.stream.write(data);
    return true;
  };
  const timer = setInterval(() => {
    if (!state.stream || state.stream.destroyed) return;
    if (performance.now() - state.lease >= 6000) {
      state.expired++;
      state.stream.destroy();
      return;
    }
    if (state.health)
      raw(
        JSON.stringify({
          ...fixtureHealth,
          connection_id: state.connectionId,
          known_drops: state.knownDrops,
        }) + "\n",
      );
  }, 1000);
  return {
    state,
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    raw,
    event(message = fixtureEvent) {
      return raw(
        JSON.stringify({
          ...message,
          connection_id: state.connectionId,
          sequence: ++state.sequence,
        }) + "\n",
      );
    },
    disconnect() {
      state.stream?.destroy();
    },
    async close() {
      clearInterval(timer);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
