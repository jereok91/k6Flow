"use client";

// K6F4-06: React hook for scenario loading and saving.
// Bridges the React Flow editor state with the scenario REST API.

import { useState, useCallback } from "react";
import {
  toReactFlowGraph,
  fromReactFlowGraph,
  type K6Node,
  type K6Edge,
} from "./mapping";

interface Scenario {
  id: number;
  name: string;
  graph: { nodes: unknown[]; edges: unknown[] };
}

interface UseScenarioResult {
  scenarioId: number | null;
  scenarioName: string;
  loading: boolean;
  saving: boolean;
  error: string | null;
  loadScenario: (id: number) => Promise<{ nodes: K6Node[]; edges: K6Edge[] } | null>;
  saveScenario: (
    name: string,
    nodes: K6Node[],
    edges: K6Edge[],
  ) => Promise<{ id: number } | null>;
  updateScenario: (
    id: number,
    name: string,
    nodes: K6Node[],
    edges: K6Edge[],
  ) => Promise<boolean>;
  clearScenario: () => void;
}

export function useScenario(): UseScenarioResult {
  const [scenarioId, setScenarioId] = useState<number | null>(null);
  const [scenarioName, setScenarioName] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadScenario = useCallback(async (id: number) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/scenarios/${id}`);
      if (!res.ok) {
        if (res.status === 404) {
          setError("Scenario not found");
        } else if (res.status === 403) {
          setError("Access denied");
        } else {
          setError("Failed to load scenario");
        }
        return null;
      }
      const scenario: Scenario = await res.json();
      setScenarioId(scenario.id);
      setScenarioName(scenario.name);

      // Convert stored graph to React Flow format
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { nodes, edges } = toReactFlowGraph(scenario.graph as any);
      return { nodes, edges };
    } catch {
      setError("Network error");
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const saveScenario = useCallback(
    async (name: string, nodes: K6Node[], edges: K6Edge[]) => {
      setSaving(true);
      setError(null);
      try {
        // Convert React Flow state to storage format
        const graph = fromReactFlowGraph(nodes, edges);

        const res = await fetch("/api/scenarios", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, graph }),
        });

        if (!res.ok) {
          if (res.status === 422) {
            setError("Invalid scenario graph");
          } else if (res.status === 401) {
            setError("Please log in to save");
          } else {
            setError("Failed to save scenario");
          }
          return null;
        }

        const created: { id: number } = await res.json();
        setScenarioId(created.id);
        setScenarioName(name);
        return created;
      } catch {
        setError("Network error");
        return null;
      } finally {
        setSaving(false);
      }
    },
    [],
  );

  const updateScenario = useCallback(
    async (id: number, name: string, nodes: K6Node[], edges: K6Edge[]) => {
      setSaving(true);
      setError(null);
      try {
        const graph = fromReactFlowGraph(nodes, edges);

        const res = await fetch(`/api/scenarios/${id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, graph }),
        });

        if (!res.ok) {
          if (res.status === 422) {
            setError("Invalid scenario graph");
          } else if (res.status === 404) {
            setError("Scenario not found");
          } else if (res.status === 403) {
            setError("Access denied");
          } else {
            setError("Failed to update scenario");
          }
          return false;
        }

        setScenarioName(name);
        return true;
      } catch {
        setError("Network error");
        return false;
      } finally {
        setSaving(false);
      }
    },
    [],
  );

  const clearScenario = useCallback(() => {
    setScenarioId(null);
    setScenarioName("");
    setError(null);
  }, []);

  return {
    scenarioId,
    scenarioName,
    loading,
    saving,
    error,
    loadScenario,
    saveScenario,
    updateScenario,
    clearScenario,
  };
}
