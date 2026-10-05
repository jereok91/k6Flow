/**
 * HAR Import API - convert HAR files to scenarios
 */

import { randomUUID } from "node:crypto";
import { getDb } from "../../../../lib/db/client";
import { scenarios } from "../../../../lib/db/schema";
import { requireUser } from "../../../../lib/auth/require-user";
import { jsonError } from "../../../../lib/auth/http";
import { importHar, validateHar, type HarImportOptions } from "@k6flow/shared";

// POST /api/import/har - import HAR file as scenario
export async function POST(request: Request): Promise<Response> {
  const cookieHeader = request.headers.get("cookie");
  const user = await requireUser(cookieHeader);
  if (user === null) {
    return jsonError(401, "Unauthorized");
  }

  let body: {
    name?: string;
    har?: unknown;
    options?: {
      excludeStatic?: boolean;
      mainDocumentsOnly?: boolean;
      urlFilter?: string;
      stepGapMs?: number;
    };
  };

  try {
    body = await request.json();
  } catch {
    return jsonError(400, "Invalid JSON");
  }

  if (!body.name || typeof body.name !== "string") {
    return jsonError(400, "Scenario name is required");
  }

  if (!body.har) {
    return jsonError(400, "HAR data is required");
  }

  if (!validateHar(body.har)) {
    return jsonError(400, "Invalid HAR format");
  }

  try {
    // Build import options
    const importOptions: HarImportOptions = {
      name: body.name,
      excludeStatic: body.options?.excludeStatic ?? true,
      mainDocumentsOnly: body.options?.mainDocumentsOnly ?? false,
      stepGapMs: body.options?.stepGapMs ?? 2000,
    };

    if (body.options?.urlFilter) {
      try {
        importOptions.urlFilter = new RegExp(body.options.urlFilter);
      } catch {
        return jsonError(400, "Invalid URL filter regex");
      }
    }

    // Import HAR
    const result = importHar(body.har, importOptions);

    if (result.stats.importedEntries === 0) {
      return jsonError(422, result.warnings[0] || "No entries could be imported");
    }

    // Save as scenario
    const db = getDb();
    const scenarioId = randomUUID();

    await db.insert(scenarios).values({
      id: scenarioId,
      ownerId: user.id,
      name: body.name,
      graph: result.graph,
    });

    return Response.json({
      id: scenarioId,
      name: body.name,
      stats: result.stats,
      warnings: result.warnings,
    }, { status: 201 });
  } catch (e) {
    console.error("Failed to import HAR:", e);
    return jsonError(500, "Failed to import HAR");
  }
}
