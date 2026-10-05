import { describe, expect, it } from "vitest";
import * as shared from "./index";
import { csvPoolParametersSchema } from "./csv-pool-parameters";

const parameters = {
  version: 1,
  attachment: { id: "dummy-csv-attachment" },
  allocation: "csv-order-distinct-row-per-vu",
  onInsufficientCapacity: "reject-before-execution",
  outputs: [{ header: "dummy_label", name: "label", expectedType: "string", required: true }],
};

describe("standalone CSV pool declarations", () => {
  it("accepts explicit approved policies and a required string mapping", () => {
    expect(csvPoolParametersSchema.parse(parameters)).toEqual(parameters);
  });

  it("rejects duplicate output identities", () => {
    expect(csvPoolParametersSchema.safeParse({ ...parameters,
      outputs: [parameters.outputs[0], { ...parameters.outputs[0], header: "other" }],
    }).success).toBe(false);
  });

  it("rejects row sharing instead of the approved distinct allocation", () => {
    expect(csvPoolParametersSchema.safeParse({ ...parameters, allocation: "shared-row" })
      .success).toBe(false);
  });

  it("exports inferred declaration and component types through the public entry point", () => {
    const parsed: shared.CsvPoolParameters = shared.csvPoolParametersSchema.parse(parameters);
    const attachment: shared.CsvPoolAttachment | undefined = parsed.attachment;
    const output: shared.CsvPoolOutput = parsed.outputs[0]!;
    const allocation: shared.CsvPoolAllocation = parsed.allocation;
    const capacity: shared.CsvPoolCapacityPolicy = parsed.onInsufficientCapacity;
    expect(attachment).toBeDefined();
    expect(shared.csvPoolAttachmentSchema.parse(attachment)).toEqual(attachment);
    expect(shared.csvPoolOutputSchema.parse(output)).toEqual(output);
    expect(shared.csvPoolAllocationSchema.parse(allocation)).toBe(allocation);
    expect(shared.csvPoolCapacityPolicySchema.parse(capacity)).toBe(capacity);
    expect(shared.csvPoolParametersSchema).toBe(csvPoolParametersSchema);
  });

  it("preserves exact strings and mapping order without mutating frozen input", () => {
    const outputs = Object.freeze([
      Object.freeze({ ...parameters.outputs[0], header: "  Label ${x}  ", name: " label " }),
      Object.freeze({ ...parameters.outputs[0], header: "__proto__", name: "second" }),
    ]);
    const input = Object.freeze({ ...parameters,
      attachment: Object.freeze({ id: " dummy identity " }), outputs });
    const parsed = csvPoolParametersSchema.parse(input);
    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
    expect(parsed.outputs).not.toBe(outputs);
    expect(parsed.outputs[0]!.header).toBe("  Label ${x}  ");
  });

  it("allows repeated source-header mappings to distinct exact output names", () => {
    const outputs = [parameters.outputs[0], { ...parameters.outputs[0], name: "label " }];
    expect(csvPoolParametersSchema.parse({ ...parameters, outputs }).outputs).toEqual(outputs);
  });

  it("reports a duplicate identity at the later output's name", () => {
    const result = csvPoolParametersSchema.safeParse({ ...parameters,
      outputs: [parameters.outputs[0], parameters.outputs[0]] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path)).toEqual([["outputs", 1, "name"]]);
    }
  });

  it.each([
    { version: 0 }, { version: 2 }, { version: "1" }, { version: undefined },
    { attachment: "dummy-csv-attachment" },
    { allocation: undefined }, { allocation: "random" }, { allocation: "per-iteration" },
    { onInsufficientCapacity: undefined }, { onInsufficientCapacity: "wrap" },
    { onInsufficientCapacity: "share" }, { onInsufficientCapacity: "stop-current-vu-iteration" },
    { outputs: undefined }, { outputs: {} }, { outputs: [null] },
    { inlineCsv: "dummy_label\ndummy" }, { url: "https://example.test/dummy.csv" },
    { path: "/dummy/pool.csv" }, { secret: "dummy-binding" }, { extra: true },
  ])("rejects invalid or alternative envelope fields %j", (patch) => {
    expect(csvPoolParametersSchema.safeParse({ ...parameters, ...patch }).success).toBe(false);
  });

  it.each([
    { id: undefined }, { id: "" }, { id: " \t\n" }, { id: 1 },
    { id: "dummy", content: "dummy_label\ndummy" },
    { id: "dummy", url: "https://example.test/dummy.csv" },
    { id: "dummy", path: "/dummy/pool.csv" }, { id: "dummy", secret: "dummy-binding" },
    { id: "dummy", extra: true },
  ])("rejects malformed identities and attachment alternatives %j", (attachment) => {
    expect(csvPoolParametersSchema.safeParse({ ...parameters, attachment }).success).toBe(false);
  });

  it("treats identity syntax as opaque, not as a resolver or URL/path security check", () => {
    for (const id of ["https://example.test/opaque-id", "/dummy/opaque-id"]) {
      expect(shared.csvPoolAttachmentSchema.parse({ id })).toEqual({ id });
    }
  });

  it.each([
    { header: undefined }, { header: "" }, { header: " \t\n" }, { header: 1 },
    { name: undefined }, { name: "" }, { name: " \t" }, { name: 1 },
    { expectedType: undefined }, { expectedType: "json" }, { expectedType: "number" },
    { expectedType: String }, { required: undefined }, { required: false },
    { required: "true" }, { default: "dummy" }, { trim: true }, { convert: "number" },
    { selector: { index: 0 } }, { value: "dummy" }, { extra: true },
  ])("rejects invalid, optional or transforming output mappings %j", (patch) => {
    expect(csvPoolParametersSchema.safeParse({ ...parameters,
      outputs: [{ ...parameters.outputs[0], ...patch }] }).success).toBe(false);
  });

  it.each([null, undefined, [], "csv", 1])("rejects non-object declarations %j", (input) => {
    expect(csvPoolParametersSchema.safeParse(input).success).toBe(false);
  });
});
