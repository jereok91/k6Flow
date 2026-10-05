"use client";

// K6F4-05b/c/06 + K6F5-03: Visual scenario editor page with save/load/run functionality.
// K6F8-04: Import from recorder support.
// Authenticated users only.

import { useState, useEffect, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  capturesToGraph,
  generateConnections,
  detectAuth,
  detectDynamicValues,
  type RecorderCaptureEntry,
} from "@k6flow/shared";
import {
  FlowEditor,
  HttpRequestConfigPanel,
  AuthenticationConfigPanel,
  ResponseValidationConfigPanel,
  UserPoolConfigPanel,
  ScriptPanel,
  type K6NodeType,
  type K6Edge,
  type K6NodeData,
} from "../../lib/editor";
import { useScenario } from "../../lib/editor/use-scenario";
import { useRun } from "../../lib/editor/use-run";

interface AuthState {
  loading: boolean;
  authenticated: boolean;
  error?: string;
}

interface AttachmentInfo {
  id: string;
  name: string;
  contentType: string;
  size: number;
  createdAt: string;
}

export default function EditorPage() {
  const [auth, setAuth] = useState<AuthState>({ loading: true, authenticated: false });
  const [nodes, setNodes] = useState<K6NodeType[]>([]);
  const [edges, setEdges] = useState<K6Edge[]>([]);
  const [selectedNode, setSelectedNode] = useState<K6NodeType | null>(null);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [scenarioNameInput, setScenarioNameInput] = useState("");
  const [attachments, setAttachments] = useState<AttachmentInfo[]>([]);
  const [importedCaptures, setImportedCaptures] = useState<RecorderCaptureEntry[] | null>(null);
  const [importAnalysis, setImportAnalysis] = useState<{
    authSignals: number;
    dynamicValues: number;
  } | null>(null);
  const [showRunConfirmation, setShowRunConfirmation] = useState(false);
  const [runTargets, setRunTargets] = useState<string[]>([]);
  const [showScriptPanel, setShowScriptPanel] = useState(false);

  const scenario = useScenario();
  const run = useRun();
  const router = useRouter();
  const searchParams = useSearchParams();

  // Check orchestrator on mount
  useEffect(() => {
    run.checkOrchestrator();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Check authentication on mount
  useEffect(() => {
    fetch("/api/auth/me")
      .then((res) => {
        if (res.ok) {
          setAuth({ loading: false, authenticated: true });
        } else if (res.status === 401) {
          setAuth({ loading: false, authenticated: false, error: "Inicia sesión para usar el editor" });
        } else {
          setAuth({ loading: false, authenticated: false, error: "Error de autenticación" });
        }
      })
      .catch(() => {
        setAuth({ loading: false, authenticated: false, error: "Error de red" });
      });
  }, []);

  // Load scenario from URL params on mount
  useEffect(() => {
    if (!auth.authenticated) return;
    const params = new URLSearchParams(window.location.search);
    const id = params.get("id");
    if (id) {
      const scenarioId = parseInt(id, 10);
      scenario.loadScenario(scenarioId).then((result) => {
        if (result) {
          setNodes(result.nodes);
          setEdges(result.edges);
        }
      });
      loadAttachments(scenarioId);
    }
  }, [auth.authenticated]); // eslint-disable-line react-hooks/exhaustive-deps

  // K6F8-04: Process imported captures from recorder
  useEffect(() => {
    if (!auth.authenticated) return;
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
        } as K6NodeData,
      }));

      const edgesFromCaptures: K6Edge[] = graphConnections.map((conn, index) => ({
        id: `import-edge-${index}`,
        source: conn.source,
        target: conn.target,
      }));

      setNodes(nodesWithPositions);
      setEdges(edgesFromCaptures);
      sessionStorage.removeItem("k6flow-import-captures");
      router.replace("/editor");
    } catch (err) {
      console.error("Failed to import captures:", err);
    }
  }, [auth.authenticated, searchParams]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadAttachments = useCallback(async (scenarioId: number) => {
    try {
      const res = await fetch(`/api/scenarios/${scenarioId}/attachments`);
      if (res.ok) {
        const data = await res.json();
        setAttachments(data.attachments ?? []);
      }
    } catch {
      // Silently fail
    }
  }, []);

  const uploadFile = useCallback(async (file: File): Promise<AttachmentInfo | null> => {
    if (!scenario.scenarioId) return null;

    const reader = new FileReader();
    const base64 = await new Promise<string>((resolve, reject) => {
      reader.onload = () => {
        const result = reader.result as string;
        resolve(result.split(",")[1]);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

    const res = await fetch(`/api/scenarios/${scenario.scenarioId}/attachments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: file.name,
        contentType: file.type || "text/csv",
        data: base64,
      }),
    });

    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error || "Upload failed");
    }

    const data = await res.json();
    setAttachments((prev) => [...prev, data.attachment]);
    return data.attachment;
  }, [scenario.scenarioId]);

  const deleteAttachment = useCallback(async (attachmentId: string): Promise<boolean> => {
    if (!scenario.scenarioId) return false;

    const res = await fetch(
      `/api/scenarios/${scenario.scenarioId}/attachments/${attachmentId}`,
      { method: "DELETE" },
    );

    if (res.ok) {
      setAttachments((prev) => prev.filter((a) => a.id !== attachmentId));
      return true;
    }
    return false;
  }, [scenario.scenarioId]);

  const updateNodeParameters = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (nodeId: string, parameters: any) => {
      setNodes((current) =>
        current.map((node) =>
          node.id === nodeId
            ? { ...node, data: { ...node.data, parameters } as K6NodeData }
            : node,
        ),
      );
    },
    [],
  );

  const closeConfigPanel = useCallback(() => {
    setSelectedNode(null);
    setNodes((current) => current.map((n) => ({ ...n, selected: false })));
  }, []);

  const handleSave = async () => {
    if (!scenario.scenarioId) {
      setShowSaveDialog(true);
      return;
    }
    await scenario.updateScenario(scenario.scenarioId, scenario.scenarioName, nodes, edges);
  };

  const handleCreateScenario = async () => {
    if (!scenarioNameInput.trim()) return;
    const result = await scenario.saveScenario(scenarioNameInput.trim(), nodes, edges);
    if (result) {
      setShowSaveDialog(false);
      setScenarioNameInput("");
    }
  };

  const handleNew = () => {
    scenario.clearScenario();
    setNodes([]);
    setEdges([]);
    setSelectedNode(null);
    setAttachments([]);
    setImportedCaptures(null);
    setImportAnalysis(null);
    router.replace("/editor");
  };

  const getHttpRequestNodes = () => {
    return nodes
      .filter((n) => n.data.kind === "http-request")
      .map((n) => ({ id: n.id, label: n.data.label || n.id }));
  };

  const handleRunClick = () => {
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
    setShowRunConfirmation(true);
  };

  const handleRunConfirmed = async () => {
    setShowRunConfirmation(false);
    if (nodes.length === 0) {
      return;
    }
    await run.startRun(nodes, edges);
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
          <span className="material-symbols-outlined text-error text-[48px] mb-space-md">lock</span>
          <h1 className="text-headline-lg text-on-surface font-semibold mb-space-sm">
            Acceso Restringido
          </h1>
          <p className="text-body-md text-on-surface-variant mb-space-lg">{auth.error}</p>
          <div className="flex justify-center gap-space-md">
            <Link href="/login" className="btn-primary">
              <span className="material-symbols-outlined text-[18px]">login</span>
              <span>Iniciar Sesión</span>
            </Link>
            <Link href="/" className="btn-secondary">
              <span className="material-symbols-outlined text-[18px]">home</span>
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
            parameters={parameters as Parameters<typeof HttpRequestConfigPanel>[0]["parameters"]}
            onChange={(params) => updateNodeParameters(nodeId, params)}
            onClose={closeConfigPanel}
          />
        );
      case "authentication":
        return (
          <AuthenticationConfigPanel
            parameters={parameters as Parameters<typeof AuthenticationConfigPanel>[0]["parameters"]}
            onChange={(params) => updateNodeParameters(nodeId, params)}
            onClose={closeConfigPanel}
          />
        );
      case "response-validation":
        return (
          <ResponseValidationConfigPanel
            parameters={parameters as Parameters<typeof ResponseValidationConfigPanel>[0]["parameters"]}
            availableNodes={getHttpRequestNodes()}
            onChange={(params) => updateNodeParameters(nodeId, params)}
            onClose={closeConfigPanel}
          />
        );
      case "user-pool":
        return (
          <UserPoolConfigPanel
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

  return (
    <div className="h-screen flex flex-col bg-background">
      {/* Header */}
      <header className="h-14 flex items-center justify-between px-space-lg bg-surface-container-lowest border-b border-surface-container">
        <div className="flex items-center gap-space-md">
          <Link href="/" className="flex items-center gap-space-sm">
            <div className="w-7 h-7 rounded-lg bg-primary-container flex items-center justify-center">
              <span className="text-on-primary-container font-bold text-xs">k6</span>
            </div>
          </Link>
          <span className="text-outline-variant">/</span>
          <span className="material-symbols-outlined text-primary text-[18px]">edit_square</span>
          <h1 className="text-headline-sm text-on-surface font-semibold">
            {scenario.scenarioName || "Nuevo Escenario"}
          </h1>
          {scenario.scenarioId && (
            <span className="text-label-code-sm text-on-surface-variant font-mono">
              #{scenario.scenarioId}
            </span>
          )}
        </div>

        <div className="flex items-center gap-space-md">
          {(scenario.error || run.error) && (
            <span className="text-body-sm text-error">
              {scenario.error || run.error}
            </span>
          )}
          <span className="text-label-code-sm text-on-surface-variant font-mono">
            {nodes.length} nodos · {edges.length} conexiones
          </span>
          <button
            onClick={() => setShowScriptPanel(!showScriptPanel)}
            className={`btn-secondary ${showScriptPanel ? 'bg-secondary/20' : ''}`}
            title="Ver script K6 generado"
          >
            <span className="material-symbols-outlined text-[16px]">code</span>
            <span>Script</span>
          </button>
          <button onClick={handleNew} className="btn-secondary">
            <span className="material-symbols-outlined text-[16px]">add</span>
            <span>Nuevo</span>
          </button>
          <button
            onClick={handleSave}
            disabled={scenario.saving || scenario.loading}
            className="btn-primary"
          >
            <span className="material-symbols-outlined text-[16px]">save</span>
            <span>{scenario.saving ? "Guardando..." : "Guardar"}</span>
          </button>
          <button
            onClick={handleRunClick}
            disabled={run.running || nodes.length === 0 || run.orchestratorAvailable === false}
            className="flex items-center gap-space-xs px-space-md py-space-sm bg-secondary-container text-on-secondary-container font-semibold rounded-xl shadow-glow-secondary transition-all hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
            title={run.orchestratorAvailable === false ? "Orchestrator no disponible" : "Ejecutar escenario"}
          >
            <span className="material-symbols-outlined text-[16px]">play_arrow</span>
            <span>{run.running ? "Ejecutando..." : "Ejecutar"}</span>
          </button>
        </div>
      </header>

      {/* Import analysis banner */}
      {importAnalysis && (
        <div className="flex items-center gap-space-lg px-space-lg py-space-sm bg-secondary/10 border-b border-secondary/30">
          <span className="material-symbols-outlined text-secondary text-[20px]">check_circle</span>
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
              <span className="material-symbols-outlined text-amber-500 text-[24px]">warning</span>
              <h2 className="text-headline-md text-on-surface font-semibold">
                Confirmar Prueba de Carga
              </h2>
            </div>
            <p className="text-body-md text-on-surface-variant mb-space-md">
              Vas a ejecutar una prueba de carga contra {runTargets.length > 1 ? "los siguientes destinos" : "el siguiente destino"}:
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
            <div className="p-space-md rounded-lg bg-amber-500/10 border border-amber-500/30 mb-space-lg">
              <div className="flex items-start gap-space-sm">
                <span className="material-symbols-outlined text-amber-500 text-[18px]">electric_bolt</span>
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
                onClick={handleRunConfirmed}
                className="flex items-center gap-space-xs px-space-md py-space-sm bg-error text-on-error font-semibold rounded-xl transition-all hover:opacity-90"
              >
                <span className="material-symbols-outlined text-[16px]">play_arrow</span>
                <span>Ejecutar Prueba</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Editor canvas */}
      <div className="flex-1 relative">
        <FlowEditor
          initialNodes={nodes}
          initialEdges={edges}
          onNodesChange={setNodes}
          onEdgesChange={setEdges}
          onNodeSelect={setSelectedNode}
        />
        {renderConfigPanel()}
        {showScriptPanel && (
          <ScriptPanel
            nodes={nodes}
            edges={edges}
            onClose={() => setShowScriptPanel(false)}
          />
        )}
      </div>
    </div>
  );
}
