import { expect, it } from "vitest";
import { prepareEndpointTest } from "./prepare";

const options = {
  variables: { BASE: "https://api.example.test", TOKEN: "s3cr3t-token", NAME: "ana" },
  secretNames: ["TOKEN"],
  samples: { "auth-1:accessToken": "sample-token" },
};

const http = (over: Record<string, unknown> = {}) => ({
  method: "GET",
  url: { kind: "literal", value: "{{BASE}}/users/{{NAME}}" },
  headers: [],
  body: { kind: "none" },
  ...over,
});

it("renders literal placeholders, inlining non-secrets", () => {
  const result = prepareEndpointTest(http(), options);
  expect(result).toEqual({
    ok: true,
    input: {
      method: "GET",
      url: "https://api.example.test/users/ana",
      headers: [],
      bodyText: undefined,
      secretValues: [],
    },
  });
});

it("tracks every secret value it actually rendered", () => {
  const result = prepareEndpointTest(http({
    url: { kind: "literal", value: "{{BASE}}/me" },
    headers: [{ name: "Authorization", value: { kind: "literal", value: "Bearer {{TOKEN}}" } }],
  }), options);
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) return;
  expect(result.input.headers).toEqual([{ name: "Authorization", value: "Bearer s3cr3t-token" }]);
  expect(result.input.secretValues).toEqual(["s3cr3t-token"]);
});

it("does not list a secret that was never used", () => {
  const result = prepareEndpointTest(http({ url: { kind: "literal", value: "{{BASE}}" } }), options);
  expect(result).toMatchObject({ ok: true, input: { secretValues: [] } });
});

it("fills wrapped references from the supplied sample and masks it too", () => {
  const result = prepareEndpointTest(http({
    url: { kind: "reference", reference: { producerNodeId: "auth-1", output: "accessToken" } },
    headers: [{
      name: "X-Auth",
      value: { kind: "reference", reference: { producerNodeId: "auth-1", output: "accessToken" } },
    }],
  }), options);
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) return;
  expect(result.input.url).toBe("sample-token");
  expect(result.input.headers).toEqual([{ name: "X-Auth", value: "sample-token" }]);
  expect(result.input.secretValues).toEqual(["sample-token"]);
});

it.each([
  ["no reference object", { kind: "reference" }],
  ["reference without an output", { kind: "reference", reference: { producerNodeId: "auth-1" } }],
  ["reference with a non-string id", { kind: "reference", reference: { producerNodeId: 7, output: "x" } }],
  ["flat reference as legacy noise", { kind: "reference", producerNodeId: "auth-1", output: "x" }],
])("refuses a malformed reference slot: %s", (_label, url) => {
  expect(prepareEndpointTest(http({ url }), options)).toEqual({ ok: false, reason: "invalid-parameters" });
});

it("refuses a reference without a sample", () => {
  const result = prepareEndpointTest(http({
    url: { kind: "reference", reference: { producerNodeId: "auth-1", output: "other" } },
  }), options);
  expect(result).toEqual({ ok: false, reason: "unresolved-reference" });
});

it("refuses an unknown variable without inventing a value", () => {
  expect(prepareEndpointTest(http({ url: { kind: "literal", value: "{{NOPE}}/x" } }), options))
    .toEqual({ ok: false, reason: "unknown-variable" });
});

it.each([
  ["missing url", http({ url: undefined })],
  ["empty url", http({ url: { kind: "literal", value: "" } })],
  ["bad url kind", http({ url: { kind: "weird", value: "x" } })],
  ["url not an object", http({ url: "https://api.example.test" })],
  ["bad method", http({ method: "DELETE" })],
  ["missing method", http({ method: undefined })],
  ["headers not a list", http({ headers: "x" })],
  ["header without a name", http({ headers: [{ value: { kind: "literal", value: "x" } }] })],
  ["header name with a space", http({ headers: [{ name: "bad name", value: { kind: "literal", value: "x" } }] })],
  ["bad header value kind", http({ headers: [{ name: "accept", value: { kind: "weird" } }] })],
  ["unsupported body kind", http({ body: { kind: "multipart", value: "x" } })],
  ["request not an object", "nope"],
  ["request null", null],
])("refuses %s", (_name, parameters) => {
  const result = prepareEndpointTest(parameters, options);
  expect(result.ok).toBe(false);
});

it("keeps a json body only when it parses", () => {
  const good = prepareEndpointTest(http({
    method: "POST", body: { kind: "json", value: { kind: "literal", value: '{"name":"{{NAME}}"}' } },
  }), options);
  expect(good).toMatchObject({ ok: true, input: { bodyText: '{"name":"ana"}', method: "POST" } });
  expect(prepareEndpointTest(http({ method: "POST", body: { kind: "json", value: { kind: "literal", value: "{oops" } } }), options))
    .toEqual({ ok: false, reason: "invalid-json-body" });
});

