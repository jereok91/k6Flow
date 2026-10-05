"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { MainLayout } from "../../lib/layout";

interface Recording {
  id: string;
  name: string;
  targetUrl: string;
  createdAt: string;
  stepCount: number;
  scenarioId: string | null;
}

interface RecordingsResponse {
  recordings: Recording[];
  total: number;
  page: number;
  pageSize: number;
}

export default function RecordingsPage() {
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const pageSize = 20;

  const fetchRecordings = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({
        page: page.toString(),
        pageSize: pageSize.toString(),
        ...(search && { search }),
      });

      const res = await fetch(`/api/recordings?${params}`);
      if (!res.ok) {
        throw new Error("Failed to load recordings");
      }

      const data: RecordingsResponse = await res.json();
      setRecordings(data.recordings);
      setTotal(data.total);
    } catch {
      setError("Error cargando grabaciones");
    } finally {
      setLoading(false);
    }
  }, [page, search]);

  useEffect(() => {
    fetchRecordings();
  }, [fetchRecordings]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    fetchRecordings();
  };

  const totalPages = Math.ceil(total / pageSize);

  return (
    <MainLayout>
      <div className="px-gutter-desktop py-space-xl flex flex-col gap-space-xl">
        {/* Header */}
        <section className="flex flex-col md:flex-row md:items-end justify-between gap-space-lg">
          <div className="flex flex-col gap-space-xs">
            <div className="flex items-center gap-space-sm text-label-code-sm text-on-surface-variant uppercase tracking-wider">
              <span className="material-symbols-outlined text-secondary text-[16px]">videocam</span>
              <span>Sesiones capturadas</span>
            </div>
            <h1 className="text-headline-lg text-on-surface font-semibold tracking-tight">
              Grabaciones
            </h1>
            <p className="text-body-md text-on-surface-variant">
              {total} grabación{total !== 1 ? "es" : ""} disponible{total !== 1 ? "s" : ""}
            </p>
          </div>

          <Link href="/recorder" className="btn-primary">
            <span className="material-symbols-outlined text-[18px]">fiber_manual_record</span>
            <span>Nueva grabación</span>
          </Link>
        </section>

        {/* Search */}
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
                placeholder="Buscar grabaciones..."
              />
            </div>
          </form>
        </section>

        {/* Content */}
        {error ? (
          <div className="card text-center">
            <span className="material-symbols-outlined text-error text-[32px] mb-space-md">error</span>
            <p className="text-body-md text-error">{error}</p>
            <button
              type="button"
              onClick={fetchRecordings}
              className="btn-secondary mt-space-md mx-auto"
            >
              Reintentar
            </button>
          </div>
        ) : loading ? (
          <div className="card text-center py-space-xl">
            <div className="animate-spin w-8 h-8 border-2 border-secondary border-t-transparent rounded-full mx-auto" />
            <p className="text-body-md text-on-surface-variant mt-space-md">Cargando grabaciones...</p>
          </div>
        ) : recordings.length === 0 ? (
          <div className="card text-center py-space-xl">
            <span className="material-symbols-outlined text-on-surface-variant text-[48px] mb-space-md">
              videocam_off
            </span>
            <h3 className="text-headline-sm text-on-surface font-medium mb-space-xs">
              No hay grabaciones
            </h3>
            <p className="text-body-md text-on-surface-variant mb-space-lg">
              {search
                ? "No se encontraron grabaciones con ese nombre"
                : "Graba tu primera sesión de navegador para crear escenarios automáticamente"}
            </p>
            <Link href="/recorder" className="btn-primary mx-auto">
              <span className="material-symbols-outlined text-[18px]">fiber_manual_record</span>
              <span>Iniciar grabación</span>
            </Link>
          </div>
        ) : (
          <>
            {/* Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-space-md">
              {recordings.map((recording) => (
                <Link
                  key={recording.id}
                  href={`/recorder/review?id=${recording.id}`}
                  className="card group"
                >
                  <div className="flex items-start justify-between mb-space-md">
                    <div className="w-10 h-10 rounded-lg bg-surface-container-high flex items-center justify-center text-secondary group-hover:bg-secondary-container group-hover:text-on-secondary-container transition-colors">
                      <span className="material-symbols-outlined text-[22px]">videocam</span>
                    </div>
                    {recording.scenarioId ? (
                      <span className="badge-success">
                        <span className="material-symbols-outlined text-[12px]">check</span>
                        Convertido
                      </span>
                    ) : (
                      <span className="px-2 py-0.5 rounded-lg bg-surface-container-high text-on-surface-variant text-label-code-sm">
                        Pendiente
                      </span>
                    )}
                  </div>

                  <h3 className="text-headline-sm text-on-surface font-medium mb-space-xs truncate">
                    {recording.name}
                  </h3>

                  <p className="text-label-code-sm text-on-surface-variant font-mono mb-space-md truncate">
                    {recording.targetUrl}
                  </p>

                  <div className="flex items-center justify-between text-label-code-sm text-on-surface-variant">
                    <div className="flex items-center gap-space-xs">
                      <span className="material-symbols-outlined text-[14px]">layers</span>
                      <span>{recording.stepCount} pasos</span>
                    </div>
                    <span className="font-mono">
                      {new Date(recording.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                </Link>
              ))}
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
