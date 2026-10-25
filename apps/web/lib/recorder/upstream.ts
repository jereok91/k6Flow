/**
 * Shared access to the recorder service from the web tier.
 *
 * The recorder keeps its own HTTP contract; this module owns the two details
 * every proxy needs: where it lives and which token it accepts.
 */

export function recorderBaseUrl(): string {
  return process.env.RECORDER_UPSTREAM || "http://localhost:8081";
}

/**
 * Token the recorder expects. The server-side value wins; the caller's bearer
 * header keeps local setups (and older clients) working.
 */
export function recorderToken(request: Request): string {
  if (process.env.RECORDER_AUTH_TOKEN) return process.env.RECORDER_AUTH_TOKEN;
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1] : "dev-token";
}
