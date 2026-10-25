"use client";

// K6F4-05b/c/06 + K6F5-03: Visual scenario editor page with save/load/run functionality.
// K6F8-04: Import from recorder support.
// Authenticated users only.

import { Suspense, useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from "react";
import { snapshot, SaveBaseline, durationSeconds as parseDurationToSeconds } from "../../lib/editor/save-state";
import { useToast } from "../../lib/notifications/ToastProvider";
import { AsyncLifetime } from "../../lib/editor/async-lifetime";
import { useSessionGuard } from "../../lib/auth/use-session-guard";
import { sessionViewFor, shouldWipeEditor, type SessionView } from "../../lib/auth/session-guard";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  capturesToGraph,
  generateConnections,
  detectAuth,
  detectDynamicValues,
  type RecorderCaptureEntry,
} from "@k6flow/shared";
import { parameterReferences, renameNode, toggleDisabled } from "../../lib/editor/node-interactions";
import {
  FlowEditor,
  HttpRequestConfigPanel,
  AuthenticationConfigPanel,
  ResponseValidationConfigPanel,
  UserPoolConfigPanel,
  ConnectionConfigPanel,
  formatWaitLabel,
  ScriptPanel,
  RunExecutionPanel,
  RunHistoryPanel,
  type RunHistoryEntry,
  toHistoryStatus,
  type K6NodeType,
  type K6Edge,
  type K6NodeData,
  // T6 U5: endpoint-test client surface, imported through the editor barrel.
  runEndpointTest,
  createEndpointTestLastResults,
} from "../../lib/editor";
import { useScenario } from "../../lib/editor/use-scenario";
import { resolveEditorRunId, resolveEditorScenarioId } from "../../lib/editor/editor-route-params";
import { useRun } from "../../lib/editor/use-run";
import { useDiagnosticPage } from "../../lib/editor/use-diagnostic-page";
import { statusPatchBody, type HistoryStatus, type LaunchToken } from "../../lib/editor/diagnostic-page-controller";
import { DiagnosticExecutionPanel } from "../../lib/editor/DiagnosticExecutionPanel";
import { runScenario } from "../../lib/editor/run-scenario";
import { fromReactFlowGraph } from "../../lib/editor/mapping";
import { isSessionMarker, withSessionMarker } from "../../lib/auth/session-marker-header";
import {
  VariablesPanel,
  EnvironmentSelector,
  collectGraphVariables,
  mergedVariableNames,
  useEnvironments,
  useEnvironmentVariables,
  useScenarioVariables,
  useSelectedEnvironment,
} from "../../lib/variables";

interface AuthState {
  loading: boolean;
  authenticated: boolean;
  error?: string;
}

// Existing auth views for each settled session view (mapping in sessionViewFor).
function authStateFor(view: Exclude<SessionView, "locked">): AuthState {
  if (view === "authenticated") return { loading: false, authenticated: true };
  if (view === "login") {
    return { loading: false, authenticated: false, error: "Inicia sesión para usar el editor" };
  }
  return { loading: false, authenticated: false, error: "Error de autenticación" };
}

interface AttachmentInfo {
  id: string;
  name: string;
  contentType: string;
  size: number;
  createdAt: string;
}

function NodeMetadataInspector({ node, onRename, onToggle }: {
  node: K6NodeType;
  onRename: (name: string) => string | undefined;
  onToggle: () => void;
}) {
  const [name, setName] = useState(node.data.label);
  const [error, setError] = useState<string | undefined>();
  return <section style={{ padding: 16, background: "var(--color-surface-container-low)",
    border: "1px solid var(--color-surface-container-high)", borderRadius: 12 }}>
    <form onSubmit={event => {
      event.preventDefault();
      const failure = onRename(name);
      setError(failure);
      if (!failure) setName(name.trim());
    }}>
      <label htmlFor="node-name">Nombre del nodo</label>
      <input id="node-name" value={name} maxLength={120} aria-invalid={!!error}
        aria-describedby={error ? "node-name-error" : undefined}
        onChange={event => { setName(event.target.value); setError(undefined); }}
        className="w-full rounded border p-2 my-2" />
      <button type="submit" className="btn-secondary">Renombrar</button>
      {error && <p id="node-name-error" role="alert">{error}</p>}
    </form>
    <label style={{ display: "flex", gap: 8, marginTop: 12 }}>
      <input type="checkbox" checked={!!node.data.disabled} onChange={onToggle} />
      Desactivar nodo
    </label>
  </section>;
}

