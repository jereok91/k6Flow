/**
 * K6F5-02 + K6F6-04: Run scenario service.
 *
 * Translates graph to K6 script and submits to the orchestrator.
 */

import { translateToK6, type K6TranslationError, type K6TranslatorOptions } from "@k6flow/shared";
import type { GraphDraftComposition } from "@k6flow/shared";
import {
  cloneDiagnosticInput,
  prepareDiagnosticDisplay,
  type ExecutionDisplay,
  type OwnedDiagnosticMetadata,
} from "./diagnostic-preparation";
import { computeRunResources } from "./run-resources";
import { describeStartError, parseStartErrorBody } from "./run-failure";
import { formatTranslationErrors, loadRunVariables, parseProxyRunError } from "./run-variables";

// Use Next.js API proxy to reach the orchestrator
// This works both in Docker (where browser can't reach orchestrator directly)
// and in development
const ORCHESTRATOR_API = "/api/orchestrator";

/**
 * Attachment data to include with the run.
 */
export interface RunAttachment {
  /** Attachment ID (matches filename without extension) */
  id: string;
  /** File name */
  name: string;
  /** Base64-encoded file content */
  data: string;
}

/**
 * Run configuration for starting a scenario execution.
 */
export interface RunConfig {
  mode?: "load" | "diagnostic";
  /** Virtual users */
  vus?: number;
  /** Duration in milliseconds */
  durationMs?: number;
  /** CPU limit in millicores (defaults to computeRunResources(vus)) */
  cpuMillis?: number;
  /** Memory limit in MiB (defaults to computeRunResources(vus)) */
  memoryMiB?: number;
  /** Attachments (CSV files) to include */
  attachments?: RunAttachment[];
  /** Scenario ID for history tracking */
  scenarioId?: string;
  /** Scenario name for history tracking */
  scenarioName?: string;
  /** Environment whose variables apply to the run (scenario variables override them) */
  environmentId?: string;
}

/**
 * Result of starting a run.
 */
export interface RunStartResult {
  success: boolean;
  executionDisplay?: ExecutionDisplay;
  diagnostic?: OwnedDiagnosticMetadata;
  runId?: string;
  error?: string;
  /** Orchestrator error code, passed through unchanged (e.g. "vus-limit-exceeded") */
  errorCode?: string;
  /** Orchestrator error message, passed through unchanged */
  errorMessage?: string;
  warnings?: string[];
  requiresFiles?: string[];
  missingFiles?: string[];
  /** Blocking translation errors (unknown variables, missing values, env collisions) */
  translationErrors?: K6TranslationError[];
}

/**
 * Translates a graph to K6 and starts execution on the orchestrator.
 */
