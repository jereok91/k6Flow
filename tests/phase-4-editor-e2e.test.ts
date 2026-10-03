/**
 * K6F4-06: End-to-end test for Phase 4 editor wiring.
 *
 * This test exercises the full stack with real Docker containers:
 * 1. Admin login (via seed)
 * 2. Create scenario with valid graph
 * 3. Read scenario back
 * 4. Update scenario
 * 5. Delete scenario
 *
 * Authorization: Phase 4 e2e (2026-10-03), mirrors the Phase 0 compose test pattern.
 * Run with: pnpm test tests/phase-4-editor-e2e.test.ts
 * Requires: docker compose up -d (db + web)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync, spawn, type ChildProcess } from "node:child_process";

const WEB_URL = process.env.WEB_URL ?? "http://localhost:3000";
const ADMIN_USERNAME = "e2e-admin";
const ADMIN_PASSWORD = "e2e-admin-password-12345";

// Test timeout for Docker operations
const DOCKER_TIMEOUT = 60_000;

describe("Phase 4 Editor E2E", () => {
  let sessionCookie: string | null = null;
  let createdScenarioId: number | null = null;

  // Check if web service is available
  beforeAll(async () => {
    // Quick healthcheck
    try {
      const res = await fetch(`${WEB_URL}/api/healthz`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) {
        console.log("Web service not available, skipping e2e tests");
        return;
      }
    } catch {
      console.log("Web service not available, skipping e2e tests");
      return;
    }
  }, DOCKER_TIMEOUT);

  it("should login with admin credentials", async () => {
    // First, try to seed the admin user
    // Note: In real e2e, seed would be run before the test suite
    // For now, we assume the admin user exists or was seeded

    const res = await fetch(`${WEB_URL}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: ADMIN_USERNAME,
        password: ADMIN_PASSWORD,
      }),
    });

    // If login fails (no user seeded), skip remaining tests
    if (res.status === 401) {
      console.log("Admin user not seeded, run: ADMIN_USERNAME=e2e-admin ADMIN_PASSWORD=e2e-admin-password-12345 pnpm --filter @k6flow/web seed");
      expect.soft(res.status).toBe(200);
      return;
    }

    expect(res.status).toBe(200);

    // Extract session cookie
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toBeTruthy();
    sessionCookie = setCookie!.split(";")[0];
    expect(sessionCookie).toContain("k6flow_session=");
  });

  it("should create a scenario with valid graph", async () => {
    if (!sessionCookie) {
      console.log("Skipping: no session cookie");
      return;
    }

    const validGraph = {
      nodes: [
        {
          id: "node-1",
          kind: "http-request",
          label: "GET Users",
          references: [],
          parameters: {
            method: "GET",
            url: { kind: "literal", value: "https://api.example.com/users" },
          },
        },
      ],
      edges: [],
    };

    const res = await fetch(`${WEB_URL}/api/scenarios`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: sessionCookie,
      },
      body: JSON.stringify({
        name: "E2E Test Scenario",
        graph: validGraph,
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBeTypeOf("number");
    createdScenarioId = body.id;
  });

  it("should read back the created scenario", async () => {
    if (!sessionCookie || !createdScenarioId) {
      console.log("Skipping: no session or scenario");
      return;
    }

    const res = await fetch(`${WEB_URL}/api/scenarios/${createdScenarioId}`, {
      headers: { Cookie: sessionCookie },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(createdScenarioId);
    expect(body.name).toBe("E2E Test Scenario");
    expect(body.graph.nodes).toHaveLength(1);
    expect(body.graph.nodes[0].kind).toBe("http-request");
    expect(body.graph.edges).toHaveLength(0);
  });

  it("should update the scenario", async () => {
    if (!sessionCookie || !createdScenarioId) {
      console.log("Skipping: no session or scenario");
      return;
    }

    const updatedGraph = {
      nodes: [
        {
          id: "node-1",
          kind: "http-request",
          label: "GET Users Updated",
          references: [],
          parameters: {
            method: "POST",
            url: { kind: "literal", value: "https://api.example.com/users/create" },
          },
        },
        {
          id: "node-2",
          kind: "response-validation",
          label: "Check Status",
          references: [{ node: "node-1", output: "response" }],
          parameters: {
            version: "1.0",
            response: { node: "node-1", output: "response" },
            checks: [{ kind: "status", name: "is-200", operator: "eq", expected: 200 }],
            onCheckFailure: "record-failure-and-continue",
          },
        },
      ],
      edges: [{ source: "node-1", target: "node-2" }],
    };

    const res = await fetch(`${WEB_URL}/api/scenarios/${createdScenarioId}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Cookie: sessionCookie,
      },
      body: JSON.stringify({
        name: "E2E Test Scenario Updated",
        graph: updatedGraph,
      }),
    });

    expect(res.status).toBe(200);

    // Verify the update
    const getRes = await fetch(`${WEB_URL}/api/scenarios/${createdScenarioId}`, {
      headers: { Cookie: sessionCookie },
    });
    const body = await getRes.json();
    expect(body.name).toBe("E2E Test Scenario Updated");
    expect(body.graph.nodes).toHaveLength(2);
    expect(body.graph.edges).toHaveLength(1);
  });

  it("should list scenarios including the created one", async () => {
    if (!sessionCookie || !createdScenarioId) {
      console.log("Skipping: no session or scenario");
      return;
    }

    const res = await fetch(`${WEB_URL}/api/scenarios`, {
      headers: { Cookie: sessionCookie },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    const found = body.find((s: { id: number }) => s.id === createdScenarioId);
    expect(found).toBeTruthy();
    expect(found.name).toBe("E2E Test Scenario Updated");
  });

  it("should reject invalid graph", async () => {
    if (!sessionCookie) {
      console.log("Skipping: no session cookie");
      return;
    }

    const invalidGraph = {
      nodes: [
        {
          id: "node-1",
          kind: "invalid-kind", // Invalid node kind
          label: "Bad Node",
          references: [],
          parameters: {},
        },
      ],
      edges: [],
    };

    const res = await fetch(`${WEB_URL}/api/scenarios`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: sessionCookie,
      },
      body: JSON.stringify({
        name: "Invalid Scenario",
        graph: invalidGraph,
      }),
    });

    expect(res.status).toBe(422);
  });

  it("should delete the scenario", async () => {
    if (!sessionCookie || !createdScenarioId) {
      console.log("Skipping: no session or scenario");
      return;
    }

    const res = await fetch(`${WEB_URL}/api/scenarios/${createdScenarioId}`, {
      method: "DELETE",
      headers: { Cookie: sessionCookie },
    });

    expect(res.status).toBe(204);

    // Verify deletion
    const getRes = await fetch(`${WEB_URL}/api/scenarios/${createdScenarioId}`, {
      headers: { Cookie: sessionCookie },
    });
    expect(getRes.status).toBe(404);
  });

  it("should logout", async () => {
    if (!sessionCookie) {
      console.log("Skipping: no session cookie");
      return;
    }

    const res = await fetch(`${WEB_URL}/api/auth/logout`, {
      method: "POST",
      headers: { Cookie: sessionCookie },
    });

    expect(res.status).toBe(200);

    // Verify session is invalidated
    const meRes = await fetch(`${WEB_URL}/api/auth/me`, {
      headers: { Cookie: sessionCookie },
    });
    expect(meRes.status).toBe(401);
  });
});
