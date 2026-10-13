import { checkEndpointTarget, parseAllowedTargets, type TargetDenialReason } from "./allowlist";

// Single-request executor for the endpoint test. Every side effect is injected:
// resolution, transport, clock and timers. The allow-list guard stays the only
// authority on what may be contacted, and nothing here logs or echoes a secret.

export const ENDPOINT_TIMEOUT_MS = 5000;
export const ENDPOINT_BODY_LIMIT = 65_536;
export const ENDPOINT_METHODS = Object.freeze(["GET", "POST", "PUT", "PATCH", "HEAD"]);

const MASK = "[REDACTED]";
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "x-api-key",
  "x-auth-token",
]);

export interface EndpointTestInput {
  readonly url: string;
  readonly method: string;
  readonly headers?: readonly { readonly name: string; readonly value: string }[];
  readonly bodyText?: string;
  readonly allowList: string | undefined;
  readonly secretValues?: readonly string[];
}

export interface EndpointRequestOptions {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  /** Addresses the guard already approved; the transport must connect to one of them. */
  readonly pinnedAddresses: readonly string[];
}

export interface EndpointResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: AsyncIterable<Uint8Array>;
}

export interface EndpointTransport {
  start(options: EndpointRequestOptions): { result: Promise<EndpointResponse>; abort(): void };
}

export interface EndpointIo {
  /** Resolved once, outside this module, so the guard can pin the connection. */
  resolve(host: string): Promise<readonly string[]>;
  readonly transport: EndpointTransport;
  now(): number;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  readonly deadlineMs?: number;
}

export interface EndpointResultHeader {
  readonly name: string;
  readonly value: string;
}

export type EndpointTestResult =
  | {
      readonly kind: "ok";
      readonly status: number;
      readonly timingMs: number;
      readonly headers: readonly EndpointResultHeader[];
      readonly bodyText: string;
      readonly truncated: boolean;
    }
  | { readonly kind: "denied"; readonly reason: TargetDenialReason }
  | { readonly kind: "timeout" }
  | { readonly kind: "network" }
  | { readonly kind: "invalid-input"; readonly reason: string };

export async function executeEndpointTest(
  input: EndpointTestInput,
  io: EndpointIo,
): Promise<EndpointTestResult> {
  const started = io.now();
  let abort: (() => void) | null = null;
  let fireTimeout: () => void = () => {};
  // One deadline covers resolution, connect and body; the race below is what
  // makes a stalled io.resolve settle instead of hanging forever.
  const deadline = new Promise<EndpointTestResult>(resolve => {
    fireTimeout = () => {
      const handle = abort;
      abort = null;
      if (handle) {
        try {
          handle();
        } catch {
          /* Aborting is best effort. */
        }
      }
      resolve({ kind: "timeout" });
    };
  });
  const timer = io.setTimer(fireTimeout, io.deadlineMs ?? ENDPOINT_TIMEOUT_MS);
  try {
    return await Promise.race([attempt(), deadline]);
  } finally {
    io.clearTimer(timer);
  }

  async function attempt(): Promise<EndpointTestResult> {
    const method = input.method.toUpperCase();
    if (!ENDPOINT_METHODS.includes(method)) {
      return { kind: "invalid-input", reason: "method-not-allowed" };
    }
    const body = input.bodyText;
    if (body !== undefined && new TextEncoder().encode(body).byteLength > ENDPOINT_BODY_LIMIT) {
      return { kind: "invalid-input", reason: "body-too-large" };
    }
    let parsed: URL;
    try {
      parsed = new URL(input.url);
    } catch {
      return { kind: "denied", reason: "url-invalid" };
    }
    const targets = parseAllowedTargets(input.allowList);
    // Static pass first: a host the allow-list does not own is never resolved,
    // so the guard cannot become a DNS oracle for an unlisted name.
    const staticCheck = checkEndpointTarget(input.url, targets, []);
    if (!staticCheck.allowed && staticCheck.reason !== "addresses-missing") {
      return { kind: "denied", reason: staticCheck.reason };
    }
    let addresses: readonly string[];
    try {
      addresses = await io.resolve(parsed.hostname.toLowerCase());
    } catch {
      return { kind: "network" };
    }
    const checked = checkEndpointTarget(input.url, targets, addresses);
    if (!checked.allowed) return { kind: "denied", reason: checked.reason };
    const headerRecord: Record<string, string> = {};
    for (const header of input.headers ?? []) headerRecord[header.name] = header.value;
    let response: EndpointResponse;
    try {
      const request = io.transport.start({
        url: input.url,
        method,
        headers: Object.freeze(headerRecord),
        ...(body === undefined ? {} : { body }),
        pinnedAddresses: checked.addresses,
      });
      abort = request.abort;
      response = await request.result;
    } catch {
      return { kind: "network" };
    }
    let read: { text: string; truncated: boolean };
    try {
      read = await readCapped(response.body, ENDPOINT_BODY_LIMIT);
    } catch {
      return { kind: "network" };
    }
    const secrets = input.secretValues ?? [];
    return {
      kind: "ok",
      status: response.status,
      timingMs: io.now() - started,
      headers: redactHeaders(response.headers, secrets),
      bodyText: maskSecrets(read.text, secrets),
      truncated: read.truncated,
    };
  }
}

/** Reads at most `limit` bytes and stops the stream there, reporting the cut. */
async function readCapped(
  body: AsyncIterable<Uint8Array> | undefined,
  limit: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!body) return { text: "", truncated: false };
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for await (const chunk of body) {
    if (total + chunk.byteLength > limit) {
      chunks.push(chunk.subarray(0, limit - total));
      total = limit;
      truncated = true;
      break;
    }
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(joined), truncated };
}

function maskSecrets(text: string, secrets: readonly string[]): string {
  let masked = text;
  for (const secret of secrets) {
    if (secret) masked = masked.split(secret).join(MASK);
  }
  return masked;
}

function redactHeaders(
  headers: Readonly<Record<string, string>>,
  secrets: readonly string[],
): readonly EndpointResultHeader[] {
  return Object.freeze(Object.entries(headers).map(([name, value]) => Object.freeze({
    name,
    value: SENSITIVE_HEADERS.has(name.toLowerCase()) ? MASK : maskSecrets(value, secrets),
  })));
}
