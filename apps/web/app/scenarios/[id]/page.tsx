"use client";

import { useState, useEffect, use } from "react";
import Link from "next/link";
import { translateToK6 } from "@k6flow/shared";

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
        setError(e instanceof Error ? e.message : "Unknown error");
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
      <div className="flex min-h-screen items-center justify-center bg-gray-900 text-white">
        Loading...
      </div>
    );
  }

  if (error || !scenario) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-900 text-white">
        <div className="text-center">
          <p className="mb-4 text-red-400">{error || "Scenario not found"}</p>
          <Link href="/scenarios" className="text-blue-400 hover:underline">
            ← Back to scenarios
          </Link>
        </div>
      </div>
    );
  }

  const nodeCount = Object.keys(scenario.graph?.nodes || {}).length;
  const edgeCount = scenario.graph?.edges?.length || 0;

  const tabs: { id: Tab; label: string }[] = [
    { id: "summary", label: "Summary" },
    { id: "graph", label: "Graph" },
    { id: "script", label: "K6 Script" },
    { id: "versions", label: "Versions" },
    { id: "runs", label: "Runs" },
  ];

  return (
    <div className="min-h-screen bg-gray-900 p-6 text-white">
      <div className="mx-auto max-w-6xl">
        {/* Header */}
        <div className="mb-6 flex items-start justify-between">
          <div>
            <Link
              href="/scenarios"
              className="mb-2 inline-block text-sm text-gray-400 hover:text-white"
            >
              ← Back to scenarios
            </Link>
            <h1 className="flex items-center gap-2 text-2xl font-bold">
              {scenario.name}
              {scenario.isFavorite ? (
                <span className="text-yellow-400">★</span>
              ) : null}
            </h1>
            <p className="text-sm text-gray-400">
              Created {new Date(scenario.createdAt).toLocaleDateString()} •
              Updated {new Date(scenario.updatedAt).toLocaleDateString()}
            </p>
          </div>
          <div className="flex gap-3">
            <Link
              href={`/editor?scenario=${id}`}
              className="rounded bg-blue-600 px-4 py-2 hover:bg-blue-500"
            >
              Edit
            </Link>
          </div>
        </div>

        {/* Tabs */}
        <div className="mb-6 border-b border-gray-700">
          <nav className="-mb-px flex gap-6">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                className={`border-b-2 px-1 py-3 text-sm font-medium ${
                  activeTab === tab.id
                    ? "border-blue-500 text-blue-400"
                    : "border-transparent text-gray-400 hover:text-white"
                }`}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </nav>
        </div>

        {/* Tab content */}
        <div className="min-h-[400px]">
          {activeTab === "summary" && (
            <div className="grid gap-6 md:grid-cols-2">
              <div className="rounded-lg bg-gray-800 p-6">
                <h2 className="mb-4 text-lg font-semibold">Overview</h2>
                <dl className="space-y-3">
                  <div className="flex justify-between">
                    <dt className="text-gray-400">Nodes</dt>
                    <dd className="font-medium">{nodeCount}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-gray-400">Edges</dt>
                    <dd className="font-medium">{edgeCount}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-gray-400">Start Node</dt>
                    <dd className="font-mono text-sm">
                      {scenario.graph?.startNode || "-"}
                    </dd>
                  </div>
                </dl>
              </div>

              <div className="rounded-lg bg-gray-800 p-6">
                <h2 className="mb-4 text-lg font-semibold">Quick Actions</h2>
                <div className="flex flex-col gap-3">
                  <Link
                    href={`/editor?scenario=${id}`}
                    className="rounded bg-gray-700 px-4 py-2 text-center hover:bg-gray-600"
                  >
                    Open in Editor
                  </Link>
                  <button
                    className="rounded bg-gray-700 px-4 py-2 hover:bg-gray-600"
                    onClick={downloadScript}
                  >
                    Download K6 Script
                  </button>
                  <button
                    className="rounded bg-gray-700 px-4 py-2 hover:bg-gray-600"
                    onClick={copyScript}
                  >
                    Copy K6 Script
                  </button>
                </div>
              </div>
            </div>
          )}

          {activeTab === "graph" && (
            <div className="rounded-lg bg-gray-800 p-6">
              <h2 className="mb-4 text-lg font-semibold">Graph Structure</h2>
              <pre className="max-h-[500px] overflow-auto rounded bg-gray-900 p-4 text-sm">
                {JSON.stringify(scenario.graph, null, 2)}
              </pre>
            </div>
          )}

          {activeTab === "script" && (
            <div className="rounded-lg bg-gray-800 p-6">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-lg font-semibold">K6 Script</h2>
                <div className="flex gap-2">
                  <button
                    className="rounded bg-gray-700 px-3 py-1 text-sm hover:bg-gray-600"
                    onClick={copyScript}
                  >
                    Copy
                  </button>
                  <button
                    className="rounded bg-gray-700 px-3 py-1 text-sm hover:bg-gray-600"
                    onClick={downloadScript}
                  >
                    Download
                  </button>
                </div>
              </div>
              <pre className="max-h-[500px] overflow-auto rounded bg-gray-900 p-4 text-sm">
                <code>{k6Script}</code>
              </pre>
            </div>
          )}

          {activeTab === "versions" && (
            <div className="grid gap-6 lg:grid-cols-2">
              <div className="rounded-lg bg-gray-800 p-6">
                <h2 className="mb-4 text-lg font-semibold">Version History</h2>
                {versions.length === 0 ? (
                  <p className="text-gray-400">No version history available. Versions are created automatically when you save changes.</p>
                ) : (
                  <ul className="space-y-2">
                    {versions.map((v) => (
                      <li
                        key={v.id}
                        className={`cursor-pointer rounded p-3 transition ${selectedVersion === v.id ? "bg-blue-600" : "bg-gray-700 hover:bg-gray-600"}`}
                        onClick={() => loadVersionGraph(v.id)}
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-medium">Version {v.version}</span>
                          <span className="text-sm text-gray-400">
                            {new Date(v.createdAt).toLocaleString()}
                          </span>
                        </div>
                        {v.changeDescription && (
                          <p className="mt-1 text-sm text-gray-400">
                            {v.changeDescription}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {selectedVersion !== null && versionGraph !== null ? (
                <div className="rounded-lg bg-gray-800 p-6">
                  <h2 className="mb-4 text-lg font-semibold">Version Graph</h2>
                  <pre className="max-h-[400px] overflow-auto rounded bg-gray-900 p-4 text-sm">
                    {JSON.stringify(versionGraph, null, 2)}
                  </pre>
                  <div className="mt-4 flex gap-2">
                    <button
                      className="rounded bg-blue-600 px-3 py-1 text-sm hover:bg-blue-500"
                      onClick={() => {
                        // TODO: restore this version
                        alert("Restore functionality coming soon");
                      }}
                    >
                      Restore this version
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          )}

          {activeTab === "runs" && (
            <div className="rounded-lg bg-gray-800 p-6">
              <h2 className="mb-4 text-lg font-semibold">Run History</h2>
              <p className="text-gray-400">
                No runs yet. Use the Editor to run this scenario.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
