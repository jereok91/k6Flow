/**
 * Conversions for run-history metrics persisted in run_ownership.
 *
 * error_rate is stored as basis points (percentage * 100, e.g. 5.5% = 550);
 * the app works with a 0-1 fraction everywhere else.
 */

const MAX_BASIS_POINTS = 10000;

export function errorRateToStored(fraction: number): number | undefined {
  if (!Number.isFinite(fraction)) return undefined;
  const bp = Math.round(fraction * MAX_BASIS_POINTS);
  return Math.min(MAX_BASIS_POINTS, Math.max(0, bp));
}

export function storedToErrorRate(stored: number | null | undefined): number | undefined {
  if (stored === null || stored === undefined) return undefined;
  return stored / MAX_BASIS_POINTS;
}
