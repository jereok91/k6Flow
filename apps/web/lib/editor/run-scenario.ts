/**
 * K6F5-02 + K6F6-04: Run scenario service.
 *
 * Translates graph to K6 script and submits to the orchestrator.
 */

import { translateToK6, type K6TranslatorOptions } from "@k6flow/shared";
import type { GraphDraftComposition } from "@k6flow/shared";

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
  /** Virtual users */
  vus?: number;
  /** Duration in milliseconds */
  durationMs?: number;
  /** CPU limit in millicores */
  cpuMillis?: number;
  /** Memory limit in MiB */
  memoryMiB?: number;
  /** Attachments (CSV files) to include */
  attachments?: RunAttachment[];
  /** Scenario ID for history tracking */
  scenarioId?: string;
  /** Scenario name for history tracking */
  scenarioName?: string;
}

/**
 * Result of starting a run.
 */
export interface RunStartResult {
  success: boolean;
  runId?: string;
  error?: string;
  warnings?: string[];
  requiresFiles?: string[];
  missingFiles?: string[];
}

/**
 * Translates a graph to K6 and starts execution on the orchestrator.
 */
export async function runScenario(
  graph: GraphDraftComposition,
  config: RunConfig = {},
): Promise<RunStartResult> {
  const {
    vus = 1,
    durationMs = 30000,
    cpuMillis = 500,
    memoryMiB = 256,
    attachments = [],
    scenarioId,
    scenarioName,
  } = config;

  // Translate graph to K6 script
  const translatorOptions: K6TranslatorOptions = {
    vus,
    duration: `${Math.floor(durationMs / 1000)}s`,
  };

  const translation = translateToK6(graph, translatorOptions);

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
    script: translation.script,
    vus,
    durationMs,
    cpuMillis,
    memoryMiB,
    attachments: attachments.map((a) => ({ id: a.id })),
    // History tracking (not sent to orchestrator, only used by proxy)
    scenarioId,
    scenarioName,
  };

  try {
    const res = await fetch(`${ORCHESTRATOR_API}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errorBody = await res.text();
      return {
        success: false,
        error: `Orchestrator error: ${res.status} ${errorBody}`,
        warnings: translation.warnings,
      };
    }

    const result = await res.json();
    return {
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
