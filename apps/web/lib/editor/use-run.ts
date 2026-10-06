"use client";

/**
 * K6F5-03: React hook for running scenarios.
 */

import { useState, useCallback } from "react";
import { runScenario, checkOrchestratorHealth, type RunConfig, type RunStartResult } from "./run-scenario";
import { fromReactFlowGraph, type K6Node, type K6Edge } from "./mapping";

export interface UseRunConfig extends RunConfig {
  /** Scenario ID for history tracking */
  scenarioId?: string;
  /** Scenario name for history tracking */
  scenarioName?: string;
}

interface UseRunResult {
  running: boolean;
  runId: string | null;
  error: string | null;
  warnings: string[];
  orchestratorAvailable: boolean | null;
  checkOrchestrator: () => Promise<void>;
  startRun: (nodes: K6Node[], edges: K6Edge[], config?: UseRunConfig) => Promise<RunStartResult>;
  clearRun: () => void;
}

export function useRun(): UseRunResult {
  const [running, setRunning] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [orchestratorAvailable, setOrchestratorAvailable] = useState<boolean | null>(null);

  const checkOrchestrator = useCallback(async () => {
    const available = await checkOrchestratorHealth();
    setOrchestratorAvailable(available);
  }, []);

  const startRun = useCallback(
    async (nodes: K6Node[], edges: K6Edge[], config?: RunConfig): Promise<RunStartResult> => {
      setRunning(true);
      setError(null);
      setWarnings([]);
      setRunId(null);

      try {
        // Convert React Flow state to graph composition
        const graph = fromReactFlowGraph(nodes, edges);

        // Run the scenario
        const result = await runScenario(graph, config);

        if (result.success && result.runId) {
          setRunId(result.runId);
        } else if (result.error) {
          setError(result.error);
        }

        if (result.warnings) {
          setWarnings(result.warnings);
        }

        return result;
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : "Unknown error";
        setError(errorMessage);
        return { success: false, error: errorMessage };
      } finally {
        setRunning(false);
      }
    },
    [],
  );

  const clearRun = useCallback(() => {
    setRunId(null);
    setError(null);
    setWarnings([]);
  }, []);

  return {
    running,
    runId,
    error,
    warnings,
    orchestratorAvailable,
    checkOrchestrator,
    startRun,
    clearRun,
  };
}
