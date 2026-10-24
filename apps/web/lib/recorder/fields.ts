/**
 * Request-field coercion shared by the recorder proxies, so the two of them
 * cannot drift on how names, URLs and viewport numbers are read.
 */

export function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function intField(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
}
