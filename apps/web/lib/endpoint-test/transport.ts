import { isIP } from "node:net";
import { request as nodeHttpRequest } from "node:http";
import type { RequestOptions as HttpRequestOptions } from "node:http";
import { request as nodeHttpsRequest } from "node:https";
import type { RequestOptions as HttpsRequestOptions } from "node:https";
import type { EndpointRequestOptions, EndpointResponse, EndpointTransport } from "./execute";

// Node http/https transport for the endpoint test. The connection is pinned to
// an address the allow-list guard already approved: a custom `lookup` answers
// node's socket resolution with exactly one pinned address and never consults
// DNS or any fallback resolver, so a later resolution cannot redirect the
// connection. The original hostname is kept for the Host header and for TLS
// `servername`; redirects are never followed; nothing is logged, timed or
// retried. Low-level request factories are injectable so tests stay pure.

const encoder = new TextEncoder();

export interface NodeTransportSocket {
  destroy(error?: Error): void;
}

/** The minimum of node's `ClientRequest` the transport uses. */
export interface NodeTransportRequest {
  on(event: "error", listener: (error: Error) => void): unknown;
  end(body?: string): void;
  destroy(error?: Error): void;
  readonly socket: NodeTransportSocket | null;
}

/** The minimum of node's `IncomingMessage` the transport reads. */
export interface NodeTransportResponse {
  readonly statusCode?: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array>;
}

export interface PinnedAddress {
  readonly address: string;
  readonly family: number;
}

export interface PinnedLookupOptions {
  readonly all?: boolean;
  readonly family?: number;
  readonly hints?: number;
}

export type PinnedLookupCallback = (
  error: Error | null,
  address?: string | readonly PinnedAddress[],
  family?: number,
) => void;

/**
 * Drop-in replacement for node's `lookup`. It ignores the requested hostname and
 * answers with the single pinned address, so the connection is never resolved
 * twice and cannot be redirected by a second DNS answer.
 */
export type PinnedLookup = (
  hostname: string,
  options: PinnedLookupOptions | undefined,
  callback: PinnedLookupCallback,
) => void;

export interface NodeTransportRequestOptions {
  readonly protocol: "http:" | "https:";
  readonly hostname: string;
  readonly port: number;
  readonly path: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  /** A fresh per-request agent or `false`; a pooled socket could bypass the pin. */
  readonly agent: unknown;
  readonly lookup: PinnedLookup;
  /** Present only for https; the original hostname, never the pinned address. */
  readonly servername?: string;
}

export type NodeRequestFactory = (
  options: NodeTransportRequestOptions,
  onResponse: (response: NodeTransportResponse) => void,
) => NodeTransportRequest;

export interface NodeTransportDeps {
  /** Defaults to `node:http`'s `request`. */
  readonly httpRequest?: NodeRequestFactory;
  /** Defaults to `node:https`'s `request`. */
  readonly httpsRequest?: NodeRequestFactory;
  /** Returns the agent for the request, or `undefined` for node's default. */
  readonly agentFactory?: (protocol: "http:" | "https:") => unknown;
}

const defaultHttpRequest: NodeRequestFactory = (options, onResponse) =>
  nodeHttpRequest(
    options as unknown as HttpRequestOptions,
    response => onResponse(response as unknown as NodeTransportResponse),
  ) as unknown as NodeTransportRequest;

const defaultHttpsRequest: NodeRequestFactory = (options, onResponse) =>
  nodeHttpsRequest(
    options as unknown as HttpsRequestOptions,
    response => onResponse(response as unknown as NodeTransportResponse),
  ) as unknown as NodeTransportRequest;

/**
 * Builds a lookup bound to the first usable pinned address. With no usable
 * address it fails closed: the callback receives an error and no resolver is
 * consulted. The family comes from the address itself.
 */
export function createPinnedLookup(pinnedAddresses: readonly string[]): PinnedLookup {
  const pinned = selectPinnedAddress(pinnedAddresses);
  return (_hostname, options, callback) => {
    if (!pinned) {
      callback(new Error("endpoint transport: no pinned address"));
      return;
    }
    if (options?.all) callback(null, [{ address: pinned.address, family: pinned.family }]);
    else callback(null, pinned.address, pinned.family);
  };
}

export function createNodeTransport(deps: NodeTransportDeps = {}): EndpointTransport {
  const httpFactory = deps.httpRequest ?? defaultHttpRequest;
  const httpsFactory = deps.httpsRequest ?? defaultHttpsRequest;
  const agentFactory = deps.agentFactory;

  return {
    start(options: EndpointRequestOptions) {
      let parsed: URL;
      try {
        parsed = new URL(options.url);
      } catch {
        return failClosed(new Error("endpoint transport: invalid url"));
      }
      const protocol =
        parsed.protocol === "https:" ? "https:" : parsed.protocol === "http:" ? "http:" : null;
      if (!protocol) return failClosed(new Error("endpoint transport: unsupported scheme"));
      const pinned = selectPinnedAddress(options.pinnedAddresses);
      if (!pinned) return failClosed(new Error("endpoint transport: no pinned address"));
      const lookup = createPinnedLookup(options.pinnedAddresses);

      const headers: Record<string, string> = { ...options.headers };
      let body: string | undefined;
      if (options.body !== undefined) {
        body = options.body;
        if (!hasHeader(headers, "content-length")) {
          headers["content-length"] = String(encoder.encode(body).byteLength);
        }
      }

      const port = parsed.port ? Number(parsed.port) : protocol === "https:" ? 443 : 80;
      // The original hostname stays in `hostname`, so node writes it into the
      // Host header. For https the same hostname is the SNI `servername`; the
      // pinned address is only ever used by `lookup`.
      const requestOptions: NodeTransportRequestOptions = {
        protocol,
        hostname: parsed.hostname,
        port,
        path: `${parsed.pathname}${parsed.search}`,
        method: options.method,
        headers,
        agent: agentFactory ? agentFactory(protocol) : false,
        lookup,
        ...(protocol === "https:" ? { servername: parsed.hostname } : {}),
      };
      const factory = protocol === "https:" ? httpsFactory : httpFactory;

      let settled = false;
      let request: NodeTransportRequest | null = null;
      const result = new Promise<EndpointResponse>((resolve, reject) => {
        try {
          request = factory(requestOptions, response => {
            if (settled) return;
            settled = true;
            resolve({
              status: response.statusCode ?? 0,
              headers: flattenHeaders(response.headers),
              body: response,
            });
          });
        } catch (error) {
          settled = true;
          reject(toError(error));
          return;
        }
        request.on("error", error => {
          if (settled) return;
          settled = true;
          reject(toError(error));
        });
        if (body === undefined) request.end();
        else request.end(body);
      });

      function abort(): void {
        if (!request) return;
        const socket = request.socket;
        request.destroy();
        socket?.destroy();
      }

      return { result, abort };
    },
  };
}

interface ClosedTransport {
  readonly result: Promise<EndpointResponse>;
  abort(): void;
}

/** A start that refuses to open a connection, used when the pin is unusable. */
function failClosed(error: Error): ClosedTransport {
  return { result: Promise.reject(error), abort: () => {} };
}

function selectPinnedAddress(addresses: readonly string[]): PinnedAddress | null {
  for (const candidate of addresses) {
    const address = candidate.trim();
    const family = isIP(address);
    if (family === 4 || family === 6) return { address, family };
  }
  return null;
}

function hasHeader(headers: Readonly<Record<string, string>>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some(key => key.toLowerCase() === lower);
}

function flattenHeaders(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): Readonly<Record<string, string>> {
  const flat: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    flat[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return Object.freeze(flat);
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
