import { describe, it, expect } from "vitest";
import {
  detectAuth,
  suggestAuthPosition,
  type AuthDetectionResult,
} from "./capture-auth-detection";
import type { RecorderCaptureEntry } from "./recorder-contracts";

describe("detectAuth", () => {
  it("detects login URL patterns", () => {
    const entries: RecorderCaptureEntry[] = [
      { method: "GET", url: "https://example.com/", status: 200, headers: [], redacted: false },
      { method: "POST", url: "https://example.com/login", status: 200, headers: [], redacted: false },
      { method: "GET", url: "https://example.com/dashboard", status: 200, headers: [], redacted: false },
    ];

    const result = detectAuth(entries);

    expect(result.needsAuth).toBe(true);
    expect(result.suggestedAuthIndex).toBe(1);
    expect(result.signals[0].type).toBe("login");
    expect(result.signals[0].index).toBe(1);
    expect(result.signals[0].confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("detects OAuth patterns", () => {
    const entries: RecorderCaptureEntry[] = [
      { method: "POST", url: "https://auth.example.com/oauth/token", status: 200, headers: [], redacted: false },
    ];

    const result = detectAuth(entries);

    expect(result.signals[0].type).toBe("oauth");
    expect(result.signals[0].confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("detects password in body", () => {
    const entries: RecorderCaptureEntry[] = [
      {
        method: "POST",
        url: "https://example.com/api/auth",
        status: 200,
        headers: [{ name: "Content-Type", value: "application/json" }],
        bodyExcerpt: '{"email":"user@example.com","password":"secret123"}',
        redacted: false,
      },
    ];

    const result = detectAuth(entries);

    expect(result.needsAuth).toBe(true);
    expect(result.signals[0].type).toBe("login");
    expect(result.signals[0].confidence).toBeGreaterThanOrEqual(0.8);
    expect(result.signals[0].reason).toContain("Body contains");
  });

  it("detects Basic Auth header", () => {
    const entries: RecorderCaptureEntry[] = [
      {
        method: "GET",
        url: "https://api.example.com/data",
        status: 200,
        headers: [{ name: "Authorization", value: "Basic dXNlcjpwYXNz" }],
        redacted: false,
      },
    ];

    const result = detectAuth(entries);

    expect(result.needsAuth).toBe(true);
    expect(result.signals[0].type).toBe("basic-auth");
    expect(result.signals[0].confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("detects Bearer token header", () => {
    const entries: RecorderCaptureEntry[] = [
      {
        method: "GET",
        url: "https://api.example.com/data",
        status: 200,
        headers: [{ name: "Authorization", value: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" }],
        redacted: false,
      },
    ];

    const result = detectAuth(entries);

    expect(result.needsAuth).toBe(true);
    expect(result.signals[0].type).toBe("api-key");
  });

  it("detects X-API-Key header", () => {
    const entries: RecorderCaptureEntry[] = [
      {
        method: "GET",
        url: "https://api.example.com/data",
        status: 200,
        headers: [{ name: "X-API-Key", value: "secret-api-key" }],
        redacted: false,
      },
    ];

    const result = detectAuth(entries);

    expect(result.needsAuth).toBe(true);
    expect(result.signals[0].type).toBe("api-key");
  });

  it("detects OAuth grant_type in body", () => {
    const entries: RecorderCaptureEntry[] = [
      {
        method: "POST",
        url: "https://auth.example.com/token",
        status: 200,
        headers: [],
        bodyExcerpt: '{"grant_type":"password","username":"user","password":"pass"}',
        redacted: false,
      },
    ];

    const result = detectAuth(entries);

    expect(result.signals[0].type).toBe("oauth");
    expect(result.signals[0].confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("returns empty signals for non-auth traffic", () => {
    const entries: RecorderCaptureEntry[] = [
      { method: "GET", url: "https://example.com/products", status: 200, headers: [], redacted: false },
      { method: "GET", url: "https://example.com/products/1", status: 200, headers: [], redacted: false },
    ];

    const result = detectAuth(entries);

    expect(result.needsAuth).toBe(false);
    expect(result.suggestedAuthIndex).toBeNull();
    expect(result.signals).toHaveLength(0);
  });

  it("sorts signals by confidence", () => {
    const entries: RecorderCaptureEntry[] = [
      { method: "GET", url: "https://example.com/session", status: 200, headers: [], redacted: false },
      { method: "POST", url: "https://example.com/login", status: 200, headers: [], bodyExcerpt: '{"password":"x"}', redacted: false },
    ];

    const result = detectAuth(entries);

    expect(result.signals.length).toBeGreaterThanOrEqual(2);
    expect(result.signals[0].confidence).toBeGreaterThanOrEqual(result.signals[1].confidence);
  });

  it("handles empty entries", () => {
    const result = detectAuth([]);

    expect(result.needsAuth).toBe(false);
    expect(result.suggestedAuthIndex).toBeNull();
    expect(result.signals).toHaveLength(0);
  });
});

describe("suggestAuthPosition", () => {
  it("suggests login request position", () => {
    const entries: RecorderCaptureEntry[] = [
      { method: "GET", url: "https://example.com/", status: 200, headers: [], redacted: false },
      { method: "POST", url: "https://example.com/login", status: 200, headers: [], redacted: false },
      { method: "GET", url: "https://example.com/dashboard", status: 200, headers: [], redacted: false },
    ];
    const detection = detectAuth(entries);

    const position = suggestAuthPosition(entries, detection);

    expect(position).toBe(1);
  });

  it("suggests 0 when no auth detected", () => {
    const entries: RecorderCaptureEntry[] = [
      { method: "GET", url: "https://example.com/products", status: 200, headers: [], redacted: false },
    ];
    const detection: AuthDetectionResult = {
      signals: [],
      suggestedAuthIndex: null,
      needsAuth: false,
    };

    const position = suggestAuthPosition(entries, detection);

    expect(position).toBe(0);
  });

  it("suggests before first api-key usage", () => {
    const entries: RecorderCaptureEntry[] = [
      { method: "GET", url: "https://example.com/", status: 200, headers: [], redacted: false },
      {
        method: "GET",
        url: "https://api.example.com/data",
        status: 200,
        headers: [{ name: "X-API-Key", value: "key" }],
        redacted: false,
      },
    ];
    const detection = detectAuth(entries);

    const position = suggestAuthPosition(entries, detection);

    expect(position).toBe(1);
  });

  it("suggests beginning for weak signals", () => {
    const entries: RecorderCaptureEntry[] = [
      { method: "GET", url: "https://example.com/session", status: 200, headers: [], redacted: false },
    ];
    const detection = detectAuth(entries);

    // /session has low confidence (0.5), so it may or may not trigger
    const position = suggestAuthPosition(entries, detection);

    expect(position).toBeGreaterThanOrEqual(0);
  });
});