function EditorPage() {
  const [auth, setAuth] = useState<AuthState>({ loading: true, authenticated: false });
  // User that established the editor: latched on verification so URL/import loads run
  // once per session instead of re-running (and overwriting edits) after a re-check.
  // Reset to null (or replaced) when the session is lost or another user verifies.
  const [establishedUserId, setEstablishedUserId] = useState<string | null>(null);
  const sessionEstablished = establishedUserId !== null;
  const [environmentsStale, setEnvironmentsStale] = useState(false);
  const [nodes, setNodes] = useState<K6NodeType[]>([]);
  const [edges, setEdges] = useState<K6Edge[]>([]);
  const [flowGeneration, setFlowGeneration] = useState(0);
  const replaceFlow = useCallback(() => {
    setFlowGeneration(value => value + 1);
    setSelectedNodeId(null);
    // A replaced graph can reuse node ids from another scenario; never show its results here.
    endpointTestResults.current.clear();
  }, []);
  // Store only the selected id and derive the node from `nodes` during render. A copied
  // node synced in an effect reached the config panel one commit late, so React reverted
  // the controlled field to the stale value and the caret jumped to the end on each key.
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [scenarioNameInput, setScenarioNameInput] = useState("");
  const [attachments, setAttachments] = useState<AttachmentInfo[]>([]);
  const [importedCaptures, setImportedCaptures] = useState<RecorderCaptureEntry[] | null>(null);
  const [importAnalysis, setImportAnalysis] = useState<{
    authSignals: number;
    dynamicValues: number;
  } | null>(null);
  const [showRunConfirmation, setShowRunConfirmation] = useState(false);
  const [runConfirmationKind, setRunConfirmationKind] = useState<"load" | "diagnostic">("load");
  const [runTargets, setRunTargets] = useState<string[]>([]);
  const [showScriptPanel, setShowScriptPanel] = useState(false);
  const [editorVus, setEditorVus] = useState(1);
  const [editorDuration, setEditorDuration] = useState("30s");
  const [showExecutionPanel, setShowExecutionPanel] = useState(false);
  const [showHistoryPanel, setShowHistoryPanel] = useState(false);
  const [showVariablesPanel, setShowVariablesPanel] = useState(false);
  const [runHistory, setRunHistory] = useState<RunHistoryEntry[]>([]);
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);

  const scenario = useScenario();
  const notify = useToast();
  const baseline = useRef(new SaveBaseline(snapshot("", [], [], 1, "30s")));
  const [, refreshBaseline] = useState(0);
  const saveInFlight = useRef(false);
  const lifetime = useRef(new AsyncLifetime());
  const flowLifetime = useRef(new AsyncLifetime());
  // T6 U5: one memory-only endpoint-test result per node id, plus a render tick so a
  // finished test becomes visible. Samples and results are never persisted or logged.
  const endpointTestResults = useRef(createEndpointTestLastResults());
  // Bumped by every protected-data clear so a late result cannot repopulate the store.
  const endpointTestGeneration = useRef(0);
  const [, refreshEndpointTestResults] = useState(0);
  const endpointTestLatch = useRef(false);
  const [endpointTestInFlight, setEndpointTestInFlight] = useState(false);
  useLayoutEffect(() => {
    const session = lifetime.current;
    const flowSession = flowLifetime.current;
    session.mount();
    flowSession.mount();
    saveInFlight.current = false;
    return () => { session.unmount(); flowSession.unmount(); };
  }, []);
  const invalidateContinuations = useCallback(() => {
    flowLifetime.current.invalidate();
    saveInFlight.current = false;
  }, []);
  const currentSnapshot = snapshot(scenario.scenarioName || scenarioNameInput.trim(), nodes, edges, editorVus, editorDuration);
  const dirty = baseline.current.dirty(currentSnapshot);
  const run = useRun();
  // k6flow-variables V-T4: environments, selected environment and variable sets.
  const environments = useEnvironments();
  const environmentSelection = useSelectedEnvironment(
    environments.environments,
    environments.loaded && environments.error === null,
  );
  const selectedEnvironment =
    environments.environments.find((env) => env.id === environmentSelection.selectedId) ?? null;
  const scenarioVariables = useScenarioVariables(scenario.scenarioId);
  const environmentVariables = useEnvironmentVariables(selectedEnvironment?.id ?? null);
  const usedVariableNames = useMemo(() => collectGraphVariables(nodes), [nodes]);
  const definedVariableNames = useMemo(
    () => mergedVariableNames(environmentVariables.variables, scenarioVariables.variables),
    [environmentVariables.variables, scenarioVariables.variables],
  );
  const undefinedVariableCount = useMemo(() => {
    const defined = new Set(definedVariableNames);
    return usedVariableNames.filter((name) => !defined.has(name)).length;
  }, [definedVariableNames, usedVariableNames]);
  const router = useRouter();
  const searchParams = useSearchParams();

  const selectedNode = useMemo(
    () => (selectedNodeId === null ? null : nodes.find((n) => n.id === selectedNodeId) ?? null),
    [nodes, selectedNodeId],
  );
  const selectNode = useCallback((node: K6NodeType | null) => {
    setSelectedNodeId(node?.id ?? null);
    // Only one inspector at a time: a stale edge id would keep the wrong panel alive.
    if (node) setSelectedEdgeId(null);
  }, []);

  const selectEdge = useCallback((edge: K6Edge | null) => {
    setSelectedEdgeId(edge?.id ?? null);
  }, []);

  const selectedEdge = useMemo(
    () => edges.find((edge) => edge.id === selectedEdgeId) ?? null,
    [edges, selectedEdgeId],
  );

  const nodeLabel = useCallback(
    (id: string) => nodes.find((node) => node.id === id)?.data.label ?? id,
    [nodes],
  );

  // The wait belongs to the connection, so editing it rewrites that edge only.
  const updateEdgeWait = useCallback((edgeId: string, waitSeconds: number | undefined) => {
    setEdges((current) => current.map((edge) => (edge.id === edgeId
      ? { ...edge, data: waitSeconds === undefined ? undefined : { waitSeconds }, label: formatWaitLabel(waitSeconds) }
      : edge)));
  }, []);

  // Check orchestrator on mount
  useEffect(() => {
    run.checkOrchestrator();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Load run history for each established session
  useEffect(() => {
    if (!sessionEstablished) return;
    const session = lifetime.current;
    const ticket = session.capture();
    let sameUser = true; // a wipe or user change drops this user's in-flight history
    const loadHistory = async () => {
      try {
        const res = await fetch("/api/runs?limit=20");
        if (res.ok) {
          const data = await res.json();
          if (!sameUser || !session.isCurrent(ticket)) return;
          setRunHistory(data.runs.map((r: any) => ({
            runId: r.runId,
            scenarioName: r.scenarioName,
            startedAt: new Date(r.startedAt),
            completedAt: r.completedAt ? new Date(r.completedAt) : undefined,
            status: r.status,
            vus: r.vus,
            duration: r.durationMs ? `${Math.floor(r.durationMs / 1000)}s` : undefined,
            iterations: r.iterations,
            avgDuration: r.avgDurationMs,
            errorRate: r.errorRate,
          })));
        }
      } catch {
        // Silently fail - history is not critical
      }
    };
    loadHistory();
    return () => { sameUser = false; };
  }, [establishedUserId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Guarded session: verifies on mount and re-verifies on invalidation, focus and
  // visibility. Each invalidation locks the editor synchronously (no graph wipe, it
  // runs on every focus); losing the session or changing user wipes it below.
  const lockedRef = useRef(false);
  // Diagnostic context follows privacy_first_clear: every invalidation erases it
  // synchronously and drops the marker until the session verifies again.
  const markerRef = useRef<string | null>(null);
  const diagnosticRef = useRef<ReturnType<typeof useDiagnosticPage>["controller"]>(null);
  // The run a URL asked the editor to open, with the controller that opened it: a
  // StrictMode remount gets a new controller and must re-open the run, a re-render must not.
  const openedUrlRunRef = useRef<{ controller: ReturnType<typeof useDiagnosticPage>["controller"]; runId: string } | null>(null);
  const clearProtectedSessionData = useCallback(() => {
    lockedRef.current = true;
    markerRef.current = null;
    diagnosticRef.current?.clearForSession();
    endpointTestResults.current.clear();
    endpointTestGeneration.current += 1;
  }, []);
  const session = useSessionGuard(clearProtectedSessionData);
  const wipePending = shouldWipeEditor(session, establishedUserId);
  const locked = sessionViewFor(session, sessionEstablished) === "locked" || wipePending;
  lockedRef.current = locked;
  const sessionMarker = !locked && session.phase === "verified" ? session.identity.sessionMarker : null;
  markerRef.current = sessionMarker;
  const diagnostic = useDiagnosticPage({
    getMarker: () => markerRef.current,
    reconcile: (runId, status) => { void reconcileDiagnostic(runId, status); },
  });
  diagnosticRef.current = diagnostic.controller;
  const diagnosticSelection = diagnostic.state.selection;
  const runBusy = diagnostic.state.busy !== null;
  const loadTokenRef = useRef<LaunchToken | null>(null);
  const releaseLoad = () => {
    const token = loadTokenRef.current;
    loadTokenRef.current = null;
    if (token) diagnostic.controller?.release(token);
  };
  const diagnosticObserverOptions = useMemo(
    () => (sessionMarker && isSessionMarker(sessionMarker)
      ? { fetch: withSessionMarker((url, init) => window.fetch(url, init), sessionMarker) }
      : undefined),
    [sessionMarker],
  );
  // A history run confirmed as load opens the existing load view.
  useEffect(() => {
    if (diagnosticSelection.kind !== "load") return;
    setCurrentRunId(diagnosticSelection.runId);
    setShowExecutionPanel(true);
    diagnostic.controller?.close();
  }, [diagnosticSelection]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (wipePending) wipeEditor();
    const view = sessionViewFor(session, sessionEstablished && !wipePending);
    if (view && view !== "locked") setAuth(authStateFor(view));
    if (session.phase === "verified") setEstablishedUserId(session.identity.userId);
    else if (wipePending) setEstablishedUserId(null);
  }, [session, establishedUserId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (establishedUserId && environmentsStale) { setEnvironmentsStale(false); void environments.reload(); }
  }, [establishedUserId, environmentsStale]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load scenario from URL params on mount
  useEffect(() => {
    if (!sessionEstablished) return;
    // Scenario ids are opaque text ids (UUIDs): never parsed as numbers, or a
    // non-numeric id silently opens an empty editor.
    const scenarioId = resolveEditorScenarioId(new URLSearchParams(window.location.search));

    if (scenarioId !== null) {
      invalidateContinuations();
      const session = flowLifetime.current;
      const ticket = session.capture();
      baseline.current.reset(currentSnapshot);
      scenario.loadScenario(scenarioId).then((result) => {
        if (!session.isCurrent(ticket)) return;
        if (result) {
          replaceFlow();
          setNodes(result.nodes);
          setEdges(result.edges);
          setEditorVus(result.vus);
          setEditorDuration(`${result.durationSeconds}s`);
          setScenarioNameInput("");
          baseline.current.reset(snapshot(result.name, result.nodes, result.edges, result.vus, `${result.durationSeconds}s`));
          refreshBaseline(value => value + 1);
        }
      });
      loadAttachments(scenarioId);
    }
  }, [establishedUserId]); // eslint-disable-line react-hooks/exhaustive-deps

  // A run named in the URL opens through the same classification the history panel
  // uses: a confirmed load opens the load view, a diagnostic opens its panel.
  useEffect(() => {
    const controller = diagnostic.controller;
    if (!sessionEstablished || !controller) return;
    const runId = resolveEditorRunId(new URLSearchParams(window.location.search));
    if (runId === null) return;
    const opened = openedUrlRunRef.current;
    if (opened?.controller === controller && opened.runId === runId) return;
    openedUrlRunRef.current = { controller, runId };
    // The live load panel owns the load latch until it completes or closes.
    if (loadTokenRef.current) {
      notify({ type: "error", message: "Esperá a que termine o cerrá la ejecución de carga en curso" });
      return;
    }
    void controller.view(runId);
  }, [establishedUserId, diagnostic.controller]); // eslint-disable-line react-hooks/exhaustive-deps

  // K6F8-04: Process imported captures from recorder
  useEffect(() => {
    if (!sessionEstablished) return;
    const isImport = searchParams.get("import") === "true";
    if (!isImport) return;

    const stored = sessionStorage.getItem("k6flow-import-captures");
    if (!stored) return;

    try {
      const captures: RecorderCaptureEntry[] = JSON.parse(stored);
      setImportedCaptures(captures);

      const authResult = detectAuth(captures);
      const dynamicResult = detectDynamicValues(captures);
      setImportAnalysis({
        authSignals: authResult.signals.length,
        dynamicValues: dynamicResult.values.length,
      });

      const graphNodes = capturesToGraph(captures, { idPrefix: "imported" });
      const graphConnections = generateConnections(graphNodes);

      const nodesWithPositions: K6NodeType[] = graphNodes.map((node, index) => ({
        id: node.id,
        type: "k6Node",
        position: { x: 250, y: 100 + index * 120 },
        data: {
          kind: node.kind,
          label: `${node.parameters.method} ${new URL(node.parameters.url.kind === "literal" ? node.parameters.url.value : "").pathname}`,
          parameters: node.parameters,
          references: parameterReferences(node.kind, node.parameters),
        } as K6NodeData,
      }));

      const edgesFromCaptures: K6Edge[] = graphConnections.map((conn, index) => ({
        id: `import-edge-${index}`,
        source: conn.source,
        target: conn.target,
      }));

      invalidateContinuations();
      scenario.clearScenario();
      setShowSaveDialog(false);
      setScenarioNameInput("");
      setEditorVus(1);
      setEditorDuration("30s");
      baseline.current.reset(snapshot("", [], [], 1, "30s"));
      replaceFlow();
      setNodes(nodesWithPositions);
      setEdges(edgesFromCaptures);
      sessionStorage.removeItem("k6flow-import-captures");
      router.replace("/editor");
    } catch (err) {
      console.error("Failed to import captures:", err);
    }
  }, [establishedUserId, searchParams]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleDismissEndpointTestResult = useCallback(() => {
    if (!selectedNode) return;
    endpointTestResults.current.clear(selectedNode.id);
    refreshEndpointTestResults((value) => value + 1);
  }, [selectedNode]);

  // A deletion removes the node entirely, so its last endpoint-test result must
  // not survive: drop each removed id and re-render the panel away.
  const handleNodesRemoved = useCallback((nodeIds: readonly string[]) => {
    for (const nodeId of nodeIds) endpointTestResults.current.clear(nodeId);
    refreshEndpointTestResults((value) => value + 1);
  }, []);

  const handleRunEndpointTest = useCallback(
    (samples: Readonly<Record<string, string>>) => {
      // Synchronous single-flight latch: a same-tick double click cannot start two tests.
      if (endpointTestLatch.current) return;
      const node = selectedNode;
      const marker = markerRef.current;
      // Refuse without the verified session marker instead of issuing a request the route would 412.
      if (!node || !marker || !isSessionMarker(marker)) return;
      const generation = endpointTestGeneration.current;
      endpointTestLatch.current = true;
      setEndpointTestInFlight(true);
      void (async () => {
        try {
          const result = await runEndpointTest(
            {
              parameters: node.data.parameters,
              samples,
              scenarioId: scenario.scenarioId ? String(scenario.scenarioId) : undefined,
              environmentId: selectedEnvironment?.id,
            },
            { sessionMarker: marker },
          );
          // privacy_first_clear: a result earned before a clear must not repopulate the
          // store, even when the same session re-verifies and yields the same marker.
          if (generation === endpointTestGeneration.current && markerRef.current === marker) {
            endpointTestResults.current.set(node.id, result);
          }
        } finally {
          endpointTestLatch.current = false;
          setEndpointTestInFlight(false);
          refreshEndpointTestResults((value) => value + 1);
        }
      })();
    },
    [selectedNode, scenario.scenarioId, selectedEnvironment?.id],
  );

  const loadAttachments = useCallback(async (scenarioId: string) => {
    const session = flowLifetime.current;
    const ticket = session.capture();
    try {
      const res = await fetch(`/api/scenarios/${scenarioId}/attachments`);
      if (res.ok) {
        const data = await res.json();
        if (!session.isCurrent(ticket)) return;
        setAttachments(data.attachments ?? []);
      }
    } catch {
      // Silently fail
    }
  }, []);

  const uploadFile = useCallback(async (file: File): Promise<AttachmentInfo | null> => {
    const session = flowLifetime.current;
    const ticket = session.capture();
    if (!session.isCurrent(ticket) || !scenario.scenarioId) return null;

    const reader = new FileReader();
    const base64 = await new Promise<string>((resolve, reject) => {
      reader.onload = () => {
        const result = reader.result as string;
        resolve(result.split(",")[1]);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

    if (!session.isCurrent(ticket)) return null;
    const res = await fetch(`/api/scenarios/${scenario.scenarioId}/attachments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: file.name,
        contentType: file.type || "text/csv",
        data: base64,
      }),
    });

    if (!session.isCurrent(ticket)) return null;
    if (!res.ok) {
      const error = await res.json();
      if (!session.isCurrent(ticket)) return null;
      throw new Error(error.error || "Upload failed");
    }

    const data = await res.json();
    if (!session.isCurrent(ticket)) return null;
    setAttachments((prev) => [...prev, data.attachment]);
    return data.attachment;
  }, [scenario.scenarioId]);

  const deleteAttachment = useCallback(async (attachmentId: string): Promise<boolean> => {
    const session = flowLifetime.current;
    const ticket = session.capture();
    if (!session.isCurrent(ticket) || !scenario.scenarioId) return false;

    const res = await fetch(
      `/api/scenarios/${scenario.scenarioId}/attachments/${attachmentId}`,
      { method: "DELETE" },
    );

    if (res.ok && session.isCurrent(ticket)) {
      setAttachments((prev) => prev.filter((a) => a.id !== attachmentId));
      return true;
    }
    return false;
  }, [scenario.scenarioId]);

  const updateNodeParameters = useCallback(
    (nodeId: string, parameters: unknown) => {
      setNodes((current) =>
        current.map((node) => {
          if (node.id !== nodeId) return node;
          
          const references = parameterReferences(node.data.kind, parameters);
          
          return {
            ...node,
            data: { ...node.data, parameters, references } as K6NodeData,
          };
        }),
      );
    },
    [],
  );

  const closeConfigPanel = useCallback(() => {
    setSelectedNodeId(null);
    setNodes((current) => current.map((n) => ({ ...n, selected: false })));
  }, []);

  const save = async (create: boolean) => {
    const session = flowLifetime.current;
    const epoch = session.capture();
    if (lockedRef.current || !session.isCurrent(epoch) || saveInFlight.current || scenario.loading) return;
    const name = create ? scenarioNameInput.trim() : scenario.scenarioName;
    if (create && !name) return;
    saveInFlight.current = true;
    const ticket = baseline.current.submit(snapshot(name, nodes, edges, editorVus, editorDuration));
    try {
      const result = await scenario.persistScenario(create ? null : scenario.scenarioId, name, nodes, edges, editorVus, parseDurationToSeconds(editorDuration));
      // The hook can return before cleanup: recheck at the page boundary too.
      if (!session.isCurrent(epoch)) return;
      if (result.kind === "saved" && baseline.current.accept(ticket)) {
        refreshBaseline(value => value + 1);
        setShowSaveDialog(false);
        setScenarioNameInput("");
        notify({ type: "success", message: "Escenario guardado" });
      } else if (result.kind === "error") {
        notify({ type: "error", message: result.error });
      }
    } finally {
      if (session.isCurrent(epoch)) saveInFlight.current = false;
    }
  };
  const handleSave = () => {
    if (lockedRef.current || saveInFlight.current || scenario.loading) return;
    if (showSaveDialog) return save(true);
    if (scenario.scenarioId === null) { setShowSaveDialog(true); return; }
    return save(false);
  };
  const handleCreateScenario = () => save(true);
  const saveCallback = useRef(handleSave);
  saveCallback.current = handleSave;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      if (!event.repeat && !event.isComposing && auth.authenticated && !lockedRef.current) void saveCallback.current();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [auth.authenticated]);

  const resetEditor = () => {
    invalidateContinuations();
    scenario.clearScenario();
    baseline.current.reset(snapshot("", [], [], 1, "30s"));
    setScenarioNameInput("");
    setShowSaveDialog(false);
    setEditorVus(1);
    setEditorDuration("30s");
    replaceFlow();
    setNodes([]);
    setEdges([]);
    setSelectedNodeId(null);
    setAttachments([]);
    setImportedCaptures(null);
    setImportAnalysis(null);
  };
  const handleNew = () => {
    resetEditor();
    router.replace("/editor");
  };
  // Session lost or user changed: erase identity-scoped data; unsaved edits are lost.
  const wipeEditor = () => {
    resetEditor();
    environmentSelection.setSelectedId(null);
    setEnvironmentsStale(true);
    run.clearRun();
    diagnostic.controller?.clearForSession();
    releaseLoad();
    endpointTestResults.current.clear();
    endpointTestGeneration.current += 1;
    setRunHistory([]);
    setCurrentRunId(null);
    setShowExecutionPanel(false);
    setShowRunConfirmation(false);
    setRunTargets([]);
  };

  const getHttpRequestNodes = () => {
    return nodes
      .filter((n) => n.data.kind === "http-request")
      .map((n) => ({ id: n.id, label: n.data.label || n.id }));
  };

  // Get available outputs from Authentication and User Pool nodes for variable injection
  const getAvailableOutputs = () => {
    const outputs: { nodeId: string; nodeLabel: string; outputName: string }[] = [];
    
    for (const node of nodes) {
      const params = node.data.parameters as Record<string, unknown> | undefined;
      const nodeLabel = node.data.label || node.id;
      
      if (node.data.kind === "authentication" && params?.outputs) {
        const authOutputs = params.outputs as { name: string }[];
        for (const output of authOutputs) {
          outputs.push({ nodeId: node.id, nodeLabel, outputName: output.name });
        }
      } else if (node.data.kind === "user-pool") {
        // Get outputs from explicit outputs or infer from manualUsers
        if (params?.outputs && Array.isArray(params.outputs)) {
          for (const output of params.outputs as { name: string }[]) {
            outputs.push({ nodeId: node.id, nodeLabel, outputName: output.name });
          }
        } else if (params?.manualUsers && Array.isArray(params.manualUsers) && params.manualUsers.length > 0) {
          const firstUser = params.manualUsers[0] as Record<string, unknown>;
          for (const key of Object.keys(firstUser)) {
            outputs.push({ nodeId: node.id, nodeLabel, outputName: key });
          }
        }
      }
    }
    
    return outputs;
  };

  const handleRunClick = (kind: "load" | "diagnostic" = "load") => {
    const targets = nodes
      .filter((n) => n.data.kind === "http-request")
      .map((n) => {
        const params = n.data.parameters as { url?: { kind: string; value: string } };
        if (params?.url?.kind === "literal") {
          try {
            return new URL(params.url.value).origin;
          } catch {
            return params.url.value;
          }
        }
        return "dynamic URL";
      });

    const uniqueTargets = [...new Set(targets)];
    setRunTargets(uniqueTargets);
    setRunConfirmationKind(kind);
    setShowRunConfirmation(true);
  };

  const handleRunConfirmed = async () => {
    const session = flowLifetime.current;
    const ticket = session.capture();
    if (!session.isCurrent(ticket)) return;
    setShowRunConfirmation(false);
    if (nodes.length === 0) {
      return;
    }
    // Shared synchronous latch: a same-tick double confirm or a running diagnostic is refused.
    const token = diagnostic.controller?.acquire("load");
    if (!token) return;
    loadTokenRef.current = token;
    const durationMs = parseDurationToSeconds(editorDuration) * 1000;
    // A rejected start must not strand the shared latch forever: release only our own
    // token (the diagnostic start already guards its rejection the same way).
    let result: Awaited<ReturnType<typeof run.startRun>>;
    try {
      result = await run.startRun(nodes, edges, {
        scenarioId: scenario.scenarioId ? String(scenario.scenarioId) : undefined,
        scenarioName: scenario.scenarioName || "Sin nombre",
        vus: editorVus,
        durationMs,
        environmentId: selectedEnvironment?.id,
      });
    } catch {
      if (loadTokenRef.current === token) releaseLoad();
      return;
    }
    if (!session.isCurrent(ticket) || !(result.success && result.runId)) {
      if (loadTokenRef.current === token) releaseLoad();
      return;
    }
    if (result.success && result.runId) {
      setCurrentRunId(result.runId);
      setShowExecutionPanel(true);
      setShowScriptPanel(false);
      
      // Add to history
      const newEntry: RunHistoryEntry = {
        runId: result.runId,
        scenarioName: scenario.scenarioName || "Sin nombre",
        startedAt: new Date(),
        status: "running",
        vus: editorVus,
        duration: editorDuration,
        iterations: 0,
      };
      setRunHistory(prev => [newEntry, ...prev]);
    }
  };

  const handleDiagnosticConfirmed = async () => {
    const flow = flowLifetime.current;
    const ticket = flow.capture();
    setShowRunConfirmation(false);
    const controller = diagnostic.controller;
    const marker = markerRef.current;
    if (!controller || nodes.length === 0 || !isSessionMarker(marker)) return;
    const token = controller.acquire("diagnostic");
    if (!token) return;
    const scenarioName = scenario.scenarioName || "Sin nombre";
    let result: Awaited<ReturnType<typeof runScenario>>;
    try {
      result = await runScenario(fromReactFlowGraph(nodes, edges), {
        mode: "diagnostic",
        sessionMarker: marker,
        scenarioId: scenario.scenarioId ? String(scenario.scenarioId) : undefined,
        scenarioName,
        environmentId: selectedEnvironment?.id,
      });
    } catch {
      result = { success: false, error: "No se pudo iniciar el diagnóstico" };
    }
    if (!result.success || !result.runId) {
      controller.release(token);
      if (flow.isCurrent(ticket)) {
        // Fixed messages only: never echo orchestrator or proxy text.
        notify({ type: "error", message: result.sessionChanged
          ? "La sesión cambió; verificá la sesión e intentá de nuevo"
          : "No se pudo iniciar el diagnóstico" });
      }
      return;
    }
    // From here the latch belongs to the run: only its terminal, watcher or a session clear frees it.
    if (!flow.isCurrent(ticket) || !controller.openLaunched(token, result.runId, result.executionDisplay)) {
      controller.release(token);
      return;
    }
    setShowHistoryPanel(false);
    setRunHistory(prev => [{
      runId: result.runId!,
      scenarioName,
      startedAt: new Date(),
      status: "running",
      vus: 1,
      duration: "30s",
      iterations: 0,
    }, ...prev]);
  };

  // Status-only reconciliation: diagnostics have no load metrics to persist.
  // The PATCH stays cookie + run-ownership authenticated, exactly like the load
  // completion write to the same PATCH /api/runs/[runId] route: that route never
  // validates the diagnostic session marker, so sending one would be a cosmetic
  // header rather than a binding. privacy_first_clear already prevents this from
  // running for an erased session, because clearForSession disposes the watcher
  // and clears the selection before any reconcile callback can fire.
  const reconcileDiagnostic = async (runId: string, status: HistoryStatus) => {
    setRunHistory(prev => prev.map(entry =>
      entry.runId === runId ? { ...entry, status, completedAt: new Date() } : entry));
    try {
      const res = await fetch(`/api/runs/${encodeURIComponent(runId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(statusPatchBody(status)),
      });
      if (!res.ok) console.warn(`Failed to persist diagnostic run status: HTTP ${res.status}`);
    } catch {
      // History keeps the server's value; local state is already updated.
    }
  };

  const handleRunComplete = async (result: { runId: string; status: string; iterations: number; metrics: { avgDuration: number; errorRate: number } }) => {
    // Only the launched load run frees the latch; a viewed historical run does not.
    if (result.runId === run.runId) releaseLoad();
    // Map orchestrator status (e.g. "finished") to the history vocabulary
    const historyStatus = toHistoryStatus(result.status);
    if (!historyStatus) return;

    // Update history entry in state
    setRunHistory(prev => prev.map(entry => 
      entry.runId === result.runId 
        ? { 
            ...entry, 
            status: historyStatus,
            completedAt: new Date(),
            iterations: result.iterations,
            avgDuration: result.metrics.avgDuration,
            errorRate: result.metrics.errorRate,
          }
        : entry
    ));
    
    // Persist to database
    try {
      const res = await fetch(`/api/runs/${result.runId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: historyStatus,
          iterations: result.iterations,
          avgDurationMs: result.metrics.avgDuration,
          errorRate: result.metrics.errorRate,
        }),
      });
      if (!res.ok) {
        console.warn(`Failed to persist run ${result.runId} status: HTTP ${res.status}`);
      }
    } catch {
      // Silently fail - state is already updated in memory
    }
  };

  // Loading state
  if (auth.loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="flex flex-col items-center gap-space-md">
          <div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full" />
          <span className="text-body-md text-on-surface-variant">Verificando autenticación...</span>
        </div>
      </div>
    );
  }

  // Not authenticated
  if (!auth.authenticated) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="card max-w-md text-center">
          <span className="material-symbols-outlined text-error text-[48px] mb-space-md" aria-hidden="true">lock</span>
          <h1 className="text-headline-lg text-on-surface font-semibold mb-space-sm">
            Acceso Restringido
          </h1>
          <p className="text-body-md text-on-surface-variant mb-space-lg">{auth.error}</p>
          <div className="flex justify-center gap-space-md">
            <Link href="/login" className="btn-primary">
              <span className="material-symbols-outlined text-[18px]" aria-hidden="true">login</span>
              <span>Iniciar Sesión</span>
            </Link>
            <Link href="/" className="btn-secondary">
              <span className="material-symbols-outlined text-[18px]" aria-hidden="true">home</span>
              <span>Inicio</span>
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const renderConfigPanel = () => {
    if (!selectedNode) return null;

    const { kind, parameters } = selectedNode.data;
    const nodeId = selectedNode.id;

    switch (kind) {
      case "http-request":
        return (
          <HttpRequestConfigPanel
            key={`config-panel-${nodeId}`}
            parameters={parameters as Parameters<typeof HttpRequestConfigPanel>[0]["parameters"]}
            availableOutputs={getAvailableOutputs()}
            variableNames={definedVariableNames}
            onChange={(params) => updateNodeParameters(nodeId, params)}
            onClose={closeConfigPanel}
            onRunEndpointTest={handleRunEndpointTest}
            endpointTestRunning={endpointTestInFlight}
            endpointTestResult={endpointTestResults.current.get(nodeId)}
            onDismissEndpointTestResult={handleDismissEndpointTestResult}
          />
        );
      case "authentication":
        return (
          <AuthenticationConfigPanel
            key={`config-panel-${nodeId}`}
            parameters={parameters as Parameters<typeof AuthenticationConfigPanel>[0]["parameters"]}
            variableNames={definedVariableNames}
            onChange={(params) => updateNodeParameters(nodeId, params)}
            onClose={closeConfigPanel}
          />
        );
      case "response-validation":
        return (
          <ResponseValidationConfigPanel
            key={`config-panel-${nodeId}`}
            parameters={parameters as Parameters<typeof ResponseValidationConfigPanel>[0]["parameters"]}
            availableNodes={getHttpRequestNodes()}
            onChange={(params) => updateNodeParameters(nodeId, params)}
            onClose={closeConfigPanel}
          />
        );
      case "user-pool":
        return (
          <UserPoolConfigPanel
            key={`config-panel-${nodeId}`}
            parameters={parameters as Parameters<typeof UserPoolConfigPanel>[0]["parameters"]}
            scenarioId={scenario.scenarioId}
            attachments={attachments}
            onChange={(params) => updateNodeParameters(nodeId, params)}
            onClose={closeConfigPanel}
            onUploadFile={uploadFile}
            onDeleteAttachment={deleteAttachment}
          />
        );
      default:
        return null;
    }
  };

  return (<>
    <div className="h-screen flex flex-col bg-background" inert={locked} aria-hidden={locked || undefined}>
      {/* Header */}
      <header className="h-14 flex items-center justify-between px-4 bg-surface-container-lowest border-b border-surface-container">
        <div className="flex items-center gap-space-md">
          <Link href="/" className="flex items-center gap-space-sm">
            <div className="w-7 h-7 rounded-lg bg-primary-container flex items-center justify-center">
              <span className="text-on-primary-container font-bold text-xs">k6</span>
            </div>
          </Link>
          <span className="text-outline-variant">/</span>
          <span className="material-symbols-outlined text-primary text-[18px]" aria-hidden="true">edit_square</span>
          <h1 className="text-headline-sm text-on-surface font-semibold">
            {scenario.scenarioName || "Nuevo Escenario"}
          </h1>
          <span className="text-xs text-on-surface-variant" role="status">{scenario.saving ? "Guardando…" : dirty ? "Cambios sin guardar" : "Sin cambios"}</span>
          {scenario.scenarioId && (
            <span className="text-label-code-sm text-on-surface-variant font-mono">
              #{scenario.scenarioId}
            </span>
          )}
        </div>

        <div className="flex items-center gap-space-md">
          {(scenario.error || run.error) && (
            <span
              className="text-body-sm text-error max-w-[420px] line-clamp-2 break-words"
              title={scenario.error || run.error || undefined}
              role="alert"
            >
              {scenario.error || run.error}
            </span>
          )}
          <span className="text-label-code-sm text-on-surface-variant font-mono">
            {nodes.length} nodos · {edges.length} conexiones
          </span>
          <button
            onClick={() => {
              setShowHistoryPanel(!showHistoryPanel);
              if (!showHistoryPanel) setShowVariablesPanel(false);
            }}
            className={`btn-secondary ${showHistoryPanel ? 'bg-secondary/20' : ''}`}
            title="Ver historial de ejecuciones"
          >
            <span className="material-symbols-outlined text-[16px]" aria-hidden="true">history</span>
            <span>Historial</span>
            {runHistory.length > 0 && (
              <span className="ml-1 px-1.5 py-0.5 text-[10px] bg-primary text-on-primary rounded-full">
                {runHistory.length}
              </span>
            )}
          </button>
          <button
            onClick={() => {
              setShowScriptPanel(!showScriptPanel);
              if (!showScriptPanel) setShowVariablesPanel(false);
            }}
            className={`btn-secondary ${showScriptPanel ? 'bg-secondary/20' : ''}`}
            title="Ver script K6 generado"
          >
            <span className="material-symbols-outlined text-[16px]" aria-hidden="true">code</span>
            <span>Script</span>
          </button>
          <button
            onClick={() => {
              const next = !showVariablesPanel;
              setShowVariablesPanel(next);
              if (next) {
                setShowScriptPanel(false);
                setShowHistoryPanel(false);
              }
            }}
            className={`btn-secondary ${showVariablesPanel ? 'bg-secondary/20' : ''}`}
            title={
              undefinedVariableCount > 0
                ? `${undefinedVariableCount} variable(s) used but not defined`
                : "Variables del escenario"
            }
          >
            <span className="material-symbols-outlined text-[16px]" aria-hidden="true">data_object</span>
            <span>Variables</span>
            {undefinedVariableCount > 0 && (
              <span className="ml-1 px-1.5 py-0.5 text-[10px] bg-amber-500 text-black rounded-full">
                {undefinedVariableCount}
              </span>
            )}
          </button>
          <button onClick={handleNew} className="btn-secondary">
            <span className="material-symbols-outlined text-[16px]" aria-hidden="true">add</span>
            <span>Nuevo</span>
          </button>
          <button
            onClick={handleSave}
            disabled={scenario.saving || scenario.loading}
            className="btn-primary"
          >
            <span className="material-symbols-outlined text-[16px]" aria-hidden="true">save</span>
            <span>{scenario.saving ? "Guardando..." : "Guardar"}</span>
          </button>
          <EnvironmentSelector
            environments={environmentsStale || environments.loading || environments.error ? [] : environments.environments}
            selectedId={selectedEnvironment?.id ?? null}
            onChange={environmentSelection.setSelectedId}
            loading={environments.loading && !environments.loaded}
            error={environments.error}
            disabled={run.running}
          />
          <button
            onClick={() => handleRunClick("load")}
            disabled={run.running || runBusy || nodes.length === 0 || run.orchestratorAvailable === false}
            className="flex items-center gap-space-xs px-space-md py-space-sm bg-secondary-container text-on-secondary-container font-semibold rounded-xl shadow-glow-secondary transition-all hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
            title={run.orchestratorAvailable === false ? "Orchestrator no disponible" : "Ejecutar escenario"}
          >
            <span className="material-symbols-outlined text-[16px]" aria-hidden="true">play_arrow</span>
            <span>{run.running ? "Ejecutando..." : "Ejecutar"}</span>
          </button>
          <button
            onClick={() => handleRunClick("diagnostic")}
            disabled={runBusy || locked || !sessionMarker || !diagnostic.controller || nodes.length === 0 || run.orchestratorAvailable === false}
            className="btn-secondary"
            title="Ejecución diagnóstica: 1 VU · 1 iteración, separada de la carga"
          >
            <span className="material-symbols-outlined text-[16px]" aria-hidden="true">troubleshoot</span>
            <span>{diagnostic.state.busy === "diagnostic" ? "Diagnosticando..." : "Ejecución diagnóstica"}</span>
          </button>
        </div>
      </header>

      {/* Import analysis banner */}
      {importAnalysis && (
        <div className="flex items-center gap-space-lg px-space-lg py-space-sm bg-secondary/10 border-b border-secondary/30">
          <span className="material-symbols-outlined text-secondary text-[20px]" aria-hidden="true">check_circle</span>
          <span className="text-body-md text-on-surface font-medium">
            Importados {nodes.length} requests del grabador
          </span>
          <span className="text-body-sm text-secondary">
            {importAnalysis.authSignals > 0 && (
              <span>{importAnalysis.authSignals} señal{importAnalysis.authSignals > 1 ? "es" : ""} de auth</span>
            )}
            {importAnalysis.authSignals > 0 && importAnalysis.dynamicValues > 0 && " · "}
            {importAnalysis.dynamicValues > 0 && (
              <span>{importAnalysis.dynamicValues} valor{importAnalysis.dynamicValues > 1 ? "es" : ""} dinámico{importAnalysis.dynamicValues > 1 ? "s" : ""}</span>
            )}
          </span>
          <button
            onClick={() => setImportAnalysis(null)}
            className="ml-auto px-space-md py-space-xs text-body-sm text-secondary border border-secondary/30 rounded-lg hover:bg-secondary/10 transition-colors"
          >
            Cerrar
          </button>
        </div>
      )}

      {/* Loading overlay */}
      {scenario.loading && (
        <div className="absolute inset-0 bg-background/90 flex items-center justify-center z-50">
          <div className="flex flex-col items-center gap-space-md">
            <div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full" />
            <span className="text-body-md text-on-surface-variant">Cargando escenario...</span>
          </div>
        </div>
      )}

      {/* Save dialog */}
      {showSaveDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="card w-[400px]">
            <h2 className="text-headline-md text-on-surface font-semibold mb-space-lg">
              Guardar Escenario
            </h2>
            <input
              type="text"
              value={scenarioNameInput}
              disabled={scenario.saving}
              onChange={(e) => setScenarioNameInput(e.target.value)}
              placeholder="Nombre del escenario"
              className="input mb-space-lg"
              autoFocus
            />
            <div className="flex gap-space-sm justify-end">
              <button onClick={() => setShowSaveDialog(false)} className="btn-secondary">
                Cancelar
              </button>
              <button
                onClick={handleCreateScenario}
                disabled={!scenarioNameInput.trim() || scenario.saving}
                className="btn-primary disabled:opacity-50"
              >
                {scenario.saving ? "Guardando..." : "Guardar"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Run confirmation dialog */}
      {showRunConfirmation && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="card w-[450px]">
            <div className="flex items-center gap-space-sm mb-space-lg">
              <span className="material-symbols-outlined text-amber-500 text-[24px]" aria-hidden="true">warning</span>
              <h2 className="text-headline-md text-on-surface font-semibold">
                {runConfirmationKind === "diagnostic" ? "Confirmar Ejecución Diagnóstica" : "Confirmar Prueba de Carga"}
              </h2>
            </div>
            <p className="text-body-md text-on-surface-variant mb-space-md">
              {runConfirmationKind === "diagnostic"
                ? "Vas a ejecutar un diagnóstico (1 VU · 1 iteración) contra"
                : "Vas a ejecutar una prueba de carga contra"} {runTargets.length > 1 ? "los siguientes destinos" : "el siguiente destino"}:
            </p>
            <div className="bg-surface-container-lowest border border-surface-container rounded-lg p-space-md mb-space-md max-h-[150px] overflow-auto">
              {runTargets.length > 0 ? (
                runTargets.map((target, idx) => (
                  <div key={idx} className="text-label-code-md text-on-surface font-mono py-1">
                    {target}
                  </div>
                ))
              ) : (
                <div className="text-on-surface-variant italic">No se detectaron targets HTTP</div>
              )}
            </div>
            <p className="text-body-sm text-on-surface-variant mb-space-md">
              Entorno:{" "}
              <span className="text-on-surface font-medium">{selectedEnvironment?.name ?? "Sin entorno"}</span>
            </p>
            <div className="p-space-md rounded-lg bg-amber-500/10 border border-amber-500/30 mb-space-lg">
              <div className="flex items-start gap-space-sm">
                <span className="material-symbols-outlined text-amber-500 text-[18px]" aria-hidden="true">electric_bolt</span>
                <p className="text-body-sm text-amber-200">
                  Esto generará tráfico HTTP real. Solo ejecuta pruebas contra sistemas que te pertenecen o tienes permiso para testear.
                </p>
              </div>
            </div>
            <div className="flex gap-space-sm justify-end">
              <button onClick={() => setShowRunConfirmation(false)} className="btn-secondary">
                Cancelar
              </button>
              <button
                onClick={runConfirmationKind === "diagnostic" ? handleDiagnosticConfirmed : handleRunConfirmed}
                className="flex items-center gap-space-xs px-space-md py-space-sm bg-error text-on-error font-semibold rounded-xl transition-all hover:opacity-90"
              >
                <span className="material-symbols-outlined text-[16px]" aria-hidden="true">play_arrow</span>
                <span>{runConfirmationKind === "diagnostic" ? "Ejecutar Diagnóstico" : "Ejecutar Prueba"}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Editor canvas */}
      <div className="flex-1 relative">
        <FlowEditor
          key={flowGeneration}
          nodes={nodes}
          edges={edges}
          flowSession={String(flowGeneration)}
          onNodesChange={setNodes}
          onEdgesChange={setEdges}
          onNodeSelect={selectNode}
          onEdgeSelect={selectEdge}
          onNodesRemoved={handleNodesRemoved}
        />
        {!selectedNode && selectedEdge && (
          <aside aria-label="Inspector de la conexión"
            className="absolute top-4 right-4 z-30 w-80 flex flex-col gap-2 [&>div]:!static [&>div]:!w-full [&>div]:!max-h-none"
            style={{ maxHeight: "calc(100% - 32px)" }}>
            <ConnectionConfigPanel
              key={selectedEdge.id}
              fromLabel={nodeLabel(selectedEdge.source)}
              toLabel={nodeLabel(selectedEdge.target)}
              waitSeconds={(selectedEdge.data as { waitSeconds?: number } | undefined)?.waitSeconds}
              onChange={(waitSeconds) => updateEdgeWait(selectedEdge.id, waitSeconds)}
              onClose={() => setSelectedEdgeId(null)}
            />
          </aside>
        )}
        {selectedNode && <aside aria-label="Inspector del nodo"
          className="absolute top-4 right-4 z-30 w-80 overflow-y-auto flex flex-col gap-2 [&>div]:!static [&>div]:!w-full [&>div]:!max-h-none"
          style={{ maxHeight: "calc(100% - 32px)" }}>
          <NodeMetadataInspector key={selectedNode.id} node={selectedNode}
            onRename={name => {
              const result = renameNode(nodes, selectedNode.id, name);
              if (!result.error) setNodes(result.nodes);
              return result.error;
            }}
            onToggle={() => setNodes(current => toggleDisabled(current, [selectedNode.id]))} />
          {renderConfigPanel()}
        </aside>}
        {showVariablesPanel && (
          <VariablesPanel
            scenarioId={scenario.scenarioId}
            scenarioVariables={scenarioVariables}
            environmentName={selectedEnvironment?.name ?? null}
            environmentVariables={environmentVariables}
            usedNames={usedVariableNames}
            onClose={() => setShowVariablesPanel(false)}
          />
        )}
        {showScriptPanel && (
          <ScriptPanel
            nodes={nodes}
            edges={edges}
            initialVus={editorVus}
            initialDuration={editorDuration}
            onClose={() => setShowScriptPanel(false)}
            onConfigChange={(vus, duration) => {
              setEditorVus(vus);
              setEditorDuration(duration);
            }}
          />
        )}
        
        {/* Run Execution Panel */}
        {showExecutionPanel && currentRunId && (
          <RunExecutionPanel
            runId={currentRunId}
            vus={runHistory.find((r) => r.runId === currentRunId)?.vus}
            onClose={() => {
              // No background watcher for load runs: closing the panel frees the latch.
              if (loadTokenRef.current && run.runId === currentRunId) releaseLoad();
              setShowExecutionPanel(false);
              setCurrentRunId(null);
            }}
            onComplete={handleRunComplete}
          />
        )}
        
        {/* Run History Panel */}
        {showHistoryPanel && (
          <RunHistoryPanel
            history={runHistory}
            onClose={() => setShowHistoryPanel(false)}
            onViewRun={(runId) => {
              // The live load panel owns the load latch until it completes or closes;
              // replacing it (or a start still in flight) would break mutual exclusion.
              if (loadTokenRef.current) {
                notify({ type: "error", message: "Esperá a que termine o cerrá la ejecución de carga en curso" });
                return;
              }
              // Classify first: only a confirmed 409 opens the load view.
              setShowHistoryPanel(false);
              void diagnostic.controller?.view(runId);
            }}
          />
        )}

        {/* Diagnostic panel / history classification (separate from load) */}
        {!locked && diagnosticSelection.kind !== "closed" && diagnosticSelection.kind !== "load" && (
          <div className="absolute top-4 right-4 w-[480px] max-h-[70%] overflow-auto z-[101]">
            {diagnosticSelection.kind === "diagnostic" && diagnosticObserverOptions ? (
              <DiagnosticExecutionPanel
                runId={diagnosticSelection.runId}
                selectionKey={diagnosticSelection.key}
                executionDisplay={diagnosticSelection.executionDisplay}
                initialSnapshot={diagnosticSelection.initialSnapshot}
                observerOptions={diagnosticObserverOptions}
                onClose={() => diagnostic.controller?.close()}
                onTerminal={({ runId, status }) => { diagnostic.controller?.terminal(runId, status); }}
                onProtectedDataInvalidated={() => diagnostic.controller?.clearForSession()}
              />
            ) : (
              <section role="status" className="rounded-lg border border-surface-container bg-surface-container p-4 text-on-surface">
                <p>{diagnosticSelection.kind === "classifying"
                  ? "Verificando el tipo de ejecución…"
                  : "No se pudo verificar el tipo de ejecución · no se abre como carga"}</p>
                <div className="flex gap-space-sm justify-end mt-space-sm">
                  {diagnosticSelection.kind === "unavailable" &&
                    <button type="button" className="btn-secondary" onClick={() => void diagnostic.controller?.retry()}>Reintentar</button>}
                  <button type="button" className="btn-secondary" onClick={() => diagnostic.controller?.close()}>Cerrar</button>
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
    {locked && (
      <div role="status" className="fixed inset-0 bg-background/90 flex items-center justify-center z-50">
        <div className="flex flex-col items-center gap-space-md">
          {session.phase !== "blocked" && <div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full" />}
          <span className="text-body-md text-on-surface-variant">Verificando sesión…</span>
          {session.phase === "blocked" && <button onClick={session.retry} className="btn-primary">Reintentar</button>}
        </div>
      </div>
    )}
  </>);
}

/**
 * `useSearchParams()` opts the page out of static prerendering, so the editor
 * needs a Suspense boundary above it or `next build` rejects the page.
 */
export default function EditorPageRoute() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-background" aria-busy="true" />}>
      <EditorPage />
    </Suspense>
  );
}
