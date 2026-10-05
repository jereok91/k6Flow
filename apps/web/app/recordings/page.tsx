"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";

interface Recording {
  id: string;
  name: string;
  startUrl: string;
  state: "recording" | "completed" | "failed" | "processing";
  durationMs: number | null;
  requestCount: number | null;
  stepCount: number | null;
  scenarioId: string | null;
  createdAt: string;
  completedAt: string | null;
}

interface RecordingsResponse {
  recordings: Recording[];
  total: number;
  page: number;
  pageSize: number;
}

const stateColors: Record<string, string> = {
  recording: "bg-red-500 animate-pulse",
  completed: "bg-green-600",
  failed: "bg-red-800",
  processing: "bg-yellow-600",
};

const stateLabels: Record<string, string> = {
  recording: "Recording",
  completed: "Completed",
  failed: "Failed",
  processing: "Processing",
};

function formatDuration(ms: number | null): string {
  if (!ms) return "-";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

export default function RecordingsPage() {
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [stateFilter, setStateFilter] = useState<string>("all");
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
        ...(stateFilter !== "all" && { state: stateFilter }),
      });

      const res = await fetch(`/api/recordings?${params}`);
      if (!res.ok) {
        throw new Error("Failed to load recordings");
      }

      const data: RecordingsResponse = await res.json();
      setRecordings(data.recordings);
      setTotal(data.total);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [page, search, stateFilter]);

  useEffect(() => {
    fetchRecordings();
  }, [fetchRecordings]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    fetchRecordings();
  };

  const deleteRecording = async (id: string) => {
    if (!confirm("Are you sure you want to delete this recording?")) return;

    try {
      await fetch(`/api/recordings/${id}`, { method: "DELETE" });
      fetchRecordings();
    } catch (e) {
      console.error("Failed to delete:", e);
    }
  };

  const totalPages = Math.ceil(total / pageSize);

  return (
    <div className="min-h-screen bg-gray-900 p-6 text-white">
      <div className="mx-auto max-w-6xl">
        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-2xl font-bold">Recordings</h1>
          <Link
            href="/recorder"
            className="rounded bg-blue-600 px-4 py-2 hover:bg-blue-500"
          >
            + New Recording
          </Link>
        </div>

        {/* Filters */}
        <div className="mb-6 flex flex-wrap items-center gap-4">
          <form onSubmit={handleSearch} className="flex-1">
            <input
              type="text"
              placeholder="Search recordings..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full max-w-md rounded bg-gray-800 px-4 py-2 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </form>

          <div className="flex gap-2">
            {["all", "completed", "recording", "failed"].map((state) => (
              <button
                key={state}
                className={`rounded px-3 py-1 capitalize ${stateFilter === state ? "bg-blue-600" : "bg-gray-700"}`}
                onClick={() => { setStateFilter(state); setPage(1); }}
              >
                {state === "all" ? "All" : stateLabels[state] || state}
              </button>
            ))}
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="mb-4 rounded bg-red-900/50 p-3 text-red-300">{error}</div>
        )}

        {/* Loading */}
        {loading ? (
          <div className="text-center text-gray-400">Loading...</div>
        ) : recordings.length === 0 ? (
          <div className="rounded-lg border-2 border-dashed border-gray-700 p-12 text-center">
            <p className="mb-4 text-gray-400">No recordings found</p>
            <Link
              href="/recorder"
              className="inline-block rounded bg-blue-600 px-6 py-3 hover:bg-blue-500"
            >
              Start your first recording
            </Link>
          </div>
        ) : (
          <>
            {/* Recordings table */}
            <div className="overflow-x-auto rounded-lg bg-gray-800">
              <table className="w-full">
                <thead className="border-b border-gray-700 text-left text-sm text-gray-400">
                  <tr>
                    <th className="px-4 py-3">Name</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Duration</th>
                    <th className="px-4 py-3">Requests</th>
                    <th className="px-4 py-3">Steps</th>
                    <th className="px-4 py-3">Scenario</th>
                    <th className="px-4 py-3">Date</th>
                    <th className="px-4 py-3">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {recordings.map((rec) => (
                    <tr
                      key={rec.id}
                      className="border-b border-gray-700/50 hover:bg-gray-750"
                    >
                      <td className="px-4 py-3">
                        <div>
                          <div className="font-medium">{rec.name}</div>
                          <div className="truncate text-sm text-gray-500" style={{ maxWidth: "200px" }}>
                            {rec.startUrl}
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-block rounded px-2 py-1 text-xs ${stateColors[rec.state]}`}>
                          {stateLabels[rec.state]}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-400">
                        {formatDuration(rec.durationMs)}
                      </td>
                      <td className="px-4 py-3 text-gray-400">
                        {rec.requestCount ?? "-"}
                      </td>
                      <td className="px-4 py-3 text-gray-400">
                        {rec.stepCount ?? "-"}
                      </td>
                      <td className="px-4 py-3">
                        {rec.scenarioId ? (
                          <Link
                            href={`/editor?scenario=${rec.scenarioId}`}
                            className="text-blue-400 hover:underline"
                          >
                            View
                          </Link>
                        ) : (
                          <span className="text-gray-500">-</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-400">
                        {new Date(rec.createdAt).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex gap-2">
                          {rec.state === "completed" && !rec.scenarioId && (
                            <Link
                              href={`/recorder/review?id=${rec.id}`}
                              className="rounded bg-blue-600 px-2 py-1 text-xs hover:bg-blue-500"
                            >
                              Review
                            </Link>
                          )}
                          <button
                            className="rounded bg-red-900/50 px-2 py-1 text-xs text-red-300 hover:bg-red-900"
                            onClick={() => deleteRecording(rec.id)}
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
