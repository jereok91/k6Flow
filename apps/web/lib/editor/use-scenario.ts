"use client";

import { useState, useCallback, useRef, useLayoutEffect } from "react";
import { AsyncLifetime } from "./async-lifetime";
import { toReactFlowGraph, fromReactFlowGraph, type K6Node, type K6Edge } from "./mapping";

export type SaveResult = { kind: "saved"; id: string | number } | { kind: "error"; error: string } | { kind: "busy" | "stale" };
interface Scenario {
  id: string | number;
  name: string;
  graph: Parameters<typeof toReactFlowGraph>[0];
  vus?: number;
  durationSeconds?: number;
}

export function useScenario() {
  const [scenarioId, setScenarioId] = useState<string | number | null>(null);
  const [scenarioName, setScenarioName] = useState("");
  const [vus, setVus] = useState(1);
  const [durationSeconds, setDurationSeconds] = useState(30);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lifetime = useRef(new AsyncLifetime());
  const inFlight = useRef(false);
  useLayoutEffect(() => {
    const session = lifetime.current;
    session.mount();
    inFlight.current = false;
    setSaving(false);
    return () => session.unmount();
  }, []);

  const loadScenario = useCallback(async (id: string | number) => {
    const session = lifetime.current;
    if (!session.isCurrent(session.capture())) return null;
    session.invalidate();
    const epoch = session.capture();
    inFlight.current = false;
    setSaving(false);
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/scenarios/${id}`);
      if (!res.ok) throw new Error(res.status === 404 ? "Escenario no encontrado" : "No se pudo cargar el escenario");
      const scenario: Scenario = await res.json();
      if (!session.isCurrent(epoch)) return null;
      const graph = toReactFlowGraph(scenario.graph);
      setScenarioId(scenario.id);
      setScenarioName(scenario.name);
      setVus(scenario.vus ?? 1);
      setDurationSeconds(scenario.durationSeconds ?? 30);
      return { ...graph, name: scenario.name, vus: scenario.vus ?? 1, durationSeconds: scenario.durationSeconds ?? 30 };
    } catch (cause) {
      if (session.isCurrent(epoch)) setError(cause instanceof Error ? cause.message : "Error de red");
      return null;
    } finally {
      if (session.isCurrent(epoch)) setLoading(false);
    }
  }, []);

  const persistScenario = useCallback(async (
    id: string | number | null, name: string, nodes: K6Node[], edges: K6Edge[], vusValue?: number, durationValue?: number,
  ): Promise<SaveResult> => {
    const session = lifetime.current;
    const epoch = session.capture();
    if (!session.isCurrent(epoch)) return { kind: "stale" };
    if (inFlight.current) return { kind: "busy" };
    inFlight.current = true;
    setSaving(true);
    setError(null);
    try {
      // Serialize before awaiting: later editor changes belong to the next save.
      const body = JSON.stringify({ name, graph: fromReactFlowGraph(nodes, edges), vus: vusValue, durationSeconds: durationValue });
      const res = await fetch(id === null ? "/api/scenarios" : `/api/scenarios/${id}`, {
        method: id === null ? "POST" : "PUT", headers: { "Content-Type": "application/json" }, body,
      });
      if (!res.ok) throw new Error(res.status === 422 ? "El gráfico del escenario no es válido" : res.status === 401 ? "Inicia sesión para guardar" : "No se pudo guardar el escenario");
      const savedId = id ?? ((await res.json()) as { id: string | number }).id;
      if (!session.isCurrent(epoch)) return { kind: "stale" };
      setScenarioId(savedId);
      setScenarioName(name);
      return { kind: "saved", id: savedId };
    } catch (cause) {
      if (!session.isCurrent(epoch)) return { kind: "stale" };
      const message = cause instanceof Error ? cause.message : "Error de red";
      setError(message);
      return { kind: "error", error: message };
    } finally {
      if (session.isCurrent(epoch)) {
        inFlight.current = false;
        setSaving(false);
      }
    }
  }, []);

  // Preserve existing callers' return contracts; editor uses operation-local results.
  const saveScenario = useCallback(async (name: string, nodes: K6Node[], edges: K6Edge[], vus?: number, duration?: number) => {
    const session = lifetime.current;
    const ticket = session.capture();
    const result = await persistScenario(null, name, nodes, edges, vus, duration);
    return session.isCurrent(ticket) && result.kind === "saved" ? { id: result.id } : null;
  }, [persistScenario]);
  const updateScenario = useCallback(async (id: string | number, name: string, nodes: K6Node[], edges: K6Edge[], vus?: number, duration?: number) => {
    const session = lifetime.current;
    const ticket = session.capture();
    const result = await persistScenario(id, name, nodes, edges, vus, duration);
    return session.isCurrent(ticket) && result.kind === "saved";
  }, [persistScenario]);
  const clearScenario = useCallback(() => {
    const session = lifetime.current;
    if (!session.isCurrent(session.capture())) return;
    session.invalidate();
    inFlight.current = false;
    setSaving(false);
    setScenarioId(null);
    setScenarioName("");
    setVus(1);
    setDurationSeconds(30);
    setLoading(false);
    setError(null);
  }, []);
  return { scenarioId, scenarioName, vus, durationSeconds, loading, saving, error, loadScenario, saveScenario, updateScenario, persistScenario, clearScenario };
}
