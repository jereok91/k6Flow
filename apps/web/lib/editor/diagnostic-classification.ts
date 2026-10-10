import {
  readOwnedDiagnostic,
  type DiagnosticReadOptions,
} from "./diagnostic-polling";
import {
  parseDiagnosticSnapshot,
  type DiagnosticSnapshot,
} from "./diagnostic-snapshot";

export type DiagnosticClassification =
  | { kind: "diagnostic"; snapshot: DiagnosticSnapshot }
  | { kind: "load" }
  | { kind: "unavailable"; error: "diagnostic-unavailable" }
  | { kind: "stale" };

export interface DiagnosticClassificationOptions extends DiagnosticReadOptions {
  /** Caller captures its AsyncLifetime ticket; ID equality alone is insufficient. */
  isCurrent?: () => boolean;
}

/** Must resolve before mounting either panel for an unknown historical run. */
export async function classifyDiagnosticRun(
  runId: string,
  options: DiagnosticClassificationOptions = {},
): Promise<DiagnosticClassification> {
  const current = () => !options.signal?.aborted && (options.isCurrent?.() ?? true);
  if (!current()) {
    return { kind: "stale" };
  }
  try {
    const response = await readOwnedDiagnostic(runId, options);
    if (!current()) {
      return { kind: "stale" };
    }
    if (response.status === 409) {
      return { kind: "load" };
    }
    if (response.status === 200) {
      return {
        kind: "diagnostic",
        snapshot: parseDiagnosticSnapshot(response.data, runId),
      };
    }
  } catch {
    /* Fixed error below; never classify a failed probe as load. */
  }
  return current()
    ? { kind: "unavailable", error: "diagnostic-unavailable" }
    : { kind: "stale" };
}
