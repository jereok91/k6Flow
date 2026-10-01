import { z } from "zod";
import { checkNumericOperatorSchema } from "./check-parameters";
import { versionEnvelopeSchema } from "./version";

const positiveInteger = z.number().int().positive();
const nonnegativeInteger = z.number().int().nonnegative();

export const loadStageSchema = z.strictObject({
  durationMs: positiveInteger,
  targetVus: nonnegativeInteger,
});
export const loadProfileSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("constant-vus"),
    vus: positiveInteger, durationMs: positiveInteger }),
  z.strictObject({ kind: z.literal("staged-vus"),
    startVus: nonnegativeInteger, stages: z.array(loadStageSchema).min(1) }),
]).refine((profile) => profile.kind === "constant-vus" || profile.startVus > 0 ||
  profile.stages.some((stage) => stage.targetVus > 0), {
  message: "Expected at least one positive global load value",
});

export const loadThresholdSchema = z.discriminatedUnion("metric", [
  z.strictObject({
    metric: z.literal("http_req_duration"),
    aggregator: z.enum(["avg", "p90", "p95", "p99"]),
    unit: z.literal("ms"),
    operator: checkNumericOperatorSchema,
    expected: z.number().nonnegative(),
  }),
  z.strictObject({
    metric: z.literal("http_req_failed"),
    aggregator: z.literal("rate"),
    unit: z.literal("fraction"),
    operator: checkNumericOperatorSchema,
    expected: z.number().min(0).max(1),
  }),
]);
export const loadThresholdPolicySchema = z.literal("final-pass-fail");

// Declaration only: no aggregation, threshold evaluation or k6 execution.
export const loadParametersSchema = z.strictObject({
  version: versionEnvelopeSchema.shape.version,
  profile: loadProfileSchema,
  thresholds: z.array(loadThresholdSchema),
  thresholdPolicy: loadThresholdPolicySchema,
});

export type LoadStage = z.infer<typeof loadStageSchema>;
export type LoadProfile = z.infer<typeof loadProfileSchema>;
export type LoadThreshold = z.infer<typeof loadThresholdSchema>;
export type LoadThresholdPolicy = z.infer<typeof loadThresholdPolicySchema>;
export type LoadParameters = z.infer<typeof loadParametersSchema>;
