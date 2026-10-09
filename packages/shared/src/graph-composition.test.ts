import { describe, expect, it } from "vitest";
import { graphDraftCompositionSchema, graphReadyCompositionSchema } from "./graph-composition";
import * as shared from "./index";

type Ref = { producerNodeId: string; output: string };
const literal = (value: unknown) => ({ kind: "literal", value });
const referenceValue = (reference: Ref) => ({ kind: "reference", reference });
const refTo = (output: string): Ref => ({ producerNodeId: "producer", output });
const tokenReference = { producerNodeId: "auth", output: "token" };
const tokenOutput = { name: "token", selector: { kind: "json-path", path: ["token"] },
  expectedType: "string", required: true };
const jsonOutput = { ...tokenOutput, name: "profile", expectedType: "json" };
const csvOutput = { header: "user", name: "username", expectedType: "string", required: true };

const authParameters = (outputs: unknown[] = [tokenOutput], request: Record<string, unknown> = {}) => ({
  method: { kind: "http", request: { method: "POST", url: literal("https://example.test/login"),
    body: { kind: "none" }, ...request } },
  outputs, onOutputFailure: "stop-current-vu-iteration",
});
const httpParameters = (extra: Record<string, unknown> = {}) =>
  ({ method: "GET", url: literal("https://example.test"), ...extra });
const checkParameters = (response: unknown) => ({ version: 1, response,
  checks: [{ name: "ok", kind: "status", operator: "eq", expected: 200 }],
  onCheckFailure: "record-failure-and-continue" });
const csvParameters = (outputs: unknown[] = [csvOutput]) => ({ version: 1,
  attachment: { id: "users.csv" }, allocation: "csv-order-distinct-row-per-vu",
  onInsufficientCapacity: "reject-before-execution", outputs });
const load = { version: 1, profile: { kind: "constant-vus", vus: 1, durationMs: 1000 },
  thresholds: [], thresholdPolicy: "final-pass-fail" };

const node = (id: string, kind: string, references: unknown[] = [], parameters?: unknown) =>
  (parameters === undefined ? { id, kind, references } : { id, kind, references, parameters });
const draft = (nodes: unknown[], connections: unknown[] = [], extra: Record<string, unknown> = {}) =>
  ({ version: 1, nodes, connections, ...extra });
const parseDraft = (input: unknown) => graphDraftCompositionSchema.safeParse(input);
const parseReady = (input: unknown) => graphReadyCompositionSchema.safeParse(input);

const authNode = node("auth", "authentication", [], authParameters());
const requestNode = node("request", "http-request", [tokenReference],
  httpParameters({ headers: [{ name: "Authorization", value: referenceValue(tokenReference) }] }));
const checksReference = { producerNodeId: "request", output: "response" };
const checksNode = node("checks", "response-validation", [checksReference],
  checkParameters(checksReference));
const connections = [{ source: "auth", target: "request" }, { source: "request", target: "checks" }];
const readyChain = { ...draft([authNode, requestNode, checksNode], connections), load };

describe("typed draft graph composition", () => {
  it("retains incomplete drafts without parameters, connections or load", () => {
    expect(parseDraft(draft([])).success).toBe(true);
    const incomplete = draft([node("a", "authentication"), node("b", "http-request"),
      node("c", "response-validation"), node("d", "user-pool")]);
    expect(parseDraft(incomplete).success).toBe(true);
    expect(parseDraft({ ...incomplete, load }).success).toBe(true);
  });

  it("accepts fully valid parameters for every kind", () => {
    expect(graphDraftCompositionSchema.parse(draft([authNode]))).toEqual(draft([authNode]));
    expect(parseDraft(draft([node("pool", "user-pool", [], csvParameters())])).success).toBe(true);
    expect(parseDraft(draft([authNode, requestNode, checksNode], connections)).success).toBe(true);
  });

  it.each([
    node("a", "authentication", [], { outputs: [] }),
    node("b", "http-request", [], { method: "GET" }),
    node("c", "response-validation", [], { version: 1 }),
    node("d", "user-pool", [], { version: 1, outputs: [] }),
  ])("rejects invalid partial parameters %# instead of retaining them", (typed) => {
    expect(parseDraft(draft([typed])).success).toBe(false);
  });

  it("rejects unknown kinds, unknown fields and invalid optional load", () => {
    expect(parseDraft(draft([node("x", "basic-auth")])).success).toBe(false);
    expect(parseDraft(draft([{ ...node("x", "http-request"), extra: true }])).success).toBe(false);
    expect(parseDraft({ ...draft([]), load: { version: 1 }, extra: 1 }).success).toBe(false);
    expect(parseDraft({ ...draft([]), load: { version: 1 } }).success).toBe(false);
  });

  it("keeps later-producer references while editing", () => {
    expect(parseDraft(draft([requestNode, authNode],
      [{ source: "request", target: "auth" }])).success).toBe(true);
  });
});

