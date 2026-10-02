"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function Home() {
  const router = useRouter();
  const [runId, setRunId] = useState("");

  function openMetrics(event: React.FormEvent) {
    event.preventDefault();
    const id = runId.trim();
    if (id) router.push(`/runs/${encodeURIComponent(id)}`);
  }

  return (
    <main style={{ maxWidth: "48rem", margin: "0 auto", padding: "4rem 2rem" }}>
      <h1>K6Flow</h1>
      <p>
        Scenario editing, recording, and user accounts are not available yet.
        Live metrics for a running test are.
      </p>
      <section style={{ marginTop: "2rem" }}>
        <h2>Live metrics</h2>
        <p>Open the live dashboard for a run by id:</p>
        <form onSubmit={openMetrics} style={{ display: "flex", gap: "0.5rem" }}>
          <input
            value={runId}
            onChange={(event) => setRunId(event.target.value)}
            placeholder="runId"
            aria-label="runId"
            style={{ flex: 1, padding: "0.5rem" }}
          />
          <button type="submit">Open dashboard</button>
        </form>
      </section>
    </main>
  );
}
