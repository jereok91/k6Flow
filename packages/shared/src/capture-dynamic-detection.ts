/**
 * K6F8-03: Dynamic value detection.
 *
 * Identifies values that should be parameterized in captured traffic:
 * tokens, session IDs, CSRF tokens, timestamps, UUIDs, etc.
 */

import type { RecorderCaptureEntry } from "./recorder-contracts";

/**
 * A detected dynamic value that should be parameterized.
 */
export interface DynamicValue {
  /** Original value found */
  value: string;
  /** Where the value was found */
  location: {
    /** Capture entry index */
    entryIndex: number;
    /** Location type */
    type: "header" | "query" | "body" | "url-path";
    /** Field name (header name, query param name, or JSON path) */
    field: string;
  };
  /** Type of dynamic value detected */
  valueType: "jwt" | "uuid" | "session-id" | "csrf-token" | "timestamp" | "bearer-token" | "api-key" | "unknown";
  /** Confidence level (0-1) */
  confidence: number;
  /** Suggested parameter name */
  suggestedName: string;
}

/**
 * Result of dynamic value detection.
 */
export interface DynamicDetectionResult {
  /** All detected dynamic values */
  values: DynamicValue[];
  /** Grouped by suggested parameter name for correlation */
  correlations: Map<string, DynamicValue[]>;
}

// JWT pattern: three base64url segments separated by dots
const JWT_PATTERN = /^eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

// UUID patterns (various formats)
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_NO_DASHES = /^[0-9a-f]{32}$/i;

// Session ID patterns (common formats)
const SESSION_PATTERNS = [
  /^[a-f0-9]{32,64}$/i,  // Hex session IDs
  /^sess_[a-zA-Z0-9_-]+$/,  // Prefixed session
  /^s%3A[A-Za-z0-9%_-]+/,  // Express session (URL encoded)
];

// CSRF token patterns
const CSRF_PATTERNS = [
  /^[A-Za-z0-9+/=]{32,}$/,  // Base64 tokens
  /^[a-f0-9]{32,64}$/i,  // Hex tokens
];

// Timestamp patterns
const TIMESTAMP_PATTERNS = [
  /^\d{13}$/,  // Unix ms
  /^\d{10}$/,  // Unix seconds
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,  // ISO 8601
];

// Header names that typically contain dynamic values
const DYNAMIC_HEADER_NAMES = new Set([
  "authorization",
  "x-auth-token",
  "x-access-token",
  "x-api-key",
  "x-csrf-token",
  "x-xsrf-token",
  "x-request-id",
  "x-correlation-id",
  "x-session-id",
  "cookie",
  "set-cookie",
]);

// Query/body field names that typically contain dynamic values
const DYNAMIC_FIELD_NAMES: Array<{ pattern: RegExp; type: DynamicValue["valueType"]; name: string }> = [
  { pattern: /^(access_?)?token$/i, type: "bearer-token", name: "access_token" },
  { pattern: /^refresh_?token$/i, type: "bearer-token", name: "refresh_token" },
  { pattern: /^(id_?)?token$/i, type: "jwt", name: "id_token" },
  { pattern: /^session_?id$/i, type: "session-id", name: "session_id" },
  { pattern: /^(csrf|xsrf)_?token$/i, type: "csrf-token", name: "csrf_token" },
  { pattern: /^api_?key$/i, type: "api-key", name: "api_key" },
  { pattern: /^timestamp$/i, type: "timestamp", name: "timestamp" },
  { pattern: /^nonce$/i, type: "unknown", name: "nonce" },
  { pattern: /^state$/i, type: "unknown", name: "oauth_state" },
];

/**
 * Detect dynamic values in captured traffic.
 */
