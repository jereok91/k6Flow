// Scenario list + create routes (authenticated users only).
// DB-backed paths proven in K6F4-06 real-stack e2e.

import { randomUUID } from "node:crypto";
import { eq, and, like, desc, sql } from "drizzle-orm";
import { getDb } from "../../../lib/db/client";
import { scenarios } from "../../../lib/db/schema";
import { requireUser } from "../../../lib/auth/require-user";
import { jsonError } from "../../../lib/auth/http";
import { classifyCreateScenario } from "./logic";

// GET /api/scenarios — list scenarios with search, pagination, filters
export async function GET(request: Request): Promise<Response> {
  const cookieHeader = request.headers.get("cookie");
  const user = await requireUser(cookieHeader);
  if (user === null) {
    return jsonError(401, "Unauthorized");
  }

  try {
    const url = new URL(request.url);
    const search = url.searchParams.get("search") || "";
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get("pageSize") || "20", 10)));
    const favoritesOnly = url.searchParams.get("favorites") === "true";
    const offset = (page - 1) * pageSize;

    const db = getDb();

    // Build conditions
    const conditions = [];
    if (user.role !== "admin") {
      conditions.push(eq(scenarios.ownerId, user.id));
    }
    if (search) {
      conditions.push(like(scenarios.name, `%${search}%`));
    }
    if (favoritesOnly) {
      conditions.push(eq(scenarios.isFavorite, 1));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    // Get total count
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(scenarios)
      .where(whereClause);
    const total = Number(countResult[0]?.count || 0);

    // Get paginated results
    const rows = await db
      .select()
      .from(scenarios)
      .where(whereClause)
      .orderBy(desc(scenarios.updatedAt))
      .limit(pageSize)
      .offset(offset);

    // Return scenarios with metadata (count nodes from graph)
    const list = rows.map((row) => {
      const graph = row.graph as { nodes?: Record<string, unknown> } | null;
      const nodeCount = graph?.nodes ? Object.keys(graph.nodes).length : 0;
      return {
        id: row.id,
        name: row.name,
        ownerId: row.ownerId,
        isFavorite: row.isFavorite,
        nodeCount,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    });

    return Response.json(
      { scenarios: list, total, page, pageSize },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    console.error("Failed to list scenarios:", e);
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
      vus: classified.vus ?? 1,
      durationSeconds: classified.durationSeconds ?? 30,
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
