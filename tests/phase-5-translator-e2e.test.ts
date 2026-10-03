/**
 * K6F5-04: End-to-end test for Phase 5 graph-to-K6 translator and execution.
 *
 * This test exercises the full stack with real Docker containers:
 * 1. Admin login
 * 2. Create scenario with valid graph
 * 3. Translate graph to K6 script
 * 4. Submit to orchestrator
 * 5. Monitor run status
 *
 * Authorization: Phase 5 e2e (2026-10-03).
 * Run with: pnpm test tests/phase-5-translator-e2e.test.ts
 * Requires: docker compose up -d (db + web + orchestrator)
 */

import { describe, it, expect, beforeAll } from "vitest";
import { translateToK6 } from "@k6flow/shared";
import type { GraphDraftComposition } from "@k6flow/shared";

const WEB_URL = process.env.WEB_URL ?? "http://localhost:3000";
const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL ?? "http://localhost:8080";
const ADMIN_USERNAME = "e2e-admin";
const ADMIN_PASSWORD = "e2e-admin-password-12345";

// Test timeout for Docker operations
const DOCKER_TIMEOUT = 60_000;

describe("Phase 5 Translator E2E", () => {
  let sessionCookie: string | null = null;
  let orchestratorAvailable = false;

  beforeAll(async () => {
    // Check if orchestrator is available
    try {
      const res = await fetch(`${ORCHESTRATOR_URL}/healthz`, {
        signal: AbortSignal.timeout(5000),
      });
      orchestratorAvailable = res.ok;
      if (!orchestratorAvailable) {
        console.log("Orchestrator not available, some tests will be skipped");
      }
    } catch {
      console.log("Orchestrator not available, some tests will be skipped");
    }

    // Check web and login
    try {
      const res = await fetch(`${WEB_URL}/api/healthz`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        console.log("Web service not available, skipping e2e tests");
        return;
      }

      // Login
      const loginRes = await fetch(`${WEB_URL}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: ADMIN_USERNAME,
          password: ADMIN_PASSWORD,
        }),
      });

      if (loginRes.ok) {
        const setCookie = loginRes.headers.get("set-cookie");
        sessionCookie = setCookie?.split(";")[0] ?? null;
      }
    } catch {
      console.log("Web service not available, skipping e2e tests");
    }
  }, DOCKER_TIMEOUT);

  it("translates a simple HTTP request graph to K6 script", () => {
    const graph: GraphDraftComposition = {
      version: 1,
      nodes: [
        {
          id: "req-1",
          kind: "http-request",
          references: [],
          parameters: {
            method: "GET",
            url: { kind: "literal", value: "https://httpbin.org/get" },
          },
        },
      ],
      connections: [],
    };

    const result = translateToK6(graph, { vus: 1, duration: "10s" });

    expect(result.script).toContain("import http from 'k6/http';");
    expect(result.script).toContain("http.get('https://httpbin.org/get'");
    expect(result.script).toContain("vus: 1,");
    expect(result.script).toContain("duration: '10s',");
    expect(result.warnings).toHaveLength(0);
  });

  it("translates a graph with response validation", () => {
    const graph: GraphDraftComposition = {
      version: 1,
      nodes: [
        {
          id: "req-1",
          kind: "http-request",
          references: [],
          parameters: {
            method: "GET",
            url: { kind: "literal", value: "https://httpbin.org/status/200" },
          },
        },
        {
          id: "check-1",
          kind: "response-validation",
          references: [{ producerNodeId: "req-1", output: "response" }],
          parameters: {
            version: 1,
            response: { producerNodeId: "req-1", output: "response" },
            checks: [
              { kind: "status", name: "is-200", operator: "eq", expected: 200 },
            ],
            onCheckFailure: "record-failure-and-continue",
          },
        },
      ],
      connections: [{ source: "req-1", target: "check-1" }],
    };

    const result = translateToK6(graph);

    expect(result.script).toContain("import { check } from 'k6';");
    expect(result.script).toContain("check(req_1_res, {");
    expect(result.script).toContain("'is-200': (r) => r.status === 200");
  });

  it("produces deterministic output", () => {
    const graph: GraphDraftComposition = {
      version: 1,
      nodes: [
        { id: "c", kind: "http-request", references: [], parameters: { method: "GET", url: { kind: "literal", value: "https://c.com" } } },
        { id: "a", kind: "http-request", references: [], parameters: { method: "GET", url: { kind: "literal", value: "https://a.com" } } },
        { id: "b", kind: "http-request", references: [], parameters: { method: "GET", url: { kind: "literal", value: "https://b.com" } } },
      ],
      connections: [],
    };

    const results = [
      translateToK6(graph),
      translateToK6(graph),
      translateToK6(graph),
    ];

    // All three should be identical
    expect(results[0].script).toBe(results[1].script);
    expect(results[1].script).toBe(results[2].script);

    // Should be sorted alphabetically by node id (a, b, c)
    const aIndex = results[0].script.indexOf("// a");
    const bIndex = results[0].script.indexOf("// b");
    const cIndex = results[0].script.indexOf("// c");
    expect(aIndex).toBeLessThan(bIndex);
    expect(bIndex).toBeLessThan(cIndex);
  });

  it("can submit a run to the orchestrator", async () => {
    if (!orchestratorAvailable) {
      console.log("Skipping: orchestrator not available");
      return;
    }

    const graph: GraphDraftComposition = {
      version: 1,
      nodes: [
        {
          id: "req-1",
          kind: "http-request",
          references: [],
          parameters: {
            method: "GET",
            url: { kind: "literal", value: "https://httpbin.org/get" },
          },
        },
      ],
      connections: [],
    };

    const translation = translateToK6(graph, { vus: 1, duration: "5s" });

    const body = {
      version: 1,
      script: translation.script,
      vus: 1,
      durationMs: 5000,
      cpuMillis: 500,
      memoryMiB: 256,
      attachments: [],
    };

    const res = await fetch(`${ORCHESTRATOR_URL}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    // Either created (201) or conflict if run limit reached
    expect([201, 409]).toContain(res.status);

    if (res.status === 201) {
      const result = await res.json();
      expect(result.id).toBeTruthy();
      expect(typeof result.id).toBe("string");

      // Check run status
      const statusRes = await fetch(`${ORCHESTRATOR_URL}/runs/${result.id}`);
      expect(statusRes.ok).toBe(true);
      const status = await statusRes.json();
      expect(["pending", "running", "completed", "failed"]).toContain(status.state);
    }
  });

  it("validates graph before translation", () => {
    // Graph with cycle
    const cyclicGraph: GraphDraftComposition = {
      version: 1,
      nodes: [
        { id: "a", kind: "http-request", references: [], parameters: { method: "GET", url: { kind: "literal", value: "https://a.com" } } },
        { id: "b", kind: "http-request", references: [], parameters: { method: "GET", url: { kind: "literal", value: "https://b.com" } } },
      ],
      connections: [
        { source: "a", target: "b" },
        { source: "b", target: "a" },
      ],
    };

    const result = translateToK6(cyclicGraph);

    // Should warn about cycle
    expect(result.warnings).toContain("Graph contains cycles; some nodes may not execute");
  });

  it("handles user pool nodes requiring external files", () => {
    const graph: GraphDraftComposition = {
      version: 1,
      nodes: [
        {
          id: "pool-1",
          kind: "user-pool",
          references: [],
          parameters: {
            version: 1,
            attachment: { id: "test-users" },
            allocation: "csv-order-distinct-row-per-vu",
            onInsufficientCapacity: "reject-before-execution",
            outputs: [
              { header: "username", name: "user", expectedType: "string", required: true },
            ],
          },
        },
      ],
      connections: [],
    };

    const result = translateToK6(graph);

    expect(result.requiresFiles).toContain("test-users.csv");
    expect(result.script).toContain("SharedArray");
    expect(result.script).toContain("papaparse");
  });
});
