import { z } from "zod";

// =============================================================================
// Binary Frame Protocol (server → client)
// =============================================================================
// offset  size   field
// 0       1      type = 0x01 (FRAME)
// 1       4      seq (uint32, big endian)
// 5       2      width (uint16)
// 7       2      height (uint16)
// 9       8      timestamp in ms (uint64)
// 17      N      JPEG payload

export const FRAME_TYPE = 0x01;
export const FRAME_HEADER_SIZE = 17;

export interface FrameHeader {
  type: typeof FRAME_TYPE;
  seq: number;
  width: number;
  height: number;
  timestamp: bigint;
}

/**
 * Encode frame header (Node.js only - uses Buffer).
 * For browser use, construct the Uint8Array directly.
 */
export function encodeFrameHeader(header: FrameHeader): Uint8Array {
  const buf = new Uint8Array(FRAME_HEADER_SIZE);
  const view = new DataView(buf.buffer);
  view.setUint8(0, header.type);
  view.setUint32(1, header.seq, false); // big endian
  view.setUint16(5, header.width, false);
  view.setUint16(7, header.height, false);
  view.setBigUint64(9, header.timestamp, false);
  return buf;
}

/**
 * Decode frame header from binary data (works in both Node.js and browser).
 */
export function decodeFrameHeader(buf: ArrayBuffer): FrameHeader | null {
  if (buf.byteLength < FRAME_HEADER_SIZE) return null;
  const view = new DataView(buf);
  const type = view.getUint8(0);
  if (type !== FRAME_TYPE) return null;
  return {
    type: FRAME_TYPE,
    seq: view.getUint32(1, false),
    width: view.getUint16(5, false),
    height: view.getUint16(7, false),
    timestamp: view.getBigUint64(9, false),
  };
}

// =============================================================================
// JSON Control Messages (bidirectional)
// =============================================================================

// Server → Client messages
export const streamingStateMessageSchema = z.object({
  t: z.literal("state"),
  state: z.enum(["CREATED", "PROVISIONING", "READY", "RECORDING", "PAUSED", "STOPPING", "PROCESSING", "REVIEW", "SAVED", "EXPIRED", "FAILED", "DISCARDED"]),
  recordingId: z.string(),
});

export const streamingNavMessageSchema = z.object({
  t: z.literal("nav"),
  url: z.string(),
  title: z.string(),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
  loading: z.boolean(),
});

export const streamingTabSchema = z.object({
  id: z.string(),
  url: z.string(),
  title: z.string(),
  active: z.boolean(),
});

export const streamingTabsMessageSchema = z.object({
  t: z.literal("tabs"),
  tabs: z.array(streamingTabSchema),
});

export const streamingCursorMessageSchema = z.object({
  t: z.literal("cursor"),
  style: z.string(),
});

export const streamingDialogMessageSchema = z.object({
  t: z.literal("dialog"),
  kind: z.enum(["confirm", "alert", "prompt", "beforeunload"]),
  message: z.string(),
  id: z.string(),
});

export const streamingFileChooserMessageSchema = z.object({
  t: z.literal("filechooser"),
  id: z.string(),
  multiple: z.boolean(),
});

export const streamingStatsMessageSchema = z.object({
  t: z.literal("stats"),
  fps: z.number(),
  quality: z.number(),
  rttMs: z.number(),
  droppedFrames: z.number(),
  recordedRequests: z.number(),
});

export const streamingStepMessageSchema = z.object({
  t: z.literal("step"),
  stepId: z.string(),
  name: z.string(),
  startedAt: z.number(),
});

export const streamingErrorMessageSchema = z.object({
  t: z.literal("error"),
  code: z.string(),
  message: z.string(),
});

export const streamingPongMessageSchema = z.object({
  t: z.literal("pong"),
  ts: z.number(),
});

export const streamingServerMessageSchema = z.discriminatedUnion("t", [
  streamingStateMessageSchema,
  streamingNavMessageSchema,
  streamingTabsMessageSchema,
  streamingCursorMessageSchema,
  streamingDialogMessageSchema,
  streamingFileChooserMessageSchema,
  streamingStatsMessageSchema,
  streamingStepMessageSchema,
  streamingErrorMessageSchema,
  streamingPongMessageSchema,
]);

// Client → Server messages
export const streamingMouseMessageSchema = z.object({
  t: z.literal("mouse"),
  type: z.enum(["move", "down", "up", "wheel"]),
  x: z.number(),
  y: z.number(),
  button: z.enum(["left", "middle", "right"]).optional(),
  clickCount: z.number().optional(),
  deltaX: z.number().optional(),
  deltaY: z.number().optional(),
  mods: z.number().optional(), // bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8
});

export const streamingKeyMessageSchema = z.object({
  t: z.literal("key"),
  type: z.enum(["down", "up"]),
  key: z.string(),
  code: z.string(),
  text: z.string().optional(),
  vk: z.number().optional(),
  mods: z.number().optional(),
});

export const streamingTextMessageSchema = z.object({
  t: z.literal("text"),
  text: z.string(),
});

export const streamingNavActionMessageSchema = z.object({
  t: z.literal("nav"),
  action: z.enum(["goto", "back", "forward", "reload", "stop"]),
  url: z.string().optional(),
});

export const streamingTabActionMessageSchema = z.object({
  t: z.literal("tab"),
  action: z.enum(["new", "switch", "close"]),
  id: z.string().optional(),
});

export const streamingDialogReplyMessageSchema = z.object({
  t: z.literal("dialog_reply"),
  id: z.string(),
  accept: z.boolean(),
  promptText: z.string().optional(),
});

export const streamingFileUploadMessageSchema = z.object({
  t: z.literal("file_upload"),
  id: z.string(),
  files: z.array(z.object({
    name: z.string(),
    assetId: z.string(),
  })),
});

export const streamingResizeMessageSchema = z.object({
  t: z.literal("resize"),
  width: z.number(),
  height: z.number(),
});

export const streamingMarkMessageSchema = z.object({
  t: z.literal("mark"),
  name: z.string(),
  kind: z.enum(["step", "assert", "note"]),
  note: z.string().optional(),
});

export const streamingPauseMessageSchema = z.object({ t: z.literal("pause") });
export const streamingResumeMessageSchema = z.object({ t: z.literal("resume") });
export const streamingStopMessageSchema = z.object({ t: z.literal("stop") });

export const streamingPingMessageSchema = z.object({
  t: z.literal("ping"),
  ts: z.number(),
});

export const streamingClientMessageSchema = z.discriminatedUnion("t", [
  streamingMouseMessageSchema,
  streamingKeyMessageSchema,
  streamingTextMessageSchema,
  streamingNavActionMessageSchema,
  streamingTabActionMessageSchema,
  streamingDialogReplyMessageSchema,
  streamingFileUploadMessageSchema,
  streamingResizeMessageSchema,
  streamingMarkMessageSchema,
  streamingPauseMessageSchema,
  streamingResumeMessageSchema,
  streamingStopMessageSchema,
  streamingPingMessageSchema,
]);

// Type exports
export type StreamingState = z.infer<typeof streamingStateMessageSchema>["state"];
export type StreamingServerMessage = z.infer<typeof streamingServerMessageSchema>;
export type StreamingClientMessage = z.infer<typeof streamingClientMessageSchema>;
export type StreamingMouseMessage = z.infer<typeof streamingMouseMessageSchema>;
export type StreamingKeyMessage = z.infer<typeof streamingKeyMessageSchema>;
