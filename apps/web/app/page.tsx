"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

interface Scenario {
  id: string;
  name: string;
  nodeCount?: number;
  updatedAt: string;
}

interface Recording {
  id: string;
  name: string;
  state: string;
  stepCount: number | null;
  createdAt: string;
}

export default function Home() {
  const router = useRouter();
  const [runId, setRunId] = useState("");
  const [user, setUser] = useState<{ username: string; role: string } | null>(null);
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [recentScenarios, setRecentScenarios] = useState<Scenario[]>([]);
  const [recentRecordings, setRecentRecordings] = useState<Recording[]>([]);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        setUser(data);
        if (data) {
          // Load recent data
          fetch("/api/scenarios?pageSize=5")
            .then((r) => r.ok ? r.json() : { scenarios: [] })
            .then((d) => setRecentScenarios(d.scenarios || []));
          fetch("/api/recordings?pageSize=5")
            .then((r) => r.ok ? r.json() : { recordings: [] })
            .then((d) => setRecentRecordings(d.recordings || []));
        }
      })
      .catch(() => setUser(null))
      .finally(() => setCheckingAuth(false));
  }, []);

  function openMetrics(event: React.FormEvent) {
    event.preventDefault();
    const id = runId.trim();
    if (id) router.push(`/runs/${encodeURIComponent(id)}`);
  }

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    setUser(null);
    setRecentScenarios([]);
    setRecentRecordings([]);
  }

  if (checkingAuth) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-900 text-white">
        Loading...
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      {/* Header */}
      <header className="border-b border-gray-800 bg-gray-900/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <Link href="/" className="text-xl font-bold text-white">
            K6Flow
          </Link>
          <nav className="flex items-center gap-6">
            {user ? (
              <>
                <Link href="/scenarios" className="text-gray-300 hover:text-white">
                  Scenarios
                </Link>
                <Link href="/recordings" className="text-gray-300 hover:text-white">
                  Recordings
                </Link>
                <Link href="/editor" className="text-gray-300 hover:text-white">
                  Editor
                </Link>
                <Link href="/recorder" className="text-gray-300 hover:text-white">
                  Recorder
                </Link>
                <span className="text-gray-500">|</span>
                <span className="text-gray-400">{user.username}</span>
                <button
                  onClick={handleLogout}
                  className="text-gray-400 hover:text-white"
                >
                  Logout
                </button>
              </>
            ) : (
              <Link
                href="/login"
                className="rounded-lg bg-blue-600 px-4 py-2 text-white hover:bg-blue-500"
              >
                Sign in
              </Link>
            )}
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-8">
        {user ? (
          <>
            {/* Quick Actions */}
            <section className="mb-12">
              <h2 className="mb-6 text-2xl font-bold">Quick Actions</h2>
              <div className="grid gap-6 md:grid-cols-3">
                {/* Record */}
                <Link
                  href="/recorder"
                  className="group rounded-xl border border-gray-700 bg-gray-800 p-6 transition hover:border-blue-500 hover:bg-gray-750"
                >
                  <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-red-600 text-2xl">
                    🎬
                  </div>
                  <h3 className="mb-2 text-lg font-semibold group-hover:text-blue-400">
                    Record Session
                  </h3>
                  <p className="text-sm text-gray-400">
                    Record browser interactions to create load test scenarios automatically
                  </p>
                </Link>

                {/* Create Scenario */}
                <Link
                  href="/editor"
                  className="group rounded-xl border border-gray-700 bg-gray-800 p-6 transition hover:border-blue-500 hover:bg-gray-750"
                >
                  <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-blue-600 text-2xl">
                    ✏️
                  </div>
                  <h3 className="mb-2 text-lg font-semibold group-hover:text-blue-400">
                    Create Scenario
                  </h3>
                  <p className="text-sm text-gray-400">
                    Build load test scenarios visually with the drag-and-drop editor
                  </p>
                </Link>

                {/* View Library */}
                <Link
                  href="/scenarios"
                  className="group rounded-xl border border-gray-700 bg-gray-800 p-6 transition hover:border-blue-500 hover:bg-gray-750"
                >
                  <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-green-600 text-2xl">
                    📚
                  </div>
                  <h3 className="mb-2 text-lg font-semibold group-hover:text-blue-400">
                    View Library
                  </h3>
                  <p className="text-sm text-gray-400">
                    Browse, search, and manage your test scenarios
                  </p>
                </Link>
              </div>
            </section>

            {/* Recent Activity */}
            <div className="grid gap-8 lg:grid-cols-2">
              {/* Recent Scenarios */}
              <section>
                <div className="mb-4 flex items-center justify-between">
                  <h2 className="text-lg font-semibold">Recent Scenarios</h2>
                  <Link href="/scenarios" className="text-sm text-blue-400 hover:underline">
                    View all →
                  </Link>
                </div>
                <div className="rounded-xl border border-gray-700 bg-gray-800">
                  {recentScenarios.length === 0 ? (
                    <div className="p-6 text-center text-gray-500">
                      No scenarios yet.{" "}
                      <Link href="/recorder" className="text-blue-400 hover:underline">
                        Record your first
                      </Link>
                    </div>
                  ) : (
                    <ul className="divide-y divide-gray-700">
                      {recentScenarios.map((s) => (
                        <li key={s.id}>
                          <Link
                            href={`/scenarios/${s.id}`}
                            className="flex items-center justify-between p-4 hover:bg-gray-750"
                          >
                            <div>
                              <div className="font-medium">{s.name}</div>
                              <div className="text-sm text-gray-500">
                                {s.nodeCount || 0} steps
                              </div>
                            </div>
                            <div className="text-sm text-gray-500">
                              {new Date(s.updatedAt).toLocaleDateString()}
                            </div>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </section>

              {/* Recent Recordings */}
              <section>
                <div className="mb-4 flex items-center justify-between">
                  <h2 className="text-lg font-semibold">Recent Recordings</h2>
                  <Link href="/recordings" className="text-sm text-blue-400 hover:underline">
                    View all →
                  </Link>
                </div>
                <div className="rounded-xl border border-gray-700 bg-gray-800">
                  {recentRecordings.length === 0 ? (
                    <div className="p-6 text-center text-gray-500">
                      No recordings yet.{" "}
                      <Link href="/recorder" className="text-blue-400 hover:underline">
                        Start recording
                      </Link>
                    </div>
                  ) : (
                    <ul className="divide-y divide-gray-700">
                      {recentRecordings.map((r) => (
                        <li key={r.id}>
                          <Link
                            href={r.state === "completed" ? `/recorder/review?id=${r.id}` : `/recordings`}
                            className="flex items-center justify-between p-4 hover:bg-gray-750"
                          >
                            <div>
                              <div className="font-medium">{r.name}</div>
                              <div className="text-sm text-gray-500">
                                {r.stepCount || 0} steps • {r.state}
                              </div>
                            </div>
                            <div className="text-sm text-gray-500">
                              {new Date(r.createdAt).toLocaleDateString()}
                            </div>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </section>
            </div>

            {/* Live Metrics */}
            <section className="mt-12 rounded-xl border border-gray-700 bg-gray-800 p-6">
              <h2 className="mb-4 text-lg font-semibold">Live Metrics</h2>
              <p className="mb-4 text-sm text-gray-400">
                Monitor a running test by entering its Run ID:
              </p>
              <form onSubmit={openMetrics} className="flex gap-3">
                <input
                  value={runId}
                  onChange={(e) => setRunId(e.target.value)}
                  placeholder="Run ID"
                  className="flex-1 rounded-lg border border-gray-600 bg-gray-700 px-4 py-2 text-white placeholder-gray-500 focus:border-blue-500 focus:outline-none"
                />
                <button
                  type="submit"
                  className="rounded-lg bg-blue-600 px-6 py-2 font-medium hover:bg-blue-500"
                >
                  Open Dashboard
                </button>
              </form>
            </section>
          </>
        ) : (
          /* Guest view */
          <section className="py-20 text-center">
            <h1 className="mb-6 text-5xl font-bold">Visual Load Testing</h1>
            <p className="mx-auto mb-8 max-w-2xl text-xl text-gray-400">
              Record browser sessions, design load test scenarios visually, and
              execute K6 performance tests with real-time metrics.
            </p>
            <div className="flex justify-center gap-4">
              <Link
                href="/login"
                className="rounded-lg bg-blue-600 px-8 py-3 text-lg font-medium hover:bg-blue-500"
              >
                Get Started
              </Link>
              <a
                href="https://github.com/your-repo/k6flow"
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-lg border border-gray-600 px-8 py-3 text-lg font-medium hover:bg-gray-800"
              >
                Learn More
              </a>
            </div>

            {/* Features */}
            <div className="mt-20 grid gap-8 text-left md:grid-cols-3">
              <div className="rounded-xl border border-gray-700 bg-gray-800 p-6">
                <div className="mb-4 text-4xl">🎬</div>
                <h3 className="mb-2 text-lg font-semibold">Browser Recording</h3>
                <p className="text-gray-400">
                  Record real browser interactions and convert them to load test scenarios automatically.
                </p>
              </div>
              <div className="rounded-xl border border-gray-700 bg-gray-800 p-6">
                <div className="mb-4 text-4xl">✏️</div>
                <h3 className="mb-2 text-lg font-semibold">Visual Editor</h3>
                <p className="text-gray-400">
                  Design and modify scenarios with a drag-and-drop flow editor. No coding required.
                </p>
              </div>
              <div className="rounded-xl border border-gray-700 bg-gray-800 p-6">
                <div className="mb-4 text-4xl">📊</div>
                <h3 className="mb-2 text-lg font-semibold">Live Metrics</h3>
                <p className="text-gray-400">
                  Monitor K6 test execution in real-time with live charts and performance metrics.
                </p>
              </div>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
