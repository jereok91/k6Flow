/**
 * HAR Import API - convert HAR files to scenarios
 */

import { randomUUID } from "node:crypto";
import { getDb } from "../../../../lib/db/client";
import { scenarios } from "../../../../lib/db/schema";
import { requireUser } from "../../../../lib/auth/require-user";
import { jsonError } from "../../../../lib/auth/http";
import { applyVariableSuggestions, harGraphToComposition, importHar, isHarResourceType, suggestHarVariables, validateHar, type HarImportOptions, type HarResourceType } from "@k6flow/shared";

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

interface HarImportRequestBody {
  name?: string;
  har?: unknown;
  /** Replace the suggested values with `{{name}}` placeholders (default false). */
  applySuggestedVariables?: unknown;
  options?: {
    excludeStatic?: unknown;
    mainDocumentsOnly?: unknown;
    urlFilter?: unknown;
    stepGapMs?: unknown;
    includeResourceTypes?: unknown;
    excludeResourceTypes?: unknown;
    methods?: unknown;
    statusMin?: unknown;
    statusMax?: unknown;
    includeDomains?: unknown;
    excludeDomains?: unknown;
    useHarTimings?: unknown;
  };
}

const absent = (value: unknown): boolean => value === undefined || value === null;

function parseBoolean(field: string, value: unknown): Parsed<boolean | undefined> {
  if (absent(value)) return { ok: true, value: undefined };
  if (typeof value !== "boolean") return { ok: false, error: `${field} must be a boolean` };
  return { ok: true, value };
}

function parseNumber(field: string, value: unknown): Parsed<number | undefined> {
  if (absent(value)) return { ok: true, value: undefined };
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { ok: false, error: `${field} must be a finite number` };
  }
  return { ok: true, value };
}

function parseStringList(field: string, value: unknown): Parsed<string[] | undefined> {
  if (absent(value)) return { ok: true, value: undefined };
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return { ok: false, error: `${field} must be an array of strings` };
  }
  return { ok: true, value: value as string[] };
}

function parseResourceTypes(
  field: string,
  value: unknown,
): Parsed<readonly HarResourceType[] | undefined> {
  const parsed = parseStringList(field, value);
  if (!parsed.ok) return parsed;
  const unknownType = parsed.value?.find((item) => !isHarResourceType(item));
  if (unknownType !== undefined) {
    return { ok: false, error: `Unknown resource type in ${field}: ${unknownType}` };
  }
  return { ok: true, value: parsed.value as readonly HarResourceType[] | undefined };
}

/**
 * Build the importer options from the request body. Absent fields keep the
 * defaults the importer already used; present-but-invalid fields are rejected so
 * the caller never gets a silently unfiltered import.
 */