export function detectDynamicValues(entries: RecorderCaptureEntry[]): DynamicDetectionResult {
  const values: DynamicValue[] = [];

  entries.forEach((entry, entryIndex) => {
    // Check headers
    for (const header of entry.headers) {
      const headerLower = header.name.toLowerCase();
      
      if (DYNAMIC_HEADER_NAMES.has(headerLower)) {
        const detected = analyzeValue(header.value, {
          entryIndex,
          type: "header",
          field: header.name,
        });
        if (detected) {
          values.push(detected);
        }
      }
    }

    // Check query parameters (parse from URL)
    const queryValues = extractQueryParams(entry.url);
    for (const [name, value] of queryValues) {
      const fieldMatch = DYNAMIC_FIELD_NAMES.find(f => f.pattern.test(name));
      if (fieldMatch) {
        const detected = analyzeValue(value, {
          entryIndex,
          type: "query",
          field: name,
        });
        if (detected) {
          detected.suggestedName = fieldMatch.name;
          values.push(detected);
        }
      } else {
        // Check if value looks dynamic
        const detected = analyzeValue(value, {
          entryIndex,
          type: "query",
          field: name,
        });
        if (detected && detected.confidence >= 0.7) {
          values.push(detected);
        }
      }
    }

    // Check body (JSON only for now)
    if (entry.bodyExcerpt && !entry.bodyExcerpt.startsWith("[binary")) {
      const bodyValues = extractJsonValues(entry.bodyExcerpt);
      for (const [path, value] of bodyValues) {
        if (typeof value !== "string") continue;
        
        const fieldName = path.split(".").pop() ?? path;
        const fieldMatch = DYNAMIC_FIELD_NAMES.find(f => f.pattern.test(fieldName));
        
        if (fieldMatch) {
          const detected = analyzeValue(value, {
            entryIndex,
            type: "body",
            field: path,
          });
          if (detected) {
            detected.suggestedName = fieldMatch.name;
            values.push(detected);
          }
        } else if (value.length > 10) {
          const detected = analyzeValue(value, {
            entryIndex,
            type: "body",
            field: path,
          });
          if (detected && detected.confidence >= 0.7) {
            values.push(detected);
          }
        }
      }
    }
  });

  // Build correlations
  const correlations = new Map<string, DynamicValue[]>();
  for (const v of values) {
    const existing = correlations.get(v.suggestedName) ?? [];
    existing.push(v);
    correlations.set(v.suggestedName, existing);
  }

  return { values, correlations };
}

/**
 * Analyze a value to determine if it's dynamic.
 */
function analyzeValue(
  value: string,
  location: DynamicValue["location"]
): DynamicValue | null {
  // Skip empty or very short values
  if (!value || value.length < 8) {
    return null;
  }

  // Handle cookie header specially
  if (location.type === "header" && location.field.toLowerCase() === "cookie") {
    // Extract session-like values from cookie
    const sessionMatch = value.match(/session[^=]*=([^;]+)/i);
    if (sessionMatch) {
      const sessionValue = sessionMatch[1];
      if (SESSION_PATTERNS.some(p => p.test(sessionValue))) {
        return {
          value,
          location,
          valueType: "session-id",
          confidence: 0.8,
          suggestedName: "session_cookie",
        };
      }
    }
    return null;
  }

  let valueType: DynamicValue["valueType"] = "unknown";
  let confidence = 0;
  let suggestedName = location.field.toLowerCase().replace(/[^a-z0-9]/g, "_");

  // Check JWT
  if (JWT_PATTERN.test(value)) {
    valueType = "jwt";
    confidence = 0.95;
    suggestedName = location.field.includes("access") ? "access_token" 
      : location.field.includes("refresh") ? "refresh_token"
      : location.field.includes("id") ? "id_token"
      : "jwt_token";
  }
  // Check UUID
  else if (UUID_PATTERN.test(value) || UUID_NO_DASHES.test(value)) {
    valueType = "uuid";
    confidence = 0.85;
    suggestedName = `${suggestedName}_id`;
  }
  // Check Bearer token in Authorization header
  else if (location.type === "header" && location.field.toLowerCase() === "authorization") {
    if (value.startsWith("Bearer ")) {
      const token = value.slice(7);
      if (JWT_PATTERN.test(token)) {
        valueType = "jwt";
        confidence = 0.95;
        suggestedName = "bearer_token";
      } else {
        valueType = "bearer-token";
        confidence = 0.85;
        suggestedName = "bearer_token";
      }
    }
  }
  // Check timestamps
  else if (TIMESTAMP_PATTERNS.some(p => p.test(value))) {
    valueType = "timestamp";
    confidence = 0.7;
    suggestedName = "timestamp";
  }
  // Check session patterns
  else if (SESSION_PATTERNS.some(p => p.test(value))) {
    valueType = "session-id";
    confidence = 0.75;
    suggestedName = "session_id";
  }
  // Check CSRF patterns
  else if (
    (location.field.toLowerCase().includes("csrf") || 
     location.field.toLowerCase().includes("xsrf")) &&
    CSRF_PATTERNS.some(p => p.test(value))
  ) {
    valueType = "csrf-token";
    confidence = 0.85;
    suggestedName = "csrf_token";
  }
  // Check API key patterns
  else if (
    location.field.toLowerCase().includes("api") &&
    location.field.toLowerCase().includes("key")
  ) {
    valueType = "api-key";
    confidence = 0.8;
    suggestedName = "api_key";
  }
  // Check token field names (fallback for tokens that don't match specific patterns)
  else if (
    location.field.toLowerCase().includes("token") ||
    location.field.toLowerCase().includes("secret") ||
    location.field.toLowerCase().includes("key")
  ) {
    valueType = "bearer-token";
    confidence = 0.6;
    suggestedName = location.field.toLowerCase().replace(/[^a-z0-9]/g, "_");
  }

  if (confidence > 0) {
    return {
      value,
      location,
      valueType,
      confidence,
      suggestedName,
    };
  }

  return null;
}

