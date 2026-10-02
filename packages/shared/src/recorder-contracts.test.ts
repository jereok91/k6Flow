import { describe, expect, it } from "vitest";
import * as shared from "./index";
import {
  recorderStatusSchema, recorderTerminalStatusSchema, recorderCleanupTriggerSchema,
  recorderCaptureEntrySchema, recorderCreateRequestSchema, recorderCreateResponseSchema,
  recorderStateResponseSchema, recorderStopResponseSchema, recorderErrorCodeSchema,
  recorderErrorCatalogSchema, recorderErrorResponseSchema, recorderWsInputFrameSchema,
  RECORDER_WS_TOPIC_PREFIX,
} from "./recorder-contracts";
const { readFileSync } = (await import("node:fs" as string)) as {
  readFileSync(path: string, encoding: "utf8"): string;
};
const openapi = () => readFileSync("docs/api/openapi.yaml", "utf8");
const validEntry: shared.RecorderCaptureEntry = {
  method: "GET", url: "https://api.example.com/users", status: 200,
  headers: [{ name: "Content-Type", value: "application/json" }], redacted: false,
};
const validEntryWithExcerpt: shared.RecorderCaptureEntry = {
  ...validEntry, bodyExcerpt: "{\"id\":1}",
};

describe("recorder lifecycle status declarations", () => {
  it("declares exactly the five closed lifecycle statuses", () => {
    expect(recorderStatusSchema.options).toEqual(["pending", "recording", "stopping", "completed", "failed"]);
    for (const status of recorderStatusSchema.options) {
      expect(recorderStateResponseSchema.parse({ version: 1, recordingId: "rec-1", status }).status).toBe(status);
    }
  });
  it.each(["FINISHED", "cancelled", "active", "idle", "done", ""])(
    "rejects lifecycle status %j outside the closed set", (status) => {
      expect(recorderStatusSchema.safeParse(status).success).toBe(false);
    });
  it("restricts terminal statuses to completed and failed", () => {
    expect(recorderTerminalStatusSchema.options).toEqual(["completed", "failed"]);
    for (const status of ["pending", "recording", "stopping"]) {
      expect(recorderTerminalStatusSchema.safeParse(status).success).toBe(false);
    }
  });
});

describe("recorder cleanup trigger declarations", () => {
  it("declares exactly the five closed cleanup triggers", () => {
    expect(recorderCleanupTriggerSchema.options).toEqual(["run-finished", "closed", "inactivity", "max-duration", "manual"]);
    for (const trigger of recorderCleanupTriggerSchema.options) {
      expect(recorderCleanupTriggerSchema.parse(trigger)).toBe(trigger);
    }
  });
  it.each(["timeout", "expired", "user-stop", "auto", ""])(
    "rejects cleanup trigger %j outside the closed set", (trigger) => {
      expect(recorderCleanupTriggerSchema.safeParse(trigger).success).toBe(false);
    });
});

