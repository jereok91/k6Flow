/**
 * Data redaction - mask sensitive data before persistence
 */

// Sensitive field names (case-insensitive)
const SENSITIVE_FIELDS = new Set([
  "password",
  "passwd",
  "secret",
  "token",
  "api_key",
  "apikey",
  "api-key",
  "access_token",
  "accesstoken",
  "refresh_token",
  "refreshtoken",
  "authorization",
  "auth",
  "bearer",
  "credential",
  "credentials",
  "private_key",
  "privatekey",
  "private-key",
  "ssn",
  "social_security",
  "credit_card",
  "creditcard",
  "card_number",
  "cardnumber",
  "cvv",
  "cvc",
  "pin",
  "bank_account",
  "routing_number",
]);

// Patterns for sensitive data
const SENSITIVE_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // JWT tokens
  { pattern: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, replacement: "[REDACTED_JWT]" },
  // Bearer tokens
  { pattern: /Bearer\s+[A-Za-z0-9_-]+/gi, replacement: "Bearer [REDACTED]" },
  // API keys (common formats)
  { pattern: /(?:api[_-]?key|apikey)[=:]\s*["']?[A-Za-z0-9_-]{20,}["']?/gi, replacement: "api_key=[REDACTED]" },
  // Credit card numbers (basic)
  { pattern: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g, replacement: "[REDACTED_CARD]" },
  // SSN
  { pattern: /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g, replacement: "[REDACTED_SSN]" },
  // Email addresses (optional)
  // { pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, replacement: "[REDACTED_EMAIL]" },
];

/**
 * Check if a field name is sensitive
 */
function isSensitiveField(fieldName: string): boolean {
  return SENSITIVE_FIELDS.has(fieldName.toLowerCase());
}

/**
 * Redact sensitive patterns from a string
 */
export function redactString(value: string): string {
  let result = value;
  for (const { pattern, replacement } of SENSITIVE_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/**
 * Redact sensitive data from headers (name/value format)
 */
export function redactHeaders(
  headers: Array<{ name: string; value: string }>
): Array<{ name: string; value: string }> {
  return headers.map((h) => {
    if (isSensitiveField(h.name)) {
      return { name: h.name, value: "[REDACTED]" };
    }
    return { name: h.name, value: redactString(h.value) };
  });
}

/**
 * Redact sensitive data from headers (key/value format)
 */
export function redactHeadersKV(
  headers: Array<{ key: string; value: string }>
): Array<{ key: string; value: string }> {
  return headers.map((h) => {
    if (isSensitiveField(h.key)) {
      return { key: h.key, value: "[REDACTED]" };
    }
    return { key: h.key, value: redactString(h.value) };
  });
}

/**
 * Redact sensitive data from JSON body
 */
export function redactJsonBody(body: unknown): unknown {
  if (body === null || body === undefined) {
    return body;
  }

  if (typeof body === "string") {
    // Try to parse as JSON
    try {
      const parsed = JSON.parse(body);
      return JSON.stringify(redactJsonBody(parsed));
    } catch {
      return redactString(body);
    }
  }

  if (Array.isArray(body)) {
    return body.map(redactJsonBody);
  }

  if (typeof body === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) {
      if (isSensitiveField(key)) {
        result[key] = "[REDACTED]";
      } else if (typeof value === "string") {
        result[key] = redactString(value);
      } else {
        result[key] = redactJsonBody(value);
      }
    }
    return result;
  }

  return body;
}

/**
 * Redact sensitive data from URL query parameters
 */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const params = new URLSearchParams(parsed.search);
    
    for (const [key] of params) {
      if (isSensitiveField(key)) {
        params.set(key, "[REDACTED]");
      }
    }
    
    parsed.search = params.toString();
    return parsed.toString();
  } catch {
    return redactString(url);
  }
}

export interface RedactionConfig {
  /** Redact headers (default: true) */
  redactHeaders?: boolean;
  /** Redact body content (default: true) */
  redactBody?: boolean;
  /** Redact URL query params (default: true) */
  redactUrl?: boolean;
  /** Additional sensitive field names */
  additionalSensitiveFields?: string[];
  /** Fields to never redact */
  ignoreFields?: string[];
}

export interface HttpCapture {
  url: string;
  method: string;
  headers?: Array<{ name: string; value: string }>;
  body?: string;
  responseHeaders?: Array<{ name: string; value: string }>;
  responseBody?: string;
}

/**
 * Redact all sensitive data from an HTTP capture
 */
export function redactCapture(capture: HttpCapture, config: RedactionConfig = {}): HttpCapture {
  const {
    redactHeaders: shouldRedactHeaders = true,
    redactBody = true,
    redactUrl: shouldRedactUrl = true,
  } = config;

  const result: HttpCapture = {
    ...capture,
  };

  if (shouldRedactUrl) {
    result.url = redactUrl(capture.url);
  }

  if (shouldRedactHeaders && capture.headers) {
    result.headers = redactHeaders(capture.headers);
  }

  if (redactBody && capture.body) {
    const redacted = redactJsonBody(capture.body);
    result.body = typeof redacted === "string" ? redacted : JSON.stringify(redacted);
  }

  if (shouldRedactHeaders && capture.responseHeaders) {
    result.responseHeaders = redactHeaders(capture.responseHeaders);
  }

  if (redactBody && capture.responseBody) {
    const redacted = redactJsonBody(capture.responseBody);
    result.responseBody = typeof redacted === "string" ? redacted : JSON.stringify(redacted);
  }

  return result;
}
