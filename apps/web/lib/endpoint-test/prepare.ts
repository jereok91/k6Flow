// Pure preparation of one endpoint test request: strict parsing of the HTTP
// node parameters, server-side variable rendering and sample resolution for
// references to previous nodes. No IO happens here, and the caller's parameters
// are never mutated. Secret values that were actually rendered are reported so
// the executor can mask them.

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "HEAD"]);
/** The body kinds the panel offers and the shared schema accepts; only json is parsed. */
const BODY_KINDS = new Set(["none", "text", "json", "xml", "form"]);
/** RFC 7230 token, so a header name can never smuggle a separator. */
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

export type EndpointPreparationReason =
  | "invalid-parameters"
  | "method-not-allowed"
  | "invalid-url"
  | "unresolved-reference"
  | "unknown-variable"
  | "invalid-header"
  | "invalid-body"
  | "invalid-json-body";

export interface EndpointTestRequestInput {
  readonly method: string;
  readonly url: string;
  readonly headers: readonly { readonly name: string; readonly value: string }[];
  readonly bodyText?: string;
  readonly secretValues: readonly string[];
}

export interface EndpointPreparationOptions {
  /** Server-resolved variable values, secrets included. Never sent to the client. */
  readonly variables: Readonly<Record<string, string>>;
  /** Variable names whose value must never appear unmasked in a result. */
  readonly secretNames: readonly string[];
  /** Caller-supplied stand-ins for outputs of previous nodes. */
  readonly samples: Readonly<Record<string, string>>;
}

export type EndpointPreparation =
  | { readonly ok: true; readonly input: EndpointTestRequestInput }
  | { readonly ok: false; readonly reason: EndpointPreparationReason };

function failure(reason: EndpointPreparationReason): { ok: false; reason: EndpointPreparationReason } {
  return { ok: false, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function prepareEndpointTest(
  parameters: unknown,
  options: EndpointPreparationOptions,
): EndpointPreparation {
  if (!isRecord(parameters)) return failure("invalid-parameters");
  const method = parameters.method;
  if (typeof method !== "string" || !METHODS.has(method.toUpperCase())) {
    return failure("method-not-allowed");
  }

  const secrets = new Set(options.secretNames);
  const used = new Set<string>();

  const render = (template: string): string | { ok: false; reason: EndpointPreparationReason } => {
    let rendered = "";
    let index = 0;
    for (const match of template.matchAll(PLACEHOLDER)) {
      rendered += template.slice(index, match.index);
      const value = options.variables[match[1]];
      if (typeof value !== "string") return failure("unknown-variable");
      if (secrets.has(match[1])) used.add(value);
      rendered += value;
      index = (match.index ?? 0) + match[0].length;
    }
    return rendered + template.slice(index);
  };

  const readValue = (value: unknown): string | { ok: false; reason: EndpointPreparationReason } => {
    if (!isRecord(value)) return failure("invalid-parameters");
    if (value.kind === "literal") {
      return typeof value.value === "string" ? render(value.value) : failure("invalid-parameters");
    }
    if (value.kind === "reference") {
      // The panel and the canonical traversal keep a producer reference wrapped:
      // { kind: "reference", reference: { producerNodeId, output } }. Reading the flat
      // form here silently refused every node whose url or header is a reference.
      const reference = value.reference;
      if (!isRecord(reference)) return failure("invalid-parameters");
      const { producerNodeId, output } = reference;
      if (typeof producerNodeId !== "string" || typeof output !== "string") {
        return failure("invalid-parameters");
      }
      const sample = options.samples[`${producerNodeId}:${output}`];
      if (typeof sample !== "string" || sample.length === 0) return failure("unresolved-reference");
      // The sample stands in for a produced value, so mask it in any result too.
      used.add(sample);
      return sample;
    }
    return failure("invalid-parameters");
  };

  const url = readValue(parameters.url);
  if (typeof url !== "string") return url;
  if (url.length === 0) return failure("invalid-url");

  let bodyText: string | undefined;
  if (parameters.body !== undefined) {
    const body = parameters.body;
    if (!isRecord(body) || typeof body.kind !== "string" || !BODY_KINDS.has(body.kind)) {
      return failure("invalid-body");
    }
    if (body.kind !== "none") {
      // The panel and the canonical traversal keep a slot wrapped, exactly like url and
      // headers: { kind: "literal", value } or { kind: "reference", reference: {...} }.
      // Requiring a raw string here refused every node whose body is set.
      const bodyValue = readValue(body.value);
      if (typeof bodyValue !== "string") {
        // A malformed slot is a structurally wrong body; any specific reason the value
        // reader produced (unknown-variable, unresolved-reference) is kept as is, so the
        // body answers exactly like url and headers for the same mistake.
        return failure(bodyValue.reason === "invalid-parameters" ? "invalid-body" : bodyValue.reason);
      }
      const rendered = bodyValue;
      if (body.kind === "json") {
        if (rendered.length > 0) {
          try {
            JSON.parse(rendered);
          } catch {
            return failure("invalid-json-body");
          }
          bodyText = rendered;
        }
      } else if (rendered.length > 0) {
        bodyText = rendered;
      }
    }
  }

  const headerInputs = parameters.headers ?? [];
  if (!Array.isArray(headerInputs)) return failure("invalid-header");
  const headers: { name: string; value: string }[] = [];
  for (const header of headerInputs) {
    if (!isRecord(header) || typeof header.name !== "string" || !HEADER_NAME.test(header.name)) {
      return failure("invalid-header");
    }
    const value = readValue(header.value);
    if (typeof value !== "string") return value;
    headers.push({ name: header.name, value });
  }

  return {
    ok: true,
    input: Object.freeze({
      method: method.toUpperCase(),
      url,
      headers: Object.freeze(headers.map(header => Object.freeze({ ...header }))),
      bodyText,
      secretValues: Object.freeze([...used]),
    }),
  };
}
