// Client-safe twin of the server's expected-session header. The marker is a
// non-credential session binding: never log, persist or put it in a body.
export const SESSION_MARKER_HEADER = "X-K6Flow-Session-Marker";

const MARKER_PATTERN = /^[a-f0-9]{64}$/;

export function isSessionMarker(value: unknown): value is string {
  return typeof value === "string" && MARKER_PATTERN.test(value);
}

export type MarkerFetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Wraps a fetch so every request carries exactly this session marker. */
export function withSessionMarker(fetcher: MarkerFetch, marker: string): MarkerFetch {
  if (!isSessionMarker(marker)) throw new Error("Invalid session marker");
  return (url, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set(SESSION_MARKER_HEADER, marker);
    return fetcher(url, { ...init, headers });
  };
}
