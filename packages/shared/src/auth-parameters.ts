import { z } from "zod";
import { httpMethodSchema, httpParametersSchema } from "./http-parameters";
import { producerOutputReferenceSchema } from "./parameter-values";

// Segments are data: strings are exact object keys, numbers are array indices.
export const authJsonPathSegmentSchema = z.union([
  z.string(), z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
]);
export const authOutputSelectorSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("json-path"), path: z.array(authJsonPathSegmentSchema) }),
  z.strictObject({ kind: z.literal("header"), name: httpMethodSchema }),
  z.strictObject({ kind: z.literal("cookie"), name: httpMethodSchema }),
]);

// JSON includes strings; this is a consumer category, not primitive inference.
export const authOutputTypeSchema = z.enum(["string", "json"]);
export const authOutputSchema = z.strictObject({
  name: producerOutputReferenceSchema.shape.output,
  selector: authOutputSelectorSchema,
  expectedType: authOutputTypeSchema,
  required: z.literal(true),
}).superRefine((output, ctx) => {
  if (output.selector.kind !== "json-path" && output.expectedType !== "string") {
    ctx.addIssue({ code: "custom", path: ["expectedType"],
      message: "Header and cookie outputs must expect a string" });
  }
});

// Tagged method boundary is extensible; no Basic Auth or OAuth2 variant exists.
export const authMethodSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("http"), request: httpParametersSchema }),
]);
export const authOutputFailurePolicySchema = z.literal("stop-current-vu-iteration");
export const authParametersSchema = z.strictObject({
  method: authMethodSchema,
  outputs: z.array(authOutputSchema).min(1),
  onOutputFailure: authOutputFailurePolicySchema,
}).superRefine((parameters, ctx) => {
  const names = new Set<string>();
  parameters.outputs.forEach((output, index) => {
    if (names.has(output.name)) {
      ctx.addIssue({ code: "custom", path: ["outputs", index, "name"],
        message: "Duplicate authentication output identity" });
    }
    names.add(output.name);
  });
});

export type AuthJsonPathSegment = z.infer<typeof authJsonPathSegmentSchema>;
export type AuthOutputSelector = z.infer<typeof authOutputSelectorSchema>;
export type AuthOutputType = z.infer<typeof authOutputTypeSchema>;
export type AuthOutput = z.infer<typeof authOutputSchema>;
export type AuthMethod = z.infer<typeof authMethodSchema>;
export type AuthOutputFailurePolicy = z.infer<typeof authOutputFailurePolicySchema>;
export type AuthParameters = z.infer<typeof authParametersSchema>;