export async function runScenario(
  graph: GraphDraftComposition,
  config: RunConfig = {},
): Promise<RunStartResult> {
  const diagnosticMode = config.mode === "diagnostic";
  if (diagnosticMode) {
    try {
      graph = cloneDiagnosticInput(graph);
      config = cloneDiagnosticInput(config);
    } catch {
      return { success: false, error: "Unsupported diagnostic input" };
    }
    config.vus = 1;
    config.durationMs = 30000;
  }
  const {
    vus = 1,
    durationMs = 30000,
    attachments = [],
    scenarioId,
    scenarioName,
    environmentId,
  } = config;
  const defaults = computeRunResources(vus);
  const cpuMillis = config.cpuMillis ?? defaults.cpuMillis;
  const memoryMiB = config.memoryMiB ?? defaults.memoryMiB;

  // Masked variable sets: secrets have no value here and become __ENV refs.
  const loaded = await loadRunVariables({ scenarioId, environmentId });
  if (!loaded.ok) {
    return { success: false, error: loaded.error };
  }

  // Translate graph to K6 script
  const translatorOptions: K6TranslatorOptions = {
    vus,
    duration: `${Math.floor(durationMs / 1000)}s`,
    variables: loaded.variables,
    ...(diagnosticMode && { mode: "diagnostic" as const }),
  };

  const translation = translateToK6(graph, translatorOptions);

  if (translation.errors.length > 0) {
    return {
      success: false,
      error: formatTranslationErrors(translation.errors),
      translationErrors: translation.errors,
      warnings: translation.warnings,
    };
  }

  let prepared: ReturnType<typeof prepareDiagnosticDisplay> | undefined;
  if (diagnosticMode) {
    try {
      prepared = prepareDiagnosticDisplay(graph, translation.diagnostic);
    } catch {
      return { success: false, error: "Diagnostic metadata mismatch" };
    }
  }

  // Check for required files (CSV pools)
  if (translation.requiresFiles.length > 0) {
    // Find which required files are provided
    const providedIds = new Set(attachments.map((a) => a.id));
    const missingFiles = translation.requiresFiles.filter((f) => {
      // Required file is "test-users.csv", attachment id is "test-users"
      const id = f.replace(/\.csv$/, "");
      return !providedIds.has(id);
    });

    if (missingFiles.length > 0) {
      return {
        success: false,
        error: `Missing required files: ${missingFiles.join(", ")}`,
        requiresFiles: translation.requiresFiles,
        missingFiles,
        warnings: translation.warnings,
      };
    }
  }

  // Build orchestrator request
  // Note: The orchestrator needs to support receiving attachment data
  // and writing files to the K6 container. Currently it only accepts IDs.
  const body = {
    version: 1,
    ...(prepared && { mode: "diagnostic", diagnostic: prepared.diagnostic }),
    script: translation.script,
    vus,
    durationMs,
    cpuMillis,
    memoryMiB,
    attachments: attachments.map((a) => ({ id: a.id })),
    // History tracking (not sent to orchestrator, only used by proxy)
    scenarioId,
    scenarioName,
    // Variables: the proxy resolves secret values server-side for these env
    // names; the browser never sends or sees secret values.
    environmentId,
    requiredEnv: translation.requiredEnv,
  };

  try {
    const res = await fetch(`${ORCHESTRATOR_API}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errorBody = await res.text();
      const parsed = parseStartErrorBody(errorBody);
      if (parsed) {
        return {
          success: false,
          error: describeStartError(parsed.code, parsed.message).text,
          errorCode: parsed.code,
          errorMessage: parsed.message,
          warnings: translation.warnings,
        };
      }
      const proxyError = parseProxyRunError(errorBody);
      if (proxyError) {
        return { success: false, error: proxyError, warnings: translation.warnings };
      }
      return {
        success: false,
        error: `Orchestrator error: ${res.status} ${errorBody}`,
        warnings: translation.warnings,
      };
    }

    const result = await res.json();
    if (
      prepared &&
      (typeof result?.runId !== "string" || !result.runId || result.runId.length > 128)
    ) {
      return { success: false, error: "Invalid diagnostic start response" };
    }
    return {
      ...prepared,
      success: true,
      runId: result.runId,
      warnings: translation.warnings,
    };
  } catch (err) {
    return {
      success: false,
      error: `Network error: ${err instanceof Error ? err.message : "Unknown error"}`,
      warnings: translation.warnings,
    };
  }
}

/**
 * Get the WebSocket URL for live metrics of a run.
 * TODO: WebSocket proxy needed for Docker deployment
 */
export function getMetricsWebSocketUrl(runId: string): string {
  // In development, connect directly to orchestrator
  // In Docker, this needs a WebSocket proxy (not yet implemented)
  const orchestratorWs = process.env.NEXT_PUBLIC_ORCHESTRATOR_WS_URL ?? "ws://localhost:8080";
  return `${orchestratorWs}/runs/${runId}/metrics`;
}

/**
 * Check if orchestrator is available.
 */
export async function checkOrchestratorHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${ORCHESTRATOR_API}/healthz`, {
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