describe("recorder capture entry — raw HTTP transcript, not graph AST", () => {
  it("accepts a valid raw capture entry with required fields", () => {
    expect(recorderCaptureEntrySchema.parse(validEntry)).toEqual(validEntry);
  });
  it("accepts an optional bodyExcerpt string", () => {
    expect(recorderCaptureEntrySchema.parse(validEntryWithExcerpt).bodyExcerpt).toBe("{\"id\":1}");
  });
  it("accepts redacted true or false", () => {
    expect(recorderCaptureEntrySchema.parse({ ...validEntry, redacted: true }).redacted).toBe(true);
    expect(recorderCaptureEntrySchema.parse({ ...validEntry, redacted: false }).redacted).toBe(false);
  });
  it.each(["method", "url", "status", "headers", "redacted"])(
    "requires capture entry field %s", (field) => {
      const body: Record<string, unknown> = { ...validEntry };
      delete body[field];
      expect(recorderCaptureEntrySchema.safeParse(body).success).toBe(false);
    });
  it("rejects unknown fields on the capture entry", () => {
    expect(recorderCaptureEntrySchema.safeParse({ ...validEntry, nodeId: "graph-1" }).success).toBe(false);
    expect(recorderCaptureEntrySchema.safeParse({ ...validEntry, reference: "out-1" }).success).toBe(false);
    expect(recorderCaptureEntrySchema.safeParse({ ...validEntry, extra: true }).success).toBe(false);
  });
  it.each([undefined, 0, 2, "1"])("requires literal version 1 on capture-related API bodies, got %j", (version) => {
    expect(recorderCreateRequestSchema.safeParse({ version }).success).toBe(false);
    expect(recorderCreateResponseSchema.safeParse({ version, recordingId: "rec-1" }).success).toBe(false);
    expect(recorderStateResponseSchema.safeParse({ version, recordingId: "rec-1", status: "pending" }).success).toBe(false);
    expect(recorderStopResponseSchema.safeParse({ version, recordingId: "rec-1", status: "completed", capture: [] }).success).toBe(false);
    expect(recorderErrorResponseSchema.safeParse({ version, code: "unauthorized", message: "declared" }).success).toBe(false);
  });
  it("rejects non-string or blank method and url", () => {
    for (const bad of ["", "  ", 1, null, undefined]) {
      expect(recorderCaptureEntrySchema.safeParse({ ...validEntry, method: bad }).success).toBe(false);
      expect(recorderCaptureEntrySchema.safeParse({ ...validEntry, url: bad }).success).toBe(false);
    }
  });
  it("rejects noninteger or nonpositive status codes", () => {
    for (const bad of [0, -1, 1.5, "200", null, undefined]) {
      expect(recorderCaptureEntrySchema.safeParse({ ...validEntry, status: bad }).success).toBe(false);
    }
    expect(recorderCaptureEntrySchema.parse({ ...validEntry, status: 999 }).status).toBe(999);
  });
  it("rejects nonboolean redacted values", () => {
    for (const bad of [0, 1, "true", null, undefined]) {
      expect(recorderCaptureEntrySchema.safeParse({ ...validEntry, redacted: bad }).success).toBe(false);
    }
  });
  it("rejects nonstring bodyExcerpt", () => {
    for (const bad of [123, true, null, {}, []]) {
      expect(recorderCaptureEntrySchema.safeParse({ ...validEntry, bodyExcerpt: bad }).success).toBe(false);
    }
  });
  it("accepts an empty headers array but rejects header entries with blank names", () => {
    expect(recorderCaptureEntrySchema.parse({ ...validEntry, headers: [] }).headers).toEqual([]);
    expect(recorderCaptureEntrySchema.safeParse({ ...validEntry, headers: [{ name: "", value: "v" }] }).success).toBe(false);
  });
});

describe("recorder REST response shapes and idempotent stop", () => {
  it("accepts a valid create request and response", () => {
    expect(recorderCreateRequestSchema.parse({ version: 1 })).toEqual({ version: 1 });
    expect(recorderCreateResponseSchema.parse({ version: 1, recordingId: "rec-1" }).recordingId).toBe("rec-1");
  });
  it("rejects extra fields on create request and response", () => {
    expect(recorderCreateRequestSchema.safeParse({ version: 1, extra: true }).success).toBe(false);
    expect(recorderCreateResponseSchema.safeParse({ version: 1, recordingId: "rec-1", extra: true }).success).toBe(false);
  });
  it("accepts stop response in any lifecycle status — schema-level idempotent stop", () => {
    for (const status of recorderStatusSchema.options) {
      const stop = { version: 1, recordingId: "rec-1", status, capture: [validEntry] };
      expect(recorderStopResponseSchema.parse(stop).status).toBe(status);
    }
  });
  it("accepts stop response with empty capture — capture delivered exactly once is a runtime obligation", () => {
    const stop = { version: 1, recordingId: "rec-1", status: "completed", capture: [] };
    expect(recorderStopResponseSchema.parse(stop).capture).toEqual([]);
  });
  it("requires capture array on stop response", () => {
    const body: Record<string, unknown> = { version: 1, recordingId: "rec-1", status: "completed" };
    expect(recorderStopResponseSchema.safeParse(body).success).toBe(false);
  });
});

