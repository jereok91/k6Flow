/**
 * K6F8-02: Auth detection heuristics.
 *
 * Identifies authentication-related requests in captured traffic
 * and suggests auth node placement.
 */

import type { RecorderCaptureEntry } from "./recorder-contracts";

/**
 * Authentication signal detected in a capture.
 */
export interface AuthSignal {
  /** Index of the capture entry */
  index: number;
  /** Confidence level (0-1) */
  confidence: number;
  /** Type of authentication detected */
  type: "login" | "token-exchange" | "oauth" | "api-key" | "basic-auth";
  /** Human-readable reason */
  reason: string;
}

/**
 * Result of auth detection analysis.
 */
export interface AuthDetectionResult {
  /** Detected auth signals, sorted by confidence (highest first) */
  signals: AuthSignal[];
  /** Suggested index for auth node placement (null if no auth detected) */
  suggestedAuthIndex: number | null;
  /** Whether the sequence likely needs an auth node */
  needsAuth: boolean;
}

// URL patterns that suggest authentication
const AUTH_URL_PATTERNS = [
  { pattern: /\/login/i, type: "login" as const, weight: 0.8 },
  { pattern: /\/signin/i, type: "login" as const, weight: 0.8 },
  { pattern: /\/auth\//i, type: "login" as const, weight: 0.7 },
  { pattern: /\/authenticate/i, type: "login" as const, weight: 0.8 },
  { pattern: /\/session/i, type: "login" as const, weight: 0.5 },
  { pattern: /\/oauth/i, type: "oauth" as const, weight: 0.9 },
  { pattern: /\/token/i, type: "token-exchange" as const, weight: 0.7 },
  { pattern: /\/api\/v\d+\/auth/i, type: "login" as const, weight: 0.8 },
];

// Request headers that suggest authentication
const AUTH_HEADER_PATTERNS = [
  { header: "authorization", type: "api-key" as const, weight: 0.6 },
  { header: "x-api-key", type: "api-key" as const, weight: 0.7 },
  { header: "x-auth-token", type: "token-exchange" as const, weight: 0.7 },
];

// Response patterns that suggest successful auth
const AUTH_RESPONSE_PATTERNS = [
  { status: 200, method: "POST", urlPattern: /login|signin|auth/i, weight: 0.4 },
  { status: 201, method: "POST", urlPattern: /session|token/i, weight: 0.4 },
];

// Body field patterns that suggest auth request
// Higher weights win - grant_type is more specific than password alone
const AUTH_BODY_PATTERNS = [
  { pattern: /"grant_type"/i, weight: 0.95, type: "oauth" as const },
  { pattern: /"password"/i, weight: 0.9, type: "login" as const },
  { pattern: /"passwd"/i, weight: 0.9, type: "login" as const },
  { pattern: /"username"/i, weight: 0.5, type: "login" as const },
  { pattern: /"email".*"password"/i, weight: 0.8, type: "login" as const },
  { pattern: /"client_id"/i, weight: 0.5, type: "oauth" as const },
  { pattern: /"refresh_token"/i, weight: 0.7, type: "token-exchange" as const },
  { pattern: /"access_token"/i, weight: 0.6, type: "token-exchange" as const },
];

// Headers that suggest Basic Auth
const BASIC_AUTH_PATTERN = /^Basic\s+/i;

/**
 * Detect authentication signals in captured traffic.
 */
export function detectAuth(entries: RecorderCaptureEntry[]): AuthDetectionResult {
  const signals: AuthSignal[] = [];

  entries.forEach((entry, index) => {
    const entrySignals = analyzeEntry(entry, index);
    signals.push(...entrySignals);
  });

  // Sort by confidence (highest first)
  signals.sort((a, b) => b.confidence - a.confidence);

  // Determine suggested auth index
  const suggestedAuthIndex = signals.length > 0 && signals[0].confidence >= 0.5
    ? signals[0].index
    : null;

  return {
    signals,
    suggestedAuthIndex,
    needsAuth: suggestedAuthIndex !== null,
  };
}

/**
 * Analyze a single entry for auth signals.
 */
function analyzeEntry(entry: RecorderCaptureEntry, index: number): AuthSignal[] {
  const signals: AuthSignal[] = [];
  let maxConfidence = 0;
  let bestType: AuthSignal["type"] = "login";
  const reasons: string[] = [];

  // Helper to update best match (only update type if confidence is higher)
  const updateBest = (weight: number, type: AuthSignal["type"], reason: string) => {
    reasons.push(reason);
    if (weight > maxConfidence) {
      maxConfidence = weight;
      bestType = type;
    }
  };

  // Check URL patterns
  for (const { pattern, type, weight } of AUTH_URL_PATTERNS) {
    if (pattern.test(entry.url)) {
      updateBest(weight, type, `URL matches ${type} pattern`);
    }
  }

  // Check for Authorization header (existing auth)
  const authHeader = entry.headers.find(h => 
    h.name.toLowerCase() === "authorization"
  );
  if (authHeader) {
    if (BASIC_AUTH_PATTERN.test(authHeader.value)) {
      updateBest(0.9, "basic-auth", "Basic Auth header present");
    } else {
      updateBest(0.6, "api-key", "Authorization header present");
    }
  }

  // Check other auth headers
  for (const { header, type, weight } of AUTH_HEADER_PATTERNS) {
    if (entry.headers.some(h => h.name.toLowerCase() === header)) {
      updateBest(weight, type, `${header} header present`);
    }
  }

  // Check body patterns (for POST requests)
  if (entry.method === "POST" && entry.bodyExcerpt) {
    for (const { pattern, weight, type } of AUTH_BODY_PATTERNS) {
      if (pattern.test(entry.bodyExcerpt)) {
        updateBest(weight, type, `Body contains ${type} fields`);
      }
    }
  }

  // Check response patterns (additive bonus, doesn't change type)
  for (const { status, method, urlPattern, weight } of AUTH_RESPONSE_PATTERNS) {
    if (entry.status === status && entry.method === method && urlPattern.test(entry.url)) {
      maxConfidence = Math.min(1, maxConfidence + weight);
      reasons.push("Successful auth response pattern");
    }
  }

  // Only add signal if we found something
  if (maxConfidence > 0) {
    signals.push({
      index,
      confidence: Math.min(1, maxConfidence),
      type: bestType,
      reason: reasons.join("; "),
    });
  }

  return signals;
}

/**
 * Find the best position to insert an auth node.
 *
 * Auth nodes should be placed:
 * 1. Before the first request that uses auth headers (if auth is already present)
 * 2. At the login request (if detected)
 * 3. At the beginning if no clear pattern
 */
export function suggestAuthPosition(
  entries: RecorderCaptureEntry[],
  detection: AuthDetectionResult
): number {
  if (!detection.needsAuth) {
    return 0;
  }

  // If we detected a login request, place auth there
  const loginSignal = detection.signals.find(s => 
    s.type === "login" && s.confidence >= 0.7
  );
  if (loginSignal) {
    return loginSignal.index;
  }

  // If we detected api-key or basic-auth usage, place before first usage
  const authUsageSignal = detection.signals.find(s =>
    (s.type === "api-key" || s.type === "basic-auth") && s.confidence >= 0.5
  );
  if (authUsageSignal) {
    return Math.max(0, authUsageSignal.index);
  }

  // Default to suggested index or beginning
  return detection.suggestedAuthIndex ?? 0;
}
