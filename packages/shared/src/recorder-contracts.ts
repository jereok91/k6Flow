import { z } from "zod";
import { versionEnvelopeSchema } from "./version";

// Identifier convention reused from the runs REST contract and declared here independently.
const nonblankString = z.string().refine((value) => value.trim().length > 0, {
  message: "Expected a nonblank string",
});
const positiveSafeInteger = z.number().int().positive();
const recorderEnvelope = versionEnvelopeSchema.shape.version;

// Declaration only: explicit closed lifecycle set; no state machine implementation.
export const recorderStatusSchema = z.enum(["pending", "recording", "stopping", "completed", "failed"]);
export const recorderTerminalStatusSchema = z.enum(["completed", "failed"]);
// Declaration only: explicit closed cleanup-trigger set; no expiration runtime.
export const recorderCleanupTriggerSchema = z.enum(["run-finished", "closed", "inactivity", "max-duration", "manual"]);
// Raw HTTP transcript entry — explicitly NOT the graph HTTP-node literal/reference AST.
// Import→graph mapping is deferred; bodyExcerpt is an optional string, redacted is a boolean.
export const recorderHeaderEntrySchema = z.strictObject({
  name: nonblankString, value: z.string(),
});
export const recorderCaptureEntrySchema = z.strictObject({
  method: nonblankString,
  url: nonblankString,
  status: positiveSafeInteger,
  headers: z.array(recorderHeaderEntrySchema),
  bodyExcerpt: z.string().optional(),
  redacted: z.boolean(),
});
// REST request/response shapes — version 1 literal on every declared API body.
export const recorderCreateRequestSchema = z.strictObject({ version: recorderEnvelope });
export const recorderCreateResponseSchema = z.strictObject({
  version: recorderEnvelope, recordingId: nonblankString,
});
export const recorderStateResponseSchema = z.strictObject({
  version: recorderEnvelope, recordingId: nonblankString, status: recorderStatusSchema,
});
// Schema-level idempotent stop: the response shape is valid in any lifecycle status;
// repeated stop yields the same terminal state with no extra effect — a runtime obligation.
export const recorderStopResponseSchema = z.strictObject({
  version: recorderEnvelope, recordingId: nonblankString,
  status: recorderStatusSchema, capture: z.array(recorderCaptureEntrySchema),
});
// Exact error/status catalog: structured bodies are version, code and message only.
export const recorderErrorCodeSchema = z.enum(["unauthorized", "recording-not-found"]);
export const recorderErrorCatalogSchema = z.strictObject({
  unauthorized: z.literal(401),
  "recording-not-found": z.literal(404),
});
export const recorderErrorResponseSchema = z.strictObject({
  version: recorderEnvelope, code: recorderErrorCodeSchema, message: nonblankString,
});
// WS topic declaration: bidirectional input frames (init) declared but not implemented.
export const RECORDER_WS_TOPIC_PREFIX = "/ws/recordings/";
export const recorderWsInputFrameSchema = z.strictObject({
  version: recorderEnvelope, type: z.literal("init"),
});

export type RecorderStatus = z.infer<typeof recorderStatusSchema>;
export type RecorderTerminalStatus = z.infer<typeof recorderTerminalStatusSchema>;
export type RecorderCleanupTrigger = z.infer<typeof recorderCleanupTriggerSchema>;
export type RecorderHeaderEntry = z.infer<typeof recorderHeaderEntrySchema>;
export type RecorderCaptureEntry = z.infer<typeof recorderCaptureEntrySchema>;
export type RecorderCreateRequest = z.infer<typeof recorderCreateRequestSchema>;
export type RecorderCreateResponse = z.infer<typeof recorderCreateResponseSchema>;
export type RecorderStateResponse = z.infer<typeof recorderStateResponseSchema>;
export type RecorderStopResponse = z.infer<typeof recorderStopResponseSchema>;
export type RecorderErrorCode = z.infer<typeof recorderErrorCodeSchema>;
export type RecorderErrorCatalog = z.infer<typeof recorderErrorCatalogSchema>;
export type RecorderErrorResponse = z.infer<typeof recorderErrorResponseSchema>;
export type RecorderWsInputFrame = z.infer<typeof recorderWsInputFrameSchema>;