describe("composition reference reconciliation", () => {
  it("ignores declared order and duplicates", () => {
    const doubled = node("request", "http-request", [tokenReference, tokenReference],
      requestNode.parameters);
    expect(parseDraft(draft([authNode, doubled])).success).toBe(true);
  });

  it("rejects dangling declared and undeclared embedded references", () => {
    const dangling = node("request", "http-request", [tokenReference], httpParameters());
    expect(parseDraft(draft([authNode, dangling])).success).toBe(false);
    const undeclared = node("request", "http-request", [], requestNode.parameters);
    expect(parseDraft(draft([authNode, undeclared])).success).toBe(false);
    const bare = node("request", "http-request", [tokenReference]);
    expect(parseDraft(draft([authNode, bare])).success).toBe(false);
  });

  it("reconciles references embedded in authentication request fields", () => {
    const pool = node("pool", "user-pool", [], csvParameters());
    const username = { producerNodeId: "pool", output: "username" };
    const embedded = node("auth", "authentication", [],
      authParameters([tokenOutput], { url: referenceValue(username) }));
    expect(parseDraft(draft([pool, embedded])).success).toBe(false);
    const declared = node("auth", "authentication", [username], embedded.parameters);
    expect(parseDraft(draft([pool, declared])).success).toBe(true);
  });

  it("never treats reference-shaped literal JSON as a reference", () => {
    // JSON body is now a string, not a parsed JSON object
    const body = { kind: "json", value: literal(JSON.stringify({ kind: "reference", reference: tokenReference })) };
    const literalData = node("request", "http-request", [], httpParameters({ body }));
    expect(parseDraft(draft([authNode, literalData])).success).toBe(true);
  });
});

describe("producer output catalog and slot compatibility", () => {
  const producerNode = (kind: string, parameters?: unknown) => node("producer", kind, [], parameters);
  const consumer = (reference: Ref, parameters: unknown, kind = "http-request") =>
    node("consume", kind, [reference], parameters);
  const viaUrl = (r: Ref) => consumer(r, httpParameters({ url: referenceValue(r) }));
  const viaHeader = (r: Ref) =>
    consumer(r, httpParameters({ headers: [{ name: "X-Ref", value: referenceValue(r) }] }));
  const viaText = (r: Ref) => consumer(r, httpParameters({ body: { kind: "text", value: referenceValue(r) } }));
  const viaJson = (r: Ref) => consumer(r, httpParameters({ body: { kind: "json", value: referenceValue(r) } }));
  const viaQuery = (r: Ref) =>
    consumer(r, httpParameters({ query: [{ name: "q", value: referenceValue(r) }] }));
  const viaChecks = (r: Ref) => consumer(r, checkParameters(r), "response-validation");
  const authProducer = (outputs: unknown[] = [tokenOutput]) =>
    producerNode("authentication", authParameters(outputs));

  it.each([
    ["string output to url", authProducer(), viaUrl(refTo("token")), true],
    ["string output to header", authProducer(), viaHeader(refTo("token")), true],
    ["string output to text body", authProducer(), viaText(refTo("token")), true],
    ["string output to JSON body", authProducer(), viaJson(refTo("token")), true],
    ["JSON output to JSON body", authProducer([jsonOutput]), viaJson(refTo("profile")), true],
    ["JSON output to string slot", authProducer([jsonOutput]), viaHeader(refTo("profile")), false],
    ["CSV string to query", producerNode("user-pool", csvParameters()), viaQuery(refTo("username")), true],
    ["built-in response to checks", producerNode("http-request", httpParameters()), viaChecks(refTo("response")), true],
    ["built-in response to string slot", producerNode("http-request", httpParameters()), viaHeader(refTo("response")), false],
    ["string output to checks", authProducer(), viaChecks(refTo("token")), false],
    ["unknown declared output", authProducer(), viaHeader(refTo("missing")), false],
    ["authentication without parameters", producerNode("authentication"), viaHeader(refTo("token")), false],
    ["response-validation exposes nothing", producerNode("response-validation"), viaHeader(refTo("x")), false],
    ["built-in response without parameters", producerNode("http-request"), viaChecks(refTo("response")), true],
  ])("%s", (_label, producer, consumerNode, expected) => {
    expect(parseDraft(draft([producer, consumerNode])).success).toBe(expected);
  });

  it("reserves the built-in output name response", () => {
    expect(parseDraft(draft([authProducer([{ ...tokenOutput, name: "response" }])])).success).toBe(false);
    const reserved = csvParameters([{ ...csvOutput, name: "response" }]);
    expect(parseDraft(draft([producerNode("user-pool", reserved)])).success).toBe(false);
  });
});

