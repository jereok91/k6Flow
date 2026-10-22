"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { MainLayout } from "../../lib/layout";
import { scenarioEditorHref } from "../../lib/editor/editor-route-params";

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
    } catch {
      setError("Error cargando escenarios");
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

  const toggleFavorite = async (id: string, currentValue: number) => {
    try {
      await fetch(`/api/scenarios/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isFavorite: currentValue ? 0 : 1 }),
      });
      setScenarios((prev) =>
        prev.map((s) => (s.id === id ? { ...s, isFavorite: currentValue ? 0 : 1 } : s))
      );
    } catch {
      // Ignore
    }
  };

  const totalPages = Math.ceil(total / pageSize);

  return (
    <MainLayout>
      <div className="px-gutter-desktop py-space-xl flex flex-col gap-space-xl">
        {/* Header */}
        <section className="flex flex-col md:flex-row md:items-end justify-between gap-space-lg">
          <div className="flex flex-col gap-space-xs">
            <div className="flex items-center gap-space-sm text-label-code-sm text-on-surface-variant uppercase tracking-wider">
              <span className="material-symbols-outlined text-primary text-[16px]">account_tree</span>
              <span>Biblioteca de escenarios</span>
            </div>
            <h1 className="text-headline-lg text-on-surface font-semibold tracking-tight">
              Escenarios
            </h1>
            <p className="text-body-md text-on-surface-variant">
              {total} escenario{total !== 1 ? "s" : ""} guardado{total !== 1 ? "s" : ""}
            </p>
          </div>

          <div className="flex items-center gap-space-md">
            <Link href="/recorder" className="btn-secondary">
              <span className="material-symbols-outlined text-[18px]">videocam</span>
              <span>Grabar</span>
            </Link>
            <Link href="/editor" className="btn-primary">
              <span className="material-symbols-outlined text-[18px]">add</span>
              <span>Nuevo escenario</span>
            </Link>
          </div>
        </section>

        {/* Filters */}
        <section className="flex flex-wrap items-center gap-space-md">
          <form onSubmit={handleSearch} className="flex-1 min-w-[200px] max-w-md">
            <div className="relative flex items-center">
              <span className="material-symbols-outlined absolute left-space-md text-[18px] text-on-surface-variant">
                search
              </span>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="input pl-10"
                placeholder="Buscar escenarios..."
              />
            </div>
          </form>

          <div className="inline-flex p-1 bg-surface-container-low rounded-xl">
            <button
              type="button"
              onClick={() => setFilter("all")}
              className={`px-space-md py-1 rounded-lg text-body-sm transition-all ${
                filter === "all"
                  ? "bg-surface-container-high text-on-surface font-medium shadow-sm"
                  : "text-on-surface-variant hover:text-on-surface"
              }`}
            >
              Todos
            </button>
            <button
              type="button"
              onClick={() => setFilter("favorites")}
              className={`px-space-md py-1 rounded-lg text-body-sm transition-all ${
                filter === "favorites"
                  ? "bg-surface-container-high text-on-surface font-medium shadow-sm"
                  : "text-on-surface-variant hover:text-on-surface"
              }`}
            >
              <span className="material-symbols-outlined text-[16px] mr-1">star</span>
              Favoritos
            </button>
          </div>
        </section>

        {/* Content */}
        {error ? (
          <div className="card text-center">
            <span className="material-symbols-outlined text-error text-[32px] mb-space-md">error</span>
            <p className="text-body-md text-error">{error}</p>
            <button
              type="button"
              onClick={fetchScenarios}
              className="btn-secondary mt-space-md mx-auto"
            >
              Reintentar
            </button>
          </div>
        ) : loading ? (
          <div className="card text-center py-space-xl">
            <div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full mx-auto" />
            <p className="text-body-md text-on-surface-variant mt-space-md">Cargando escenarios...</p>
          </div>
        ) : scenarios.length === 0 ? (
          <div className="card text-center py-space-xl">
            <span className="material-symbols-outlined text-on-surface-variant text-[48px] mb-space-md">
              account_tree
            </span>
            <h3 className="text-headline-sm text-on-surface font-medium mb-space-xs">
              No hay escenarios
            </h3>
            <p className="text-body-md text-on-surface-variant mb-space-lg">
              {search
                ? "No se encontraron escenarios con ese nombre"
                : "Crea tu primer escenario o graba una sesión"}
            </p>
            <div className="flex justify-center gap-space-md">
              <Link href="/recorder" className="btn-secondary">
                <span className="material-symbols-outlined text-[18px]">videocam</span>
                <span>Grabar sesión</span>
              </Link>
              <Link href="/editor" className="btn-primary">
                <span className="material-symbols-outlined text-[18px]">add</span>
                <span>Crear escenario</span>
              </Link>
            </div>
          </div>
        ) : (
          <>
            {/* Table */}
            <div className="card p-0 overflow-hidden">
              <table className="w-full">
                <thead className="bg-surface-container-low">
                  <tr className="text-left text-label-code-sm text-on-surface-variant uppercase">
                    <th className="table-cell">Nombre</th>
                    <th className="table-cell w-24">Nodos</th>
                    <th className="table-cell w-32">Actualizado</th>
                    <th className="table-cell w-20 text-center">Favorito</th>
                    <th className="table-cell w-24">Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {scenarios.map((scenario) => (
                    <tr key={scenario.id} className="table-row">
                      <td className="table-cell">
                        <Link
                          href={`/scenarios/${scenario.id}`}
                          className="flex items-center gap-space-md hover:text-primary transition-colors"
                        >
                          <span className="material-symbols-outlined text-primary text-[18px]">
                            account_tree
                          </span>
                          <span className="text-on-surface font-medium">{scenario.name}</span>
                        </Link>
                      </td>
                      <td className="table-cell font-mono text-on-surface-variant">
                        {scenario.nodeCount ?? "-"}
                      </td>
                      <td className="table-cell font-mono text-on-surface-variant text-label-code-sm">
                        {new Date(scenario.updatedAt).toLocaleDateString()}
                      </td>
                      <td className="table-cell text-center">
                        <button
                          type="button"
                          onClick={() => toggleFavorite(scenario.id, scenario.isFavorite)}
                          className="p-space-xs hover:bg-surface-container rounded-lg transition-colors"
                        >
                          <span
                            className={`material-symbols-outlined text-[18px] ${
                              scenario.isFavorite ? "text-amber-400" : "text-on-surface-variant"
                            }`}
                            style={{
                              fontVariationSettings: scenario.isFavorite
                                ? "'FILL' 1"
                                : "'FILL' 0",
                            }}
                          >
                            star
                          </span>
                        </button>
                      </td>
                      <td className="table-cell">
                        <div className="flex items-center gap-space-xs">
                          <Link
                            href={scenarioEditorHref(scenario.id)}
                            className="p-space-xs hover:bg-surface-container rounded-lg transition-colors text-on-surface-variant hover:text-on-surface"
                            title="Editar"
                          >
                            <span className="material-symbols-outlined text-[18px]">edit</span>
                          </Link>
                          <Link
                            href={`/scenarios/${scenario.id}`}
                            className="p-space-xs hover:bg-surface-container rounded-lg transition-colors text-on-surface-variant hover:text-on-surface"
                            title="Ver detalles"
                          >
                            <span className="material-symbols-outlined text-[18px]">
                              visibility
                            </span>
                          </Link>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between">
                <span className="text-body-sm text-on-surface-variant">
                  Mostrando {(page - 1) * pageSize + 1}-
                  {Math.min(page * pageSize, total)} de {total}
                </span>
                <div className="flex items-center gap-space-xs">
                  <button
                    type="button"
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page === 1}
                    className="p-space-sm rounded-lg bg-surface-container-low hover:bg-surface-container disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    <span className="material-symbols-outlined text-[18px]">chevron_left</span>
                  </button>
                  <span className="text-body-sm text-on-surface px-space-md">
                    {page} / {totalPages}
                  </span>
                  <button
                    type="button"
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    disabled={page === totalPages}
                    className="p-space-sm rounded-lg bg-surface-container-low hover:bg-surface-container disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    <span className="material-symbols-outlined text-[18px]">chevron_right</span>
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </MainLayout>
  );
}
