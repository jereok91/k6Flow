// Scenario list + create routes (authenticated users only).
// DB-backed paths proven in K6F4-06 real-stack e2e.

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../../../lib/db/client";
import { scenarios } from "../../../lib/db/schema";
import { requireUser } from "../../../lib/auth/require-user";
import { jsonError } from "../../../lib/auth/http";
import { classifyCreateScenario } from "./logic";

// GET /api/scenarios — list scenarios (owner sees own, admin sees all)
export async function GET(request: Request): Promise<Response> {
  const cookieHeader = request.headers.get("cookie");
  const user = await requireUser(cookieHeader);
  if (user === null) {
    return jsonError(401, "Unauthorized");
  }

  try {
    const db = getDb();
    let rows;
    if (user.role === "admin") {
      rows = await db.select().from(scenarios).orderBy(scenarios.createdAt);
    } else {
      rows = await db
        .select()
        .from(scenarios)
        .where(eq(scenarios.ownerId, user.id))
        .orderBy(scenarios.createdAt);
    }

    // Return scenarios without full graph in list (just metadata)
    const list = rows.map((row) => ({
      id: row.id,
      name: row.name,
      ownerId: row.ownerId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));

    return Response.json({ scenarios: list }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return jsonError(500, "Internal server error");
  }
}

// POST /api/scenarios — create scenario
export async function POST(request: Request): Promise<Response> {
  const cookieHeader = request.headers.get("cookie");
  const user = await requireUser(cookieHeader);
  if (user === null) {
    return jsonError(401, "Unauthorized");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "Invalid JSON");
  }

  const classified = classifyCreateScenario(body);
  if (!classified.ok) {
    const status = classified.reason === "invalid-graph" ? 422 : 400;
    return jsonError(status, classified.message);
  }

  try {
    const db = getDb();
    const id = randomUUID();
    const now = new Date();

    await db.insert(scenarios).values({
      id,
      ownerId: user.id,
      name: classified.name,
      graph: classified.graph,
      createdAt: now,
      updatedAt: now,
    });

    return Response.json(
      { id, name: classified.name, ownerId: user.id },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return jsonError(500, "Internal server error");
  }
}
