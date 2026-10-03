import { describe, it, expect } from "vitest";
import {
  FRAME_TYPE,
  FRAME_HEADER_SIZE,
  encodeFrameHeader,
  decodeFrameHeader,
  streamingClientMessageSchema,
  streamingServerMessageSchema,
  type FrameHeader,
} from "./recorder-streaming";

describe("recorder-streaming binary protocol", () => {
  it("encodes and decodes frame header correctly", () => {
    const header: FrameHeader = {
      type: FRAME_TYPE,
      seq: 12345,
      width: 1280,
      height: 720,
      timestamp: BigInt(1699999999999),
    };

    const encoded = encodeFrameHeader(header);
    expect(encoded.byteLength).toBe(FRAME_HEADER_SIZE);

    const decoded = decodeFrameHeader(encoded.buffer as ArrayBuffer);
    expect(decoded).not.toBeNull();
    expect(decoded!.type).toBe(FRAME_TYPE);
    expect(decoded!.seq).toBe(12345);
    expect(decoded!.width).toBe(1280);
    expect(decoded!.height).toBe(720);
    expect(decoded!.timestamp).toBe(BigInt(1699999999999));
  });

  it("returns null for invalid frame type", () => {
    const buf = new ArrayBuffer(FRAME_HEADER_SIZE);
    const view = new DataView(buf);
    view.setUint8(0, 0x99); // Invalid type

    const decoded = decodeFrameHeader(buf);
    expect(decoded).toBeNull();
  });

  it("returns null for buffer too small", () => {
    const buf = new ArrayBuffer(10);
    const decoded = decodeFrameHeader(buf);
    expect(decoded).toBeNull();
  });

  it("handles maximum seq number", () => {
    const header: FrameHeader = {
      type: FRAME_TYPE,
      seq: 0xFFFFFFFF, // max uint32
      width: 1920,
      height: 1080,
      timestamp: BigInt("9007199254740991"), // max safe integer as bigint
    };

    const encoded = encodeFrameHeader(header);
    const decoded = decodeFrameHeader(encoded.buffer as ArrayBuffer);
    expect(decoded!.seq).toBe(0xFFFFFFFF);
  });
});

describe("recorder-streaming JSON messages", () => {
  describe("server messages", () => {
    it("validates state message", () => {
      const msg = { t: "state", state: "RECORDING", recordingId: "rec-123" };
      const result = streamingServerMessageSchema.safeParse(msg);
      expect(result.success).toBe(true);
    });

    it("validates nav message", () => {
      const msg = {
        t: "nav",
        url: "https://example.com",
        title: "Example",
        canGoBack: true,
        canGoForward: false,
        loading: false,
      };
      const result = streamingServerMessageSchema.safeParse(msg);
      expect(result.success).toBe(true);
    });

    it("validates stats message", () => {
      const msg = {
        t: "stats",
        fps: 10,
        quality: 60,
        rttMs: 50,
        droppedFrames: 2,
        recordedRequests: 42,
      };
      const result = streamingServerMessageSchema.safeParse(msg);
      expect(result.success).toBe(true);
    });

    it("rejects invalid state", () => {
      const msg = { t: "state", state: "INVALID_STATE", recordingId: "rec-123" };
      const result = streamingServerMessageSchema.safeParse(msg);
      expect(result.success).toBe(false);
    });
  });

  describe("client messages", () => {
    it("validates mouse move message", () => {
      const msg = { t: "mouse", type: "move", x: 100, y: 200 };
      const result = streamingClientMessageSchema.safeParse(msg);
      expect(result.success).toBe(true);
    });

    it("validates mouse click message", () => {
      const msg = {
        t: "mouse",
        type: "down",
        x: 100,
        y: 200,
        button: "left",
        clickCount: 1,
        mods: 0,
      };
      const result = streamingClientMessageSchema.safeParse(msg);
      expect(result.success).toBe(true);
    });

    it("validates key message", () => {
      const msg = {
        t: "key",
        type: "down",
        key: "a",
        code: "KeyA",
        text: "a",
        vk: 65,
        mods: 0,
      };
      const result = streamingClientMessageSchema.safeParse(msg);
      expect(result.success).toBe(true);
    });

    it("validates text message", () => {
      const msg = { t: "text", text: "Hello, World!" };
      const result = streamingClientMessageSchema.safeParse(msg);
      expect(result.success).toBe(true);
    });

    it("validates nav action message", () => {
      const msg = { t: "nav", action: "goto", url: "https://example.com" };
      const result = streamingClientMessageSchema.safeParse(msg);
      expect(result.success).toBe(true);
    });

    it("validates mark message", () => {
      const msg = { t: "mark", name: "Login", kind: "step" };
      const result = streamingClientMessageSchema.safeParse(msg);
      expect(result.success).toBe(true);
    });

    it("validates pause/resume/stop messages", () => {
      expect(streamingClientMessageSchema.safeParse({ t: "pause" }).success).toBe(true);
      expect(streamingClientMessageSchema.safeParse({ t: "resume" }).success).toBe(true);
      expect(streamingClientMessageSchema.safeParse({ t: "stop" }).success).toBe(true);
    });

    it("validates ping message", () => {
      const msg = { t: "ping", ts: Date.now() };
      const result = streamingClientMessageSchema.safeParse(msg);
      expect(result.success).toBe(true);
    });

    it("rejects invalid message type", () => {
      const msg = { t: "invalid", data: "test" };
      const result = streamingClientMessageSchema.safeParse(msg);
      expect(result.success).toBe(false);
    });
  });
});
