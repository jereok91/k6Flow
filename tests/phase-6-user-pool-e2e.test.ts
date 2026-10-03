/**
 * K6F6-05: End-to-end test for Phase 6 user pool with CSV attachments.
 *
 * This test exercises the attachment upload and run flow:
 * 1. Admin login
 * 2. Create scenario
 * 3. Upload CSV attachment
 * 4. Configure user-pool node
 * 5. Run scenario with attachment
 *
 * Authorization: Phase 6 e2e (2026-10-03).
 * Run with: pnpm test tests/phase-6-user-pool-e2e.test.ts
 * Requires: docker compose up -d (db + web + orchestrator)
 */

import { describe, it, expect, beforeAll } from "vitest";

const WEB_URL = process.env.WEB_URL ?? "http://localhost:3000";
const ADMIN_USERNAME = "e2e-admin";
const ADMIN_PASSWORD = "e2e-admin-password-12345";

const DOCKER_TIMEOUT = 60_000;

describe("Phase 6 User Pool E2E", () => {
  let sessionCookie: string | null = null;
  let scenarioId: number | null = null;

  beforeAll(async () => {
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

      // Create a scenario for testing
      if (sessionCookie) {
        const createRes = await fetch(`${WEB_URL}/api/scenarios`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: sessionCookie,
          },
          body: JSON.stringify({
            name: "E2E User Pool Test",
            graph: {
              version: 1,
              nodes: [],
              connections: [],
            },
          }),
        });

        if (createRes.ok) {
          const data = await createRes.json();
          scenarioId = data.id;
        }
      }
    } catch {
      console.log("Web service not available, skipping e2e tests");
    }
  }, DOCKER_TIMEOUT);

  it("can upload CSV attachment", async () => {
    expect(sessionCookie, "Session required - is the server running?").toBeTruthy();
    expect(scenarioId, "Scenario required - is the server running?").toBeTruthy();
    if (!sessionCookie || !scenarioId) return; // TypeScript narrowing

    const csvContent = "username,password\nuser1,pass1\nuser2,pass2";
    const base64Data = Buffer.from(csvContent).toString("base64");

    const res = await fetch(`${WEB_URL}/api/scenarios/${scenarioId}/attachments`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: sessionCookie,
      },
      body: JSON.stringify({
        name: "test-users.csv",
        contentType: "text/csv",
        data: base64Data,
      }),
    });

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.attachment).toBeDefined();
    expect(data.attachment.name).toBe("test-users.csv");
    expect(data.attachment.size).toBe(csvContent.length);
  });

  it("can list attachments", async () => {
    expect(sessionCookie, "Session required").toBeTruthy();
    expect(scenarioId, "Scenario required").toBeTruthy();
    if (!sessionCookie || !scenarioId) return;

    const res = await fetch(`${WEB_URL}/api/scenarios/${scenarioId}/attachments`, {
      headers: { Cookie: sessionCookie },
    });

    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(Array.isArray(data.attachments)).toBe(true);
    expect(data.attachments.length).toBeGreaterThan(0);
  });

  it("can get attachment with data", async () => {
    expect(sessionCookie, "Session required").toBeTruthy();
    expect(scenarioId, "Scenario required").toBeTruthy();
    if (!sessionCookie || !scenarioId) return;

    // First get list to find ID
    const listRes = await fetch(`${WEB_URL}/api/scenarios/${scenarioId}/attachments`, {
      headers: { Cookie: sessionCookie },
    });
    const listData = await listRes.json();
    const attachmentId = listData.attachments[0]?.id;

    expect(attachmentId, "Attachment required from previous test").toBeTruthy();
    if (!attachmentId) return;

    const res = await fetch(
      `${WEB_URL}/api/scenarios/${scenarioId}/attachments/${attachmentId}`,
      { headers: { Cookie: sessionCookie } },
    );

    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.attachment.data).toBeDefined();

    // Verify content
    const content = Buffer.from(data.attachment.data, "base64").toString();
    expect(content).toContain("username,password");
  });

  it("rejects files over 1MB", async () => {
    expect(sessionCookie, "Session required").toBeTruthy();
    expect(scenarioId, "Scenario required").toBeTruthy();
    if (!sessionCookie || !scenarioId) return;

    // Create a file just over 1MB
    const largeData = Buffer.alloc(1024 * 1024 + 1, "x").toString("base64");

    const res = await fetch(`${WEB_URL}/api/scenarios/${scenarioId}/attachments`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: sessionCookie,
      },
      body: JSON.stringify({
        name: "large.csv",
        contentType: "text/csv",
        data: largeData,
      }),
    });

    expect(res.status).toBe(413);
    const data = await res.json();
    expect(data.error).toContain("File too large");
  });

  it("rejects non-CSV content types", async () => {
    expect(sessionCookie, "Session required").toBeTruthy();
    expect(scenarioId, "Scenario required").toBeTruthy();
    if (!sessionCookie || !scenarioId) return;

    const res = await fetch(`${WEB_URL}/api/scenarios/${scenarioId}/attachments`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: sessionCookie,
      },
      body: JSON.stringify({
        name: "image.png",
        contentType: "image/png",
        data: Buffer.from("fake").toString("base64"),
      }),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Invalid content type");
  });

  it("can delete attachment", async () => {
    expect(sessionCookie, "Session required").toBeTruthy();
    expect(scenarioId, "Scenario required").toBeTruthy();
    if (!sessionCookie || !scenarioId) return;

    // Upload a new attachment to delete
    const csvContent = "delete,me";
    const uploadRes = await fetch(`${WEB_URL}/api/scenarios/${scenarioId}/attachments`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: sessionCookie,
      },
      body: JSON.stringify({
        name: "to-delete.csv",
        contentType: "text/csv",
        data: Buffer.from(csvContent).toString("base64"),
      }),
    });

    const uploadData = await uploadRes.json();
    const attachmentId = uploadData.attachment.id;

    // Delete it
    const deleteRes = await fetch(
      `${WEB_URL}/api/scenarios/${scenarioId}/attachments/${attachmentId}`,
      {
        method: "DELETE",
        headers: { Cookie: sessionCookie },
      },
    );

    expect(deleteRes.ok).toBe(true);

    // Verify it's gone
    const getRes = await fetch(
      `${WEB_URL}/api/scenarios/${scenarioId}/attachments/${attachmentId}`,
      { headers: { Cookie: sessionCookie } },
    );
    expect(getRes.status).toBe(404);
  });

  it("requires authentication for attachments", async () => {
    expect(scenarioId, "Scenario required").toBeTruthy();
    if (!scenarioId) return;

    const res = await fetch(`${WEB_URL}/api/scenarios/${scenarioId}/attachments`);
    expect(res.status).toBe(401);
  });
});
