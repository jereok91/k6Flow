import { z } from "zod";
import { authJsonPathSegmentSchema } from "./auth-parameters";
import { httpMethodSchema } from "./http-parameters";
import { jsonValueSchema, producerOutputReferenceSchema } from "./parameter-values";
import { versionEnvelopeSchema } from "./version";

export const checkJsonPathSegmentSchema = authJsonPathSegmentSchema;
export const checkNumericOperatorSchema = z.enum(["eq", "ne", "lt", "lte", "gt", "gte"]);
const name = producerOutputReferenceSchema.shape.output;
const numeric = { name, operator: checkNumericOperatorSchema, expected: z.number() };
const textPredicateSchema = z.discriminatedUnion("operator", [
  z.strictObject({ operator: z.literal("exists") }),
  z.strictObject({ operator: z.literal("eq"), expected: z.string() }),
  z.strictObject({ operator: z.literal("ne"), expected: z.string() }),
  z.strictObject({ operator: z.literal("contains-literal"), expected: z.string() }),
]);
const jsonPredicateSchema = z.discriminatedUnion("operator", [
  z.strictObject({ operator: z.literal("exists") }),
  z.strictObject({ operator: z.literal("deep-eq"), expected: jsonValueSchema }),
]);

export const responseCheckSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("status"), ...numeric }),
  z.strictObject({ kind: z.literal("duration-ms"), ...numeric }),
  z.strictObject({ kind: z.literal("body-text"), name, predicate: textPredicateSchema }),
  z.strictObject({ kind: z.literal("header"), name,
    header: httpMethodSchema, predicate: textPredicateSchema }),
  z.strictObject({ kind: z.literal("json-path"), name,
    path: z.array(checkJsonPathSegmentSchema), predicate: jsonPredicateSchema }),
]);

// Declaration only: no response resolution, check() or iteration control flow.
export const checkFailurePolicySchema = z.literal("record-failure-and-continue");
export const checkParametersSchema = z.strictObject({
  version: versionEnvelopeSchema.shape.version,
  response: producerOutputReferenceSchema,
  checks: z.array(responseCheckSchema).min(1),
  onCheckFailure: checkFailurePolicySchema,
}).superRefine((parameters, ctx) => {
  const names = new Set<string>();
  parameters.checks.forEach((check, index) => {
    if (names.has(check.name)) {
      ctx.addIssue({ code: "custom", path: ["checks", index, "name"],
        message: "Duplicate response check identity" });
    }
    names.add(check.name);
  });
});

export type CheckJsonPathSegment = z.infer<typeof checkJsonPathSegmentSchema>;
export type CheckNumericOperator = z.infer<typeof checkNumericOperatorSchema>;
export type ResponseCheck = z.infer<typeof responseCheckSchema>;
export type CheckFailurePolicy = z.infer<typeof checkFailurePolicySchema>;
export type CheckParameters = z.infer<typeof checkParametersSchema>;
