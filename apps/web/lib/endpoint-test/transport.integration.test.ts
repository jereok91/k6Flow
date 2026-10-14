import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, expect, it } from "vitest";
import { createNodeTransport } from "./transport";

// Integration over a real loopback socket. The loopback address is only ever a
// stand-in for "an address the guard already approved": the guard itself always
// denies loopback, so nothing here weakens the product rule. What this proves is
// the real node adapter path that the injected unit tests cannot: the custom
// lookup is what makes the connection land, a hostname that does not resolve is
// never looked up in DNS, the original hostname survives into the Host header,
// the response stream iterates, and abort tears the request down.

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<number> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  return typeof address === "object" && address !== null ? address.port : 0;
}

async function readAll(body: AsyncIterable<Uint8Array> | undefined): Promise<string> {
  if (!body) return "";
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) chunks.push(chunk);
  return new TextDecoder().decode(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))));
}

it("reaches the pinned address for a hostname that does not resolve", async () => {
  let seen = "";
  let received = "";
  const port = await listen((req, res) => {
    seen = `${req.method} ${req.url} host=${req.headers.host ?? ""}`;
    req.on("data", chunk => { received += chunk.toString(); });
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("hello-real");
    });
  });

  const transport = createNodeTransport();
  const request = transport.start({
    url: `http://pinned.invalid:${port}/real?x=1`,
    method: "POST",
    headers: { accept: "text/plain" },
    body: "body-real",
    pinnedAddresses: ["127.0.0.1"],
  });

  const response = await request.result;
  expect(response.status).toBe(200);
  expect(await readAll(response.body)).toBe("hello-real");
  // The hostname never resolves, so only the pinned lookup can explain this.
  expect(seen).toBe(`POST /real?x=1 host=pinned.invalid:${port}`);
  expect(received).toBe("body-real");
});

it("returns a redirect without following it", async () => {
  let requests = 0;
  const port = await listen((_req, res) => {
    requests += 1;
    res.writeHead(302, { location: "http://pinned.invalid/elsewhere" });
    res.end();
  });

  const transport = createNodeTransport();
  const response = await transport.start({
    url: `http://pinned.invalid:${port}/moved`,
    method: "GET",
    headers: {},
    pinnedAddresses: ["127.0.0.1"],
  }).result;

  expect(response.status).toBe(302);
  expect(requests).toBe(1);
});

it("rejects when the request is aborted before a response", async () => {
  const port = await listen(() => {
    /* Never responds, so the abort is the only way out. */
  });

  const transport = createNodeTransport();
  const request = transport.start({
    url: `http://pinned.invalid:${port}/stall`,
    method: "GET",
    headers: {},
    pinnedAddresses: ["127.0.0.1"],
  });

  request.abort();
  await expect(request.result).rejects.toBeTruthy();
});

it("fails closed without contacting anything when no address is pinned", async () => {
  const port = await listen((_req, res) => res.end("never"));
  const attempted = createServer();
  servers.push(attempted);

  const transport = createNodeTransport();
  const request = transport.start({
    url: `http://pinned.invalid:${port}/x`,
    method: "GET",
    headers: {},
    pinnedAddresses: [],
  });
  await expect(request.result).rejects.toBeTruthy();
});
