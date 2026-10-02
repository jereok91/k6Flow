import { z } from "zod";
import { versionEnvelopeSchema } from "./version";

// Identifier convention reused from the runs REST contract and declared here independently.
const nonblankString = z.string().refine((value) => value.trim().length > 0, {
  message: "Expected a nonblank string",
});
// Zod 4 `.int()` enforces `Number.isSafeInteger`, so values outside [0, 2^53−1] are rejected.
const nonnegativeSafeInteger = z.number().int().nonnegative();
// Sample-derived values: explicit null marks a no-request window, never a silent 0.
const sampleValue = z.number().finite().nonnegative().nullable();
const failureFraction = z.number().finite().min(0).max(1).nullable();

// Declaration only: fixed 1000 ms window; startMs is run-relative ms from run start.
export const metricsWindowSchema = z.strictObject({
  startMs: nonnegativeSafeInteger,
  durationMs: z.literal(1000),
});
export const metricsLatencySchema = z.strictObject({
  avg: sampleValue, p90: sampleValue, p95: sampleValue, p99: sampleValue,
});
// Declaration only: no handlers, sockets, aggregation, broadcast or replay; the closed
// union admits exactly one variant, so terminal/error frames are a deferred capability.
export const metricsFrameSchema = z.discriminatedUnion("type", [
  z.strictObject({
    version: versionEnvelopeSchema.shape.version,
    type: z.literal("metrics"),
    runId: nonblankString,
    seq: nonnegativeSafeInteger,
    window: metricsWindowSchema,
    reqPerSec: sampleValue,
    latencyMs: metricsLatencySchema,
    httpFailureFraction: failureFraction,
    activeVUs: nonnegativeSafeInteger,
    failedChecks: nonnegativeSafeInteger,
  }),
]).refine((frame) => [frame.latencyMs.avg, frame.latencyMs.p90, frame.latencyMs.p95,
  frame.latencyMs.p99, frame.httpFailureFraction]
  .every((value) => (value === null) === (frame.reqPerSec === null)), {
  message: "Expected sample-derived metrics to be null exactly together",
});

export type MetricsWindow = z.infer<typeof metricsWindowSchema>;
export type MetricsLatency = z.infer<typeof metricsLatencySchema>;
export type MetricsFrame = z.infer<typeof metricsFrameSchema>;
