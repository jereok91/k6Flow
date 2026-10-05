/**
 * Scenario tags API - add/remove tags from a scenario
 */

import { eq, and } from "drizzle-orm";
import { getDb } from "../../../../../lib/db/client";
import { scenarios, scenarioTags, tags } from "../../../../../lib/db/schema";
import { requireUser } from "../../../../../lib/auth/require-user";
import { jsonError } from "../../../../../lib/auth/http";
import { canAccessScenario } from "../../logic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

// GET /api/scenarios/[id]/tags - list tags for scenario
export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const cookieHeader = request.headers.get("cookie");
  const user = await requireUser(cookieHeader);
  if (user === null) {
    return jsonError(401, "Unauthorized");
  }
  const { id } = await context.params;

  try {
    const db = getDb();

    // Check scenario exists and user has access
    const [scenario] = await db
      .select({ ownerId: scenarios.ownerId })
      .from(scenarios)
      .where(eq(scenarios.id, id))
      .limit(1);

    if (!scenario) {
      return jsonError(404, "Scenario not found");
    }

    if (!canAccessScenario(scenario.ownerId, user)) {
      return jsonError(403, "Forbidden");
    }

    // Get tags for this scenario
    const tagRows = await db
      .select({
        id: tags.id,
        name: tags.name,
        color: tags.color,
      })
      .from(scenarioTags)
      .innerJoin(tags, eq(scenarioTags.tagId, tags.id))
      .where(eq(scenarioTags.scenarioId, id));

    return Response.json({ tags: tagRows }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    console.error("Failed to list scenario tags:", e);
    return jsonError(500, "Internal server error");
  }
}

// POST /api/scenarios/[id]/tags - add a tag to scenario
export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const cookieHeader = request.headers.get("cookie");
  const user = await requireUser(cookieHeader);
  if (user === null) {
    return jsonError(401, "Unauthorized");
  }
  const { id } = await context.params;

  let body: { tagId?: string };
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "Invalid JSON");
  }

  if (!body.tagId) {
    return jsonError(400, "tagId is required");
  }

  try {
    const db = getDb();

    // Check scenario exists and user has access
    const [scenario] = await db
      .select({ ownerId: scenarios.ownerId })
      .from(scenarios)
      .where(eq(scenarios.id, id))
      .limit(1);

    if (!scenario) {
      return jsonError(404, "Scenario not found");
    }

    if (!canAccessScenario(scenario.ownerId, user)) {
      return jsonError(403, "Forbidden");
    }

    // Check tag exists and belongs to user
    const [tag] = await db
      .select()
      .from(tags)
      .where(and(eq(tags.id, body.tagId), eq(tags.ownerId, user.id)))
      .limit(1);

    if (!tag) {
      return jsonError(404, "Tag not found");
    }

    // Check if already tagged
    const [existing] = await db
      .select()
      .from(scenarioTags)
      .where(
        and(
          eq(scenarioTags.scenarioId, id),
          eq(scenarioTags.tagId, body.tagId),
        ),
      )
      .limit(1);

    if (existing) {
      return Response.json({ added: false, message: "Already tagged" });
    }

    // Add tag
    await db.insert(scenarioTags).values({
      scenarioId: id,
      tagId: body.tagId,
    });

    return Response.json({ added: true }, { status: 201 });
  } catch (e) {
    console.error("Failed to add tag:", e);
    return jsonError(500, "Internal server error");
  }
}

// DELETE /api/scenarios/[id]/tags - remove a tag from scenario
export async function DELETE(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const cookieHeader = request.headers.get("cookie");
  const user = await requireUser(cookieHeader);
  if (user === null) {
    return jsonError(401, "Unauthorized");
  }
  const { id } = await context.params;

  const url = new URL(request.url);
  const tagId = url.searchParams.get("tagId");

  if (!tagId) {
    return jsonError(400, "tagId query parameter is required");
  }

  try {
    const db = getDb();

    // Check scenario exists and user has access
    const [scenario] = await db
      .select({ ownerId: scenarios.ownerId })
      .from(scenarios)
      .where(eq(scenarios.id, id))
      .limit(1);

    if (!scenario) {
      return jsonError(404, "Scenario not found");
    }

    if (!canAccessScenario(scenario.ownerId, user)) {
      return jsonError(403, "Forbidden");
    }

    // Remove tag
    await db
      .delete(scenarioTags)
      .where(
        and(
          eq(scenarioTags.scenarioId, id),
          eq(scenarioTags.tagId, tagId),
        ),
      );

    return Response.json({ removed: true });
  } catch (e) {
    console.error("Failed to remove tag:", e);
    return jsonError(500, "Internal server error");
  }
}
