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
    method: "POST", body: { kind: "json", value: '{"name":"{{NAME}}"}' },
  }), options);
  expect(good).toMatchObject({ ok: true, input: { bodyText: '{"name":"ana"}', method: "POST" } });
  expect(prepareEndpointTest(http({ method: "POST", body: { kind: "json", value: "{oops" } }), options))
    .toEqual({ ok: false, reason: "invalid-json-body" });
});

it("renders a text body and drops an empty one", () => {
  expect(prepareEndpointTest(http({ method: "POST", body: { kind: "text", value: "hi {{NAME}}" } }), options))
    .toMatchObject({ ok: true, input: { bodyText: "hi ana" } });
  expect(prepareEndpointTest(http({ method: "POST", body: { kind: "text", value: "" } }), options))
    .toMatchObject({ ok: true, input: { bodyText: undefined } });
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
  const parameters = http({ body: { kind: "text", value: "{{NAME}}" } });
  const before = JSON.stringify(parameters);
  prepareEndpointTest(parameters, options);
  expect(JSON.stringify(parameters)).toBe(before);
});
