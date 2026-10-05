"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { AppHeader } from "../../lib/layout";

interface Scenario {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  isFavorite: number;
  nodeCount?: number;
}

interface ScenariosResponse {
  scenarios: Scenario[];
  total: number;
  page: number;
  pageSize: number;
}

export default function ScenariosPage() {
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [filter, setFilter] = useState<"all" | "favorites">("all");
  const pageSize = 20;

  const fetchScenarios = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({
        page: page.toString(),
        pageSize: pageSize.toString(),
        ...(search && { search }),
        ...(filter === "favorites" && { favorites: "true" }),
      });

      const res = await fetch(`/api/scenarios?${params}`);
      if (!res.ok) {
        throw new Error("Failed to load scenarios");
      }

      const data: ScenariosResponse = await res.json();
      setScenarios(data.scenarios);
      setTotal(data.total);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [page, search, filter]);

  useEffect(() => {
    fetchScenarios();
  }, [fetchScenarios]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    fetchScenarios();
  };

  const toggleFavorite = async (id: string, current: number) => {
    try {
      await fetch(`/api/scenarios/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isFavorite: current ? 0 : 1 }),
      });
      // Refresh list
      fetchScenarios();
    } catch (e) {
      console.error("Failed to toggle favorite:", e);
    }
  };

  const deleteScenario = async (id: string) => {
    if (!confirm("Are you sure you want to delete this scenario?")) return;

    try {
      await fetch(`/api/scenarios/${id}`, { method: "DELETE" });
      fetchScenarios();
    } catch (e) {
      console.error("Failed to delete:", e);
    }
  };

  const totalPages = Math.ceil(total / pageSize);

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      <AppHeader />
      <div className="mx-auto max-w-6xl px-6 py-8">
        {/* Page Header */}
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-2xl font-bold">Scenarios</h1>
          <div className="flex gap-3">
            <Link
              href="/recorder"
              className="rounded-lg bg-blue-600 px-4 py-2 hover:bg-blue-500"
            >
              + Record New
            </Link>
            <Link
              href="/editor"
              className="rounded-lg bg-gray-700 px-4 py-2 hover:bg-gray-600"
            >
              + Create Blank
            </Link>
          </div>
        </div>

        {/* Filters */}
        <div className="mb-6 flex flex-wrap items-center gap-4">
          <form onSubmit={handleSearch} className="flex-1">
            <input
              type="text"
              placeholder="Search scenarios..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full max-w-md rounded bg-gray-800 px-4 py-2 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </form>

          <div className="flex gap-2">
            <button
              className={`rounded px-3 py-1 ${filter === "all" ? "bg-blue-600" : "bg-gray-700"}`}
              onClick={() => { setFilter("all"); setPage(1); }}
            >
              All
            </button>
            <button
              className={`rounded px-3 py-1 ${filter === "favorites" ? "bg-blue-600" : "bg-gray-700"}`}
              onClick={() => { setFilter("favorites"); setPage(1); }}
            >
              ★ Favorites
            </button>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="mb-4 rounded bg-red-900/50 p-3 text-red-300">{error}</div>
        )}

        {/* Loading */}
        {loading ? (
          <div className="text-center text-gray-400">Loading...</div>
        ) : scenarios.length === 0 ? (
          <div className="rounded-lg border-2 border-dashed border-gray-700 p-12 text-center">
            <p className="mb-4 text-gray-400">No scenarios found</p>
            <Link
              href="/recorder"
              className="inline-block rounded bg-blue-600 px-6 py-3 hover:bg-blue-500"
            >
              Record your first scenario
            </Link>
          </div>
        ) : (
          <>
            {/* Scenarios grid */}
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {scenarios.map((scenario) => (
                <div
                  key={scenario.id}
                  className="group rounded-lg bg-gray-800 p-4 transition hover:bg-gray-750"
                >
                  <div className="mb-2 flex items-start justify-between">
                    <Link
                      href={`/editor?scenario=${scenario.id}`}
                      className="text-lg font-medium hover:text-blue-400"
                    >
                      {scenario.name}
                    </Link>
                    <button
                      className={`text-xl ${scenario.isFavorite ? "text-yellow-400" : "text-gray-600 hover:text-yellow-400"}`}
                      onClick={() => toggleFavorite(scenario.id, scenario.isFavorite)}
                    >
                      ★
                    </button>
                  </div>

                  <div className="mb-3 text-sm text-gray-400">
                    {scenario.nodeCount !== undefined && (
                      <span>{scenario.nodeCount} steps • </span>
                    )}
                    Updated {new Date(scenario.updatedAt).toLocaleDateString()}
                  </div>

                  <div className="flex gap-2 opacity-0 transition group-hover:opacity-100">
                    <Link
                      href={`/editor?scenario=${scenario.id}`}
                      className="rounded bg-gray-700 px-2 py-1 text-xs hover:bg-gray-600"
                    >
                      Edit
                    </Link>
                    <Link
                      href={`/scenarios/${scenario.id}`}
                      className="rounded bg-gray-700 px-2 py-1 text-xs hover:bg-gray-600"
                    >
                      Details
                    </Link>
                    <button
                      className="rounded bg-red-900/50 px-2 py-1 text-xs text-red-300 hover:bg-red-900"
                      onClick={() => deleteScenario(scenario.id)}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="mt-6 flex items-center justify-center gap-2">
                <button
                  className="rounded bg-gray-700 px-3 py-1 disabled:opacity-50"
                  disabled={page <= 1}
                  onClick={() => setPage(page - 1)}
                >
                  ← Prev
                </button>
                <span className="px-4 text-gray-400">
                  Page {page} of {totalPages}
                </span>
                <button
                  className="rounded bg-gray-700 px-3 py-1 disabled:opacity-50"
                  disabled={page >= totalPages}
                  onClick={() => setPage(page + 1)}
                >
                  Next →
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