function parseImportOptions(
  name: string,
  body: HarImportRequestBody["options"],
): Parsed<HarImportOptions> {
  const options = body ?? {};

  const excludeStatic = parseBoolean("excludeStatic", options.excludeStatic);
  if (!excludeStatic.ok) return excludeStatic;
  const mainDocumentsOnly = parseBoolean("mainDocumentsOnly", options.mainDocumentsOnly);
  if (!mainDocumentsOnly.ok) return mainDocumentsOnly;
  const stepGapMs = parseNumber("stepGapMs", options.stepGapMs);
  if (!stepGapMs.ok) return stepGapMs;
  const useHarTimings = parseBoolean("useHarTimings", options.useHarTimings);
  if (!useHarTimings.ok) return useHarTimings;

  const includeResourceTypes = parseResourceTypes("includeResourceTypes", options.includeResourceTypes);
  if (!includeResourceTypes.ok) return includeResourceTypes;
  const excludeResourceTypes = parseResourceTypes("excludeResourceTypes", options.excludeResourceTypes);
  if (!excludeResourceTypes.ok) return excludeResourceTypes;

  const methods = parseStringList("methods", options.methods);
  if (!methods.ok) return methods;
  const includeDomains = parseStringList("includeDomains", options.includeDomains);
  if (!includeDomains.ok) return includeDomains;
  const excludeDomains = parseStringList("excludeDomains", options.excludeDomains);
  if (!excludeDomains.ok) return excludeDomains;

  const statusMin = parseNumber("statusMin", options.statusMin);
  if (!statusMin.ok) return statusMin;
  const statusMax = parseNumber("statusMax", options.statusMax);
  if (!statusMax.ok) return statusMax;
  if (statusMin.value !== undefined && statusMax.value !== undefined && statusMin.value > statusMax.value) {
    return { ok: false, error: "statusMin must not be greater than statusMax" };
  }

  const importOptions: HarImportOptions = {
    name,
    excludeStatic: excludeStatic.value ?? true,
    mainDocumentsOnly: mainDocumentsOnly.value ?? false,
    stepGapMs: stepGapMs.value ?? 2000,
    useHarTimings: useHarTimings.value ?? true,
  };

  if (options.urlFilter !== undefined && options.urlFilter !== null) {
    if (typeof options.urlFilter !== "string") {
      return { ok: false, error: "urlFilter must be a string" };
    }
    try {
      importOptions.urlFilter = new RegExp(options.urlFilter);
    } catch {
      return { ok: false, error: "Invalid URL filter regex" };
    }
  }

  // Filters stay absent when the caller did not send them, so the importer keeps
  // its own defaults instead of receiving an empty list that means "keep none".
  if (includeResourceTypes.value !== undefined) importOptions.includeResourceTypes = includeResourceTypes.value;
  if (excludeResourceTypes.value !== undefined) importOptions.excludeResourceTypes = excludeResourceTypes.value;
  if (methods.value !== undefined) importOptions.methods = methods.value;
  if (includeDomains.value !== undefined) importOptions.includeDomains = includeDomains.value;
  if (excludeDomains.value !== undefined) importOptions.excludeDomains = excludeDomains.value;
  if (statusMin.value !== undefined) importOptions.statusMin = statusMin.value;
  if (statusMax.value !== undefined) importOptions.statusMax = statusMax.value;

  return { ok: true, value: importOptions };
}

// POST /api/import/har - import HAR file as scenario
export async function POST(request: Request): Promise<Response> {
  const cookieHeader = request.headers.get("cookie");
  const user = await requireUser(cookieHeader);
  if (user === null) {
    return jsonError(401, "Unauthorized");
  }

  let body: HarImportRequestBody;

  try {
    body = (await request.json()) as HarImportRequestBody;
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

  const parsedOptions = parseImportOptions(body.name, body.options);
  if (!parsedOptions.ok) {
    return jsonError(400, parsedOptions.error);
  }

  const applySuggestedVariables = parseBoolean("applySuggestedVariables", body.applySuggestedVariables);
  if (!applySuggestedVariables.ok) {
    return jsonError(400, applySuggestedVariables.error);
  }

  try {
    // Import HAR
    const result = importHar(body.har, parsedOptions.value);

    if (result.stats.importedEntries === 0) {
      return jsonError(422, result.warnings[0] || "No entries could be imported");
    }

    // The editor validates and renders a graph composition, so the imported
    // HAR graph is converted before it is stored (D5).
    const bridged = harGraphToComposition(result.graph);

    // Variables are suggested per case and applied only on request (S4/D4): the
    // caller sees every candidate, and placeholders are written into the stored
    // graph only when `applySuggestedVariables` asks for it.
    const variableSuggestions = suggestHarVariables(result.graph, bridged.composition);
    const composition = applySuggestedVariables.value === true
      ? applyVariableSuggestions(bridged.composition, variableSuggestions)
      : bridged.composition;

    // Save as scenario
    const db = getDb();
    const scenarioId = randomUUID();

    await db.insert(scenarios).values({
      id: scenarioId,
      ownerId: user.id,
      name: body.name,
      graph: composition,
    });

    return Response.json({
      id: scenarioId,
      name: body.name,
      stats: result.stats,
      warnings: [...result.warnings, ...bridged.warnings],
      variableSuggestions,
    }, { status: 201 });
  } catch (e) {
    console.error("Failed to import HAR:", e);
    return jsonError(500, "Failed to import HAR");
  }
}