/**
 * Extract query parameters from URL.
 */
function extractQueryParams(url: string): Array<[string, string]> {
  const params: Array<[string, string]> = [];
  const queryIndex = url.indexOf("?");
  if (queryIndex === -1) return params;

  const queryString = url.slice(queryIndex + 1);
  for (const pair of queryString.split("&")) {
    const eqIndex = pair.indexOf("=");
    if (eqIndex === -1) continue;
    const name = decodeURIComponent(pair.slice(0, eqIndex));
    const value = decodeURIComponent(pair.slice(eqIndex + 1));
    params.push([name, value]);
  }

  return params;
}

/**
 * Extract field values from JSON body.
 * Returns array of [path, value] pairs.
 */
function extractJsonValues(body: string): Array<[string, unknown]> {
  const results: Array<[string, unknown]> = [];

  try {
    const parsed = JSON.parse(body);
    extractObjectValues(parsed, "", results);
  } catch {
    // Not valid JSON, skip
  }

  return results;
}

function extractObjectValues(
  obj: unknown,
  path: string,
  results: Array<[string, unknown]>
): void {
  if (obj === null || obj === undefined) return;

  if (typeof obj === "object" && !Array.isArray(obj)) {
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const newPath = path ? `${path}.${key}` : key;
      if (typeof value === "string" || typeof value === "number") {
        results.push([newPath, value]);
      } else {
        extractObjectValues(value, newPath, results);
      }
    }
  } else if (Array.isArray(obj)) {
    obj.forEach((item, index) => {
      extractObjectValues(item, `${path}[${index}]`, results);
    });
  }
}

/**
 * Find correlations between dynamic values.
 * Same value appearing in multiple requests suggests data flow.
 */
export function findValueCorrelations(
  result: DynamicDetectionResult
): Map<string, { producer: DynamicValue; consumers: DynamicValue[] }> {
  const correlations = new Map<string, { producer: DynamicValue; consumers: DynamicValue[] }>();

  // Group by actual value
  const byValue = new Map<string, DynamicValue[]>();
  for (const v of result.values) {
    const existing = byValue.get(v.value) ?? [];
    existing.push(v);
    byValue.set(v.value, existing);
  }

  // Find values that appear multiple times (produced then consumed)
  for (const [value, occurrences] of byValue) {
    if (occurrences.length > 1) {
      // Sort by entry index to find producer
      occurrences.sort((a, b) => a.location.entryIndex - b.location.entryIndex);
      correlations.set(value, {
        producer: occurrences[0],
        consumers: occurrences.slice(1),
      });
    }
  }

  return correlations;
}
