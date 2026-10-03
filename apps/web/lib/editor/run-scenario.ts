/**
 * K6F5-02: Run scenario service.
 *
 * Translates graph to K6 script and submits to the orchestrator.
 */

import { translateToK6, type K6TranslatorOptions } from "@k6flow/shared";
import type { GraphDraftComposition } from "@k6flow/shared";

const ORCHESTRATOR_URL = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL ?? "http://localhost:8080";

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
  } = config;

  // Translate graph to K6 script
  const translatorOptions: K6TranslatorOptions = {
    vus,
    duration: `${Math.floor(durationMs / 1000)}s`,
  };

  const translation = translateToK6(graph, translatorOptions);

  // Check for required files (CSV pools)
  if (translation.requiresFiles.length > 0) {
    return {
      success: false,
      error: `Scenario requires external files: ${translation.requiresFiles.join(", ")}`,
      requiresFiles: translation.requiresFiles,
      warnings: translation.warnings,
    };
  }

  // Build orchestrator request
  const body = {
    version: 1,
    script: translation.script,
    vus,
    durationMs,
    cpuMillis,
    memoryMiB,
    attachments: [],
  };

  try {
    const res = await fetch(`${ORCHESTRATOR_URL}/runs`, {
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
      runId: result.id,
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
 */
export function getMetricsWebSocketUrl(runId: string): string {
  const wsUrl = ORCHESTRATOR_URL.replace(/^http/, "ws");
  return `${wsUrl}/runs/${runId}/metrics`;
}

/**
 * Check if orchestrator is available.
 */
export async function checkOrchestratorHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${ORCHESTRATOR_URL}/healthz`, {
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