describe("recorder error catalog", () => {
  it("declares exactly unauthorized and recording-not-found error codes", () => {
    expect(recorderErrorCodeSchema.options).toEqual(["unauthorized", "recording-not-found"]);
  });
  it("maps error codes to declared HTTP status codes", () => {
    expect(recorderErrorCatalogSchema.parse({ unauthorized: 401, "recording-not-found": 404 })).toEqual({
      unauthorized: 401, "recording-not-found": 404,
    });
  });
  it("rejects wrong HTTP status code mappings", () => {
    expect(recorderErrorCatalogSchema.safeParse({ unauthorized: 403, "recording-not-found": 404 }).success).toBe(false);
    expect(recorderErrorCatalogSchema.safeParse({ unauthorized: 401, "recording-not-found": 500 }).success).toBe(false);
  });
  it("accepts a valid error response", () => {
    const err = { version: 1, code: "recording-not-found", message: "unknown recording" };
    expect(recorderErrorResponseSchema.parse(err)).toEqual(err);
  });
});

describe("recorder WebSocket input frame declaration", () => {
  it("declares the init input frame with version literal", () => {
    const frame = { version: 1, type: "init" as const };
    expect(recorderWsInputFrameSchema.parse(frame)).toEqual(frame);
  });
  it.each(["start", "stop", "metrics", "init ", 1])(
    'rejects input frame type %j outside the declared "init"', (type) => {
      expect(recorderWsInputFrameSchema.safeParse({ version: 1, type }).success).toBe(false);
    });
  it("rejects unknown fields on the WS input frame", () => {
    expect(recorderWsInputFrameSchema.safeParse({ version: 1, type: "init", extra: true }).success).toBe(false);
  });
  it("declares the WS topic prefix constant", () => {
    expect(RECORDER_WS_TOPIC_PREFIX).toBe("/ws/recordings/");
  });
});

describe("recorder OpenAPI recorder section", () => {
  it("adds recorder paths without modifying existing runs paths", () => {
    const doc = openapi();
    expect(doc).toContain("/api/recorder/recordings:");
    expect(doc).toContain("/api/recorder/recordings/{recordingId}:");
    expect(doc).toContain("/api/recorder/recordings/{recordingId}/stop:");
    expect(doc).toContain("/ws/recordings/{recordingId}:");
    expect(doc).toContain("/api/runs:");
  });
  it("declares bearer auth on the recorder WS handshake", () => {
    const doc = openapi();
    const wsSection = doc.slice(doc.indexOf("/ws/recordings/"));
    expect(wsSection).toContain("bearer");
  });
  it("declares the RecorderStatus enum with the exact five values", () => {
    const doc = openapi();
    expect(doc).toContain("pending");
    expect(doc).toContain("recording");
    expect(doc).toContain("stopping");
    expect(doc).toContain("completed");
    expect(doc).toContain("failed");
  });
});

describe("recorder shared exports", () => {
  it("re-exports recorder schemas and types from the shared index", () => {
    expect(shared.recorderStatusSchema).toBe(recorderStatusSchema);
    expect(shared.recorderCaptureEntrySchema).toBe(recorderCaptureEntrySchema);
    expect(shared.recorderCreateResponseSchema).toBe(recorderCreateResponseSchema);
    expect(shared.recorderStopResponseSchema).toBe(recorderStopResponseSchema);
    expect(shared.recorderErrorResponseSchema).toBe(recorderErrorResponseSchema);
    expect(shared.RECORDER_WS_TOPIC_PREFIX).toBe(RECORDER_WS_TOPIC_PREFIX);
  });
});
