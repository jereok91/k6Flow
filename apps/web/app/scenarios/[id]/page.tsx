"use client";

import { useState, useEffect, use } from "react";
import Link from "next/link";
import { translateToK6 } from "@k6flow/shared";
import { MainLayout } from "../../../lib/layout";

interface Scenario {
  id: string;
  name: string;
  ownerId: string;
  graph: {
    nodes: Record<string, unknown>;
    edges: Array<{ from: string; to: string }>;
    startNode?: string;
  };
  isFavorite?: number;
  createdAt: string;
  updatedAt: string;
}

interface Version {
  id: string;
  version: number;
  changeDescription: string | null;
  createdAt: string;
}

type Tab = "summary" | "graph" | "script" | "versions" | "runs";

// Panels and code blocks follow the app design system: the shell renders the page,
// surfaces use the theme tokens, and copy matches the rest of the UI language.
const PANEL = "card bg-surface-container-lowest border-surface-container";
const CODE_BLOCK =
  "max-h-[500px] overflow-auto rounded-lg bg-surface-container-low border border-surface-container p-space-md font-mono text-label-code-md text-on-surface-variant";
const PANEL_TITLE = "text-headline-sm text-on-surface font-medium";

export default function ScenarioDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("summary");
  const [versions, setVersions] = useState<Version[]>([]);
  const [k6Script, setK6Script] = useState<string>("");
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);
  const [versionGraph, setVersionGraph] = useState<unknown>(null);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(`/api/scenarios/${id}`);
        if (!res.ok) throw new Error("Failed to load scenario");
        const data = await res.json();
        setScenario(data);

        // Generate K6 script
        if (data.graph) {
          const result = translateToK6(data.graph);
          setK6Script(result.script);
        }

        // Load versions
        const versionsRes = await fetch(`/api/scenarios/${id}/versions`);
        if (versionsRes.ok) {
          const versionsData = await versionsRes.json();
          setVersions(versionsData.versions);
        }
      } catch (e) {
        console.error("Failed to load scenario:", e);
        setError("No se pudo cargar el escenario");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [id]);

  const loadVersionGraph = async (versionId: string) => {
    try {
      const res = await fetch(`/api/scenarios/${id}/versions/${versionId}`);
      if (res.ok) {
        const data = await res.json();
        setSelectedVersion(versionId);
        setVersionGraph(data.graph);
      }
    } catch (e) {
      console.error("Failed to load version:", e);
    }
  };

  const copyScript = () => {
    navigator.clipboard.writeText(k6Script);
  };

  const downloadScript = () => {
    const blob = new Blob([k6Script], { type: "text/javascript" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${scenario?.name || "scenario"}.js`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (loading) {
    return (
      <MainLayout>
        <div className="card text-center py-space-xl">
          <div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full mx-auto" />
          <p className="text-body-md text-on-surface-variant mt-space-md">Cargando escenario...</p>
        </div>
      </MainLayout>
    );
  }

  if (error || !scenario) {
    return (
      <MainLayout>
        <div className="card text-center">
          <span className="material-symbols-outlined text-error text-[32px] mb-space-md" aria-hidden="true">error</span>
          <p className="text-body-md text-error">{error || "Escenario no encontrado"}</p>
          <Link href="/scenarios" className="btn-secondary mt-space-md mx-auto">
            <span className="material-symbols-outlined text-[18px]" aria-hidden="true">arrow_back</span>
            <span>Volver a escenarios</span>
          </Link>
        </div>
      </MainLayout>
    );
  }

  const nodeCount = Object.keys(scenario.graph?.nodes || {}).length;
  const edgeCount = scenario.graph?.edges?.length || 0;

  const tabs: { id: Tab; label: string }[] = [
    { id: "summary", label: "Resumen" },
    { id: "graph", label: "Grafo" },
    { id: "script", label: "Guion K6" },
    { id: "versions", label: "Versiones" },
    { id: "runs", label: "Ejecuciones" },
  ];

  return (
    <MainLayout>
      <div className="px-gutter-desktop py-space-xl flex flex-col gap-space-xl">
        {/* Header */}
        <section className="flex flex-col md:flex-row md:items-end justify-between gap-space-lg">
          <div className="flex flex-col gap-space-xs">
            <div className="flex items-center gap-space-sm text-label-code-sm text-on-surface-variant uppercase tracking-wider">
              <span className="material-symbols-outlined text-primary text-[16px]" aria-hidden="true">account_tree</span>
              <span>Biblioteca de escenarios</span>
            </div>
            <h1 className="flex items-center gap-space-sm text-headline-lg text-on-surface font-semibold tracking-tight">
              {scenario.name}
              {scenario.isFavorite ? (
                <span
                  className="material-symbols-outlined text-amber-400 text-[24px]"
                  role="img"
                  aria-label="Favorito"
                  style={{ fontVariationSettings: "'FILL' 1" }}
                >
                  star
                </span>
              ) : null}
            </h1>
            <p className="text-body-md text-on-surface-variant">
              Creado {new Date(scenario.createdAt).toLocaleDateString()} · Actualizado{" "}
              {new Date(scenario.updatedAt).toLocaleDateString()}
            </p>
          </div>

          <div className="flex items-center gap-space-md">
            <Link href="/scenarios" className="btn-secondary">
              <span className="material-symbols-outlined text-[18px]" aria-hidden="true">arrow_back</span>
              <span>Volver</span>
            </Link>
            <Link href={`/editor?scenario=${id}`} className="btn-primary">
              <span className="material-symbols-outlined text-[18px]" aria-hidden="true">edit_square</span>
              <span>Editar</span>
            </Link>
          </div>
        </section>

        {/* Tabs */}
        <section className="inline-flex self-start p-1 bg-surface-container-low rounded-xl">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`px-space-md py-1 rounded-lg text-body-sm transition-all ${
                activeTab === tab.id
                  ? "bg-surface-container-high text-on-surface font-medium shadow-sm"
                  : "text-on-surface-variant hover:text-on-surface"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </section>

        {/* Tab content */}
        <div className="min-h-[400px]">
          {activeTab === "summary" && (
            <div className="grid gap-space-lg md:grid-cols-2">
              <section className={PANEL}>
                <h2 className={`${PANEL_TITLE} mb-space-md`}>Detalle</h2>
                <dl className="space-y-space-sm">
                  <div className="flex justify-between">
                    <dt className="text-body-md text-on-surface-variant">Nodos</dt>
                    <dd className="text-body-md text-on-surface font-mono">{nodeCount}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-body-md text-on-surface-variant">Conexiones</dt>
                    <dd className="text-body-md text-on-surface font-mono">{edgeCount}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-body-md text-on-surface-variant">Nodo inicial</dt>
                    <dd className="text-label-code-md text-on-surface font-mono">
                      {scenario.graph?.startNode || "-"}
                    </dd>
                  </div>
                </dl>
              </section>

              <section className={PANEL}>
                <h2 className={`${PANEL_TITLE} mb-space-md`}>Acciones rápidas</h2>
                <div className="flex flex-col gap-space-sm">
                  <Link href={`/editor?scenario=${id}`} className="btn-primary justify-center">
                    <span className="material-symbols-outlined text-[18px]" aria-hidden="true">edit_square</span>
                    <span>Abrir en el editor</span>
                  </Link>
                  <button type="button" className="btn-secondary justify-center" onClick={downloadScript}>
                    <span className="material-symbols-outlined text-[18px]" aria-hidden="true">download</span>
                    <span>Descargar guion K6</span>
                  </button>
                  <button type="button" className="btn-secondary justify-center" onClick={copyScript}>
                    <span className="material-symbols-outlined text-[18px]" aria-hidden="true">content_copy</span>
                    <span>Copiar guion K6</span>
                  </button>
                </div>
              </section>
            </div>
          )}

          {activeTab === "graph" && (
            <section className={PANEL}>
              <h2 className={`${PANEL_TITLE} mb-space-md`}>Estructura del grafo</h2>
              <pre className={CODE_BLOCK}>{JSON.stringify(scenario.graph, null, 2)}</pre>
            </section>
          )}

          {activeTab === "script" && (
            <section className={PANEL}>
              <div className="mb-space-md flex items-center justify-between gap-space-md">
                <h2 className={PANEL_TITLE}>Guion K6</h2>
                <div className="flex items-center gap-space-sm">
                  <button type="button" className="btn-secondary" onClick={copyScript}>
                    <span className="material-symbols-outlined text-[18px]" aria-hidden="true">content_copy</span>
                    <span>Copiar</span>
                  </button>
                  <button type="button" className="btn-secondary" onClick={downloadScript}>
                    <span className="material-symbols-outlined text-[18px]" aria-hidden="true">download</span>
                    <span>Descargar</span>
                  </button>
                </div>
              </div>
              <pre className={CODE_BLOCK}>
                <code>{k6Script}</code>
              </pre>
            </section>
          )}

          {activeTab === "versions" && (
            <div className="grid gap-space-lg lg:grid-cols-2">
              <section className={PANEL}>
                <h2 className={`${PANEL_TITLE} mb-space-md`}>Historial de versiones</h2>
                {versions.length === 0 ? (
                  <p className="text-body-md text-on-surface-variant">
                    Sin historial de versiones. Se crean automáticamente al guardar cambios.
                  </p>
                ) : (
                  <ul className="space-y-space-sm">
                    {versions.map((v) => (
                      <li
                        key={v.id}
                        className={`cursor-pointer rounded-lg p-space-md transition ${
                          selectedVersion === v.id
                            ? "bg-primary-container text-on-primary-container"
                            : "bg-surface-container-low hover:bg-surface-container text-on-surface"
                        }`}
                        onClick={() => loadVersionGraph(v.id)}
                      >
                        <div className="flex items-center justify-between gap-space-md">
                          <span className="text-body-md font-medium">Versión {v.version}</span>
                          <span className="text-label-code-sm opacity-80">
                            {new Date(v.createdAt).toLocaleString()}
                          </span>
                        </div>
                        {v.changeDescription && (
                          <p className="mt-space-xs text-body-sm opacity-80">{v.changeDescription}</p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {selectedVersion !== null && versionGraph !== null ? (
                <section className={PANEL}>
                  <h2 className={`${PANEL_TITLE} mb-space-md`}>Grafo de la versión</h2>
                  <pre className={CODE_BLOCK}>{JSON.stringify(versionGraph, null, 2)}</pre>
                  <div className="mt-space-md flex gap-space-sm">
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => {
                        // TODO: restore this version
                        alert("La restauración de versiones estará disponible pronto");
                      }}
                    >
                      <span className="material-symbols-outlined text-[18px]" aria-hidden="true">history</span>
                      <span>Restaurar esta versión</span>
                    </button>
                  </div>
                </section>
              ) : null}
            </div>
          )}

          {activeTab === "runs" && (
            <section className={PANEL}>
              <h2 className={`${PANEL_TITLE} mb-space-md`}>Historial de ejecuciones</h2>
              <p className="text-body-md text-on-surface-variant">
                Todavía no hay ejecuciones. Ejecutá el escenario desde el editor.
              </p>
            </section>
          )}
        </div>
      </div>
    </MainLayout>
  );
}
