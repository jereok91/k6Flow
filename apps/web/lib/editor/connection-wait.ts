/**
 * The wait between two requests is stored on the connection in seconds, but a
 * user may think in seconds or minutes. Conversion, validation and the edge
 * label live here so the panel stays presentational and the rule is testable
 * without a browser.
 */

/** Unit the user types the wait in; the graph always stores seconds. */
export type WaitUnit = "seconds" | "minutes";

export const WAIT_UNITS: readonly WaitUnit[] = ["seconds", "minutes"];

/** Mirrors the contract bound in the shared graph schema. */
export const MAX_WAIT_SECONDS = 3600;

/** Seconds for a typed value, so a panel never persists a unit. */
export function toSeconds(value: number, unit: WaitUnit): number {
  return unit === "minutes" ? value * 60 : value;
}

/** Value and unit that show a stored wait most readably. */
export function toDisplay(seconds: number): { value: number; unit: WaitUnit } {
  if (seconds >= 60 && seconds % 60 === 0) return { value: seconds / 60, unit: "minutes" };
  return { value: seconds, unit: "seconds" };
}

/** Short label drawn on the connection, or undefined when there is no wait. */
export function formatWaitLabel(seconds: number | undefined): string | undefined {
  if (seconds === undefined || seconds <= 0) return undefined;
  const { value, unit } = toDisplay(seconds);
  return unit === "minutes" ? `${value} min` : `${value} s`;
}

/** A wait the contract will accept: finite and within 0..MAX_WAIT_SECONDS. */
export function isValidWait(seconds: number): boolean {
  return Number.isFinite(seconds) && seconds >= 0 && seconds <= MAX_WAIT_SECONDS;
}