it("accepts the wrapped body slot the panel and the graph actually store", () => {
  // The panel writes { kind, value: { kind: "literal", value } } and the panel fixture
  // records the same shape for body, so a raw-string body is not a graph shape at all.
  const wrapped = { kind: "json", value: { kind: "literal", value: '{"name":"{{NAME}}"}' } };
  expect(prepareEndpointTest(http({ method: "POST", body: wrapped }), options))
    .toMatchObject({ ok: true, input: { bodyText: '{"name":"ana"}', method: "POST" } });
  const wrappedText = { kind: "text", value: { kind: "literal", value: "hi {{NAME}}" } };
  expect(prepareEndpointTest(http({ method: "POST", body: wrappedText }), options))
    .toMatchObject({ ok: true, input: { bodyText: "hi ana" } });
});

it("renders a text body and drops an empty one", () => {
  expect(prepareEndpointTest(http({ method: "POST", body: { kind: "text", value: { kind: "literal", value: "hi {{NAME}}" } } }), options))
    .toMatchObject({ ok: true, input: { bodyText: "hi ana" } });
  expect(prepareEndpointTest(http({ method: "POST", body: { kind: "text", value: { kind: "literal", value: "" } } }), options))
    .toMatchObject({ ok: true, input: { bodyText: undefined } });
});

it.each(["text", "json", "xml", "form"])(
  "keeps unknown-variable for a %s body, exactly as url and headers do",
  kind => {
    const result = prepareEndpointTest(http({
      method: "POST", body: { kind, value: { kind: "literal", value: "{{MISSING}}" } },
    }), options);
    expect(result).toEqual({ ok: false, reason: "unknown-variable" });
  },
);

it("keeps unresolved-reference for a body reference without a sample", () => {
  const result = prepareEndpointTest(http({
    method: "POST",
    body: { kind: "text", value: { kind: "reference", reference: { producerNodeId: "auth-1", output: "other" } } },
  }), options);
  expect(result).toEqual({ ok: false, reason: "unresolved-reference" });
});

it.each([
  ["missing value", { kind: "text" }],
  ["raw string value", { kind: "xml", value: "<a/>" }],
  ["unknown slot kind", { kind: "form", value: { kind: "weird", value: "a=1" } }],
  ["non-string literal", { kind: "json", value: { kind: "literal", value: 7 } }],
  ["malformed reference", { kind: "text", value: { kind: "reference", reference: { producerNodeId: "auth-1" } } }],
  ["unsupported body kind", { kind: "multipart", value: { kind: "literal", value: "x" } }],
  ["body not an object", "x"],
])("answers invalid-body for a structurally wrong body: %s", (_label, body) => {
  expect(prepareEndpointTest(http({ method: "POST", body }), options))
    .toEqual({ ok: false, reason: "invalid-body" });
});

it.each([
  ["xml", "<user><name>{{NAME}}</name><t>{{TOKEN}}</t></user>", "<user><name>ana</name><t>s3cr3t-token</t></user>"],
  ["form", "name={{NAME}}&token={{TOKEN}}", "name=ana&token=s3cr3t-token"],
])("prepares a %s body into the request input without a JSON check", (kind, template, rendered) => {
  const result = prepareEndpointTest(http({
    method: "POST",
    url: { kind: "literal", value: "{{BASE}}/u" },
    body: { kind, value: { kind: "literal", value: template } },
  }), options);
  expect(result).toEqual({
    ok: true,
    input: {
      method: "POST",
      url: "https://api.example.test/u",
      headers: [],
      bodyText: rendered,
      secretValues: ["s3cr3t-token"],
    },
  });
});

it.each(["xml", "form"])("fills a %s body reference from its sample and masks it", kind => {
  const result = prepareEndpointTest(http({
    method: "PUT",
    body: { kind, value: { kind: "reference", reference: { producerNodeId: "auth-1", output: "accessToken" } } },
  }), options);
  expect(result).toEqual({
    ok: true,
    input: {
      method: "PUT",
      url: "https://api.example.test/users/ana",
      headers: [],
      bodyText: "sample-token",
      secretValues: ["sample-token"],
    },
  });
});

it("still refuses a json body that is not valid JSON, and only for json", () => {
  const body = (kind: string) => ({ kind, value: { kind: "literal", value: "<oops {{NAME}}" } });
  expect(prepareEndpointTest(http({ method: "POST", body: body("json") }), options))
    .toEqual({ ok: false, reason: "invalid-json-body" });
  expect(prepareEndpointTest(http({ method: "POST", body: body("xml") }), options))
    .toMatchObject({ ok: true, input: { bodyText: "<oops ana" } });
});

it("tolerates spaces inside the placeholder and reports the same secret once", () => {
  const result = prepareEndpointTest(http({
    url: { kind: "literal", value: "{{ BASE }}/x?t={{TOKEN}}&u={{TOKEN}}" },
  }), options);
  expect(result).toMatchObject({ ok: true, input: { url: "https://api.example.test/x?t=s3cr3t-token&u=s3cr3t-token" } });
  if (!result.ok) return;
  expect(result.input.secretValues).toEqual(["s3cr3t-token"]);
});

it("never mutates the caller's parameters", () => {
  const parameters = http({ body: { kind: "text", value: { kind: "literal", value: "{{NAME}}" } } });
  const before = JSON.stringify(parameters);
  prepareEndpointTest(parameters, options);
  expect(JSON.stringify(parameters)).toBe(before);
});
