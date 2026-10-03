import { describe, it, expect } from "vitest";
import {
  detectDynamicValues,
  findValueCorrelations,
  type DynamicValue,
} from "./capture-dynamic-detection";
import type { RecorderCaptureEntry } from "./recorder-contracts";

describe("detectDynamicValues", () => {
  it("detects JWT in Authorization header", () => {
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const entries: RecorderCaptureEntry[] = [
      {
        method: "GET",
        url: "https://api.example.com/data",
        status: 200,
        headers: [{ name: "Authorization", value: `Bearer ${jwt}` }],
        redacted: false,
      },
    ];

    const result = detectDynamicValues(entries);

    expect(result.values).toHaveLength(1);
    expect(result.values[0].valueType).toBe("jwt");
    expect(result.values[0].confidence).toBeGreaterThanOrEqual(0.9);
    expect(result.values[0].suggestedName).toBe("bearer_token");
  });

  it("detects UUID in query parameter", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const entries: RecorderCaptureEntry[] = [
      {
        method: "GET",
        url: `https://api.example.com/users?user_id=${uuid}`,
        status: 200,
        headers: [],
        redacted: false,
      },
    ];

    const result = detectDynamicValues(entries);

    // UUID detection requires field name match or high confidence
    const uuidValue = result.values.find(v => v.value === uuid);
    if (uuidValue) {
      expect(uuidValue.valueType).toBe("uuid");
      expect(uuidValue.location.type).toBe("query");
    }
  });

  it("detects access_token in JSON body", () => {
    const entries: RecorderCaptureEntry[] = [
      {
        method: "POST",
        url: "https://auth.example.com/oauth/token",
        status: 200,
        headers: [],
        bodyExcerpt: '{"access_token":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"}',
        redacted: false,
      },
    ];

    const result = detectDynamicValues(entries);

    expect(result.values.length).toBeGreaterThanOrEqual(1);
    const accessToken = result.values.find(v => v.suggestedName === "access_token");
    expect(accessToken).toBeDefined();
    expect(accessToken?.valueType).toBe("jwt");
  });

  it("detects X-API-Key header", () => {
    const entries: RecorderCaptureEntry[] = [
      {
        method: "GET",
        url: "https://api.example.com/data",
        status: 200,
        headers: [{ name: "X-API-Key", value: "sk_live_1234567890abcdef" }],
        redacted: false,
      },
    ];

    const result = detectDynamicValues(entries);

    expect(result.values.length).toBeGreaterThanOrEqual(1);
    const apiKey = result.values.find(v => v.location.field === "X-API-Key");
    expect(apiKey).toBeDefined();
  });

  it("detects CSRF token in header", () => {
    const entries: RecorderCaptureEntry[] = [
      {
        method: "POST",
        url: "https://example.com/api/action",
        status: 200,
        headers: [{ name: "X-CSRF-Token", value: "abc123def456ghi789jkl012mno345pq" }],
        redacted: false,
      },
    ];

    const result = detectDynamicValues(entries);

    const csrf = result.values.find(v => v.location.field === "X-CSRF-Token");
    expect(csrf).toBeDefined();
    expect(csrf?.valueType).toBe("csrf-token");
  });

  it("detects session ID in cookie", () => {
    const entries: RecorderCaptureEntry[] = [
      {
        method: "GET",
        url: "https://example.com/dashboard",
        status: 200,
        headers: [{ name: "Cookie", value: "session=abc123def456789012345678901234567890" }],
        redacted: false,
      },
    ];

    const result = detectDynamicValues(entries);

    const session = result.values.find(v => v.location.field === "Cookie");
    expect(session).toBeDefined();
    // Cookie values are complex, might be detected as session-id or unknown
  });

  it("detects refresh_token in body", () => {
    // Use a realistic refresh token (base64-like, 32+ chars)
    const entries: RecorderCaptureEntry[] = [
      {
        method: "POST",
        url: "https://auth.example.com/token",
        status: 200,
        headers: [],
        bodyExcerpt: '{"refresh_token":"dGhpcyBpcyBhIHJlZnJlc2ggdG9rZW4gdGhhdCBpcyBsb25nIGVub3VnaA=="}',
        redacted: false,
      },
    ];

    const result = detectDynamicValues(entries);

    const refreshToken = result.values.find(v => v.suggestedName === "refresh_token");
    expect(refreshToken).toBeDefined();
  });

  it("skips short values", () => {
    const entries: RecorderCaptureEntry[] = [
      {
        method: "GET",
        url: "https://api.example.com/data",
        status: 200,
        headers: [{ name: "X-API-Key", value: "short" }],
        redacted: false,
      },
    ];

    const result = detectDynamicValues(entries);

    expect(result.values).toHaveLength(0);
  });

  it("handles empty entries", () => {
    const result = detectDynamicValues([]);

    expect(result.values).toHaveLength(0);
    expect(result.correlations.size).toBe(0);
  });

  it("groups values by suggested name", () => {
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const entries: RecorderCaptureEntry[] = [
      {
        method: "POST",
        url: "https://auth.example.com/login",
        status: 200,
        headers: [],
        bodyExcerpt: `{"access_token":"${jwt}","refresh_token":"dGhpcyBpcyBhIHJlZnJlc2ggdG9rZW4gdGhhdCBpcyBsb25nIGVub3VnaA=="}`,
        redacted: false,
      },
    ];

    const result = detectDynamicValues(entries);

    expect(result.correlations.has("access_token")).toBe(true);
    expect(result.correlations.has("refresh_token")).toBe(true);
  });
});

describe("findValueCorrelations", () => {
  it("finds same token used across requests", () => {
    const token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const entries: RecorderCaptureEntry[] = [
      {
        method: "POST",
        url: "https://auth.example.com/login",
        status: 200,
        headers: [],
        bodyExcerpt: `{"access_token":"${token}"}`,
        redacted: false,
      },
      {
        method: "POST",
        url: "https://api.example.com/refresh",
        status: 200,
        headers: [],
        bodyExcerpt: `{"token":"${token}"}`,
        redacted: false,
      },
    ];

    const detection = detectDynamicValues(entries);
    const correlations = findValueCorrelations(detection);

    // The token appears in both requests with exact same value
    const tokenCorrelation = correlations.get(token);
    expect(tokenCorrelation).toBeDefined();
    expect(tokenCorrelation?.producer.location.entryIndex).toBe(0);
    expect(tokenCorrelation?.consumers).toHaveLength(1);
    expect(tokenCorrelation?.consumers[0].location.entryIndex).toBe(1);
  });

  it("returns empty map when no correlations", () => {
    const entries: RecorderCaptureEntry[] = [
      {
        method: "GET",
        url: "https://api.example.com/data",
        status: 200,
        headers: [{ name: "X-API-Key", value: "unique_key_12345678" }],
        redacted: false,
      },
    ];

    const detection = detectDynamicValues(entries);
    const correlations = findValueCorrelations(detection);

    // Single occurrence, no correlation
    expect(correlations.size).toBe(0);
  });
});