describe("typed ready graph composition", () => {
  it("accepts a complete linear graph with global load without mutating input", () => {
    const snapshot = JSON.parse(JSON.stringify(readyChain));
    const parsed = graphReadyCompositionSchema.parse(readyChain);
    expect(parsed).toEqual(readyChain);
    expect(parsed).not.toBe(readyChain);
    expect(readyChain).toEqual(snapshot);
  });

  it("requires parameters on every node and a top-level load", () => {
    const missing = [authNode, node("request", "http-request", [tokenReference]), checksNode];
    expect(parseReady({ ...draft(missing, connections), load }).success).toBe(false);
    expect(parseReady(draft([authNode, requestNode, checksNode], connections)).success).toBe(false);
  });

  it("requires the reviewed linear topology and producer precedence", () => {
    const fork = [...connections, { source: "auth", target: "checks" }];
    expect(parseReady({ ...readyChain, connections: fork }).success).toBe(false);
    expect(parseReady({ ...draft([]), load }).success).toBe(false);
    const reversed = draft([requestNode, authNode], [{ source: "request", target: "auth" }]);
    expect(parseReady({ ...reversed, load }).success).toBe(false);
  });

  it("accepts one parameterized node with load", () => {
    const single = draft([node("only", "http-request", [], httpParameters())]);
    expect(parseReady({ ...single, load }).success).toBe(true);
  });

  it("exposes schemas and inferred types through the public entry point", () => {
    expect(shared.graphDraftCompositionSchema).toBe(graphDraftCompositionSchema);
    expect(shared.graphReadyCompositionSchema).toBe(graphReadyCompositionSchema);
    const parsed: shared.GraphDraftComposition = shared.graphDraftCompositionSchema.parse(readyChain);
    expect(parsed.nodes).toHaveLength(3);
    // @ts-expect-error Typed nodes cannot attach parameters of another kind.
    const mismatched: shared.GraphReadyComposition["nodes"][number] = { id: "x", kind: "http-request", references: [], parameters: checkParameters(checksReference) };
    expect(parseReady({ ...draft([mismatched]), load }).success).toBe(false);
  });
});

describe("composition editor metadata", () => {
  const meta = { label: "Login API", position: { x: 120, y: 80 } };

  it("accepts and preserves metadata on draft and ready nodes", () => {
    const labelled = { ...authNode, ...meta };
    expect(graphDraftCompositionSchema.parse(draft([labelled]))).toEqual(draft([labelled]));
    const ready = { ...readyChain, nodes: [labelled, requestNode, checksNode] };
    expect(graphReadyCompositionSchema.parse(ready)).toEqual(ready);
  });

  it("still parses old graphs without metadata", () => {
    expect(graphReadyCompositionSchema.parse(readyChain)).toEqual(readyChain);
  });

  it("rejects malformed metadata through the composition", () => {
    expect(parseDraft(draft([{ ...authNode, label: "" }])).success).toBe(false);
    expect(parseDraft(draft([{ ...authNode, disabled: 1 }])).success).toBe(false);
  });

  it("keeps disabled nodes in a ready graph when bypassed safely", () => {
    const extra = node("extra", "http-request", [], httpParameters());
    const ready = { ...readyChain,
      nodes: [authNode, requestNode, { ...extra, disabled: true }, checksNode],
      connections: [{ source: "auth", target: "request" }, { source: "request", target: "extra" },
        { source: "extra", target: "checks" }] };
    const parsed = graphReadyCompositionSchema.parse(ready);
    expect(parsed.nodes).toHaveLength(4);
    expect(parsed.nodes[2]).toMatchObject({ id: "extra", disabled: true });
  });

  it("saves a draft with an enabled consumer of a disabled producer but refuses it as ready", () => {
    const nodes = [{ ...authNode, disabled: true }, requestNode, checksNode];
    expect(parseDraft(draft(nodes, connections)).success).toBe(true);
    const result = parseReady({ ...readyChain, nodes });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toContain("Reference producer is disabled");
      expect(result.error.issues[0]?.path).toEqual(["nodes", 1, "references", 0, "producerNodeId"]);
    }
  });
});
