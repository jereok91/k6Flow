/**
 * Scenario export API - export in various formats
 */

import { eq } from "drizzle-orm";
import { getDb } from "../../../../../lib/db/client";
import { scenarios } from "../../../../../lib/db/schema";
import { requireUser } from "../../../../../lib/auth/require-user";
import { jsonError } from "../../../../../lib/auth/http";
import { canAccessScenario } from "../../logic";
import { getScenarioVariablesForExport, storeFailureResponse } from "../../../../../lib/variables/store";
import { translateToK6 } from "@k6flow/shared";

interface RouteContext {
  params: Promise<{ id: string }>;
}

// GET /api/scenarios/[id]/export?format=json|k6|har
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

  const url = new URL(request.url);
  const format = url.searchParams.get("format") || "json";

  try {
    const db = getDb();
    const [scenario] = await db
      .select()
      .from(scenarios)
      .where(eq(scenarios.id, id))
      .limit(1);

    if (!scenario) {
      return jsonError(404, "Scenario not found");
    }

    if (!canAccessScenario(scenario.ownerId, user)) {
      return jsonError(403, "Forbidden");
    }

    const filename = scenario.name.replace(/[^a-z0-9]/gi, "_").toLowerCase();

    switch (format) {
      case "json": {
        // K6Flow JSON format. Variable definitions are included, but secret
        // values never are: secrets export as { name, secret: true } only.
        const variables = await getScenarioVariablesForExport(user, id);
        if (!variables.ok) {
          return storeFailureResponse(variables, "Scenario");
        }
        const exportData = {
          version: "1.0",
          exportedAt: new Date().toISOString(),
          scenario: {
            id: scenario.id,
            name: scenario.name,
            graph: scenario.graph,
            variables: variables.value,
            createdAt: scenario.createdAt.toISOString(),
            updatedAt: scenario.updatedAt.toISOString(),
          },
        };

        return new Response(JSON.stringify(exportData, null, 2), {
          headers: {
            "Content-Type": "application/json",
            "Content-Disposition": `attachment; filename="${filename}.json"`,
          },
        });
      }

      case "k6": {
        // K6 script format
        const result = translateToK6(scenario.graph as Parameters<typeof translateToK6>[0]);
        
        return new Response(result.script, {
          headers: {
            "Content-Type": "application/javascript",
            "Content-Disposition": `attachment; filename="${filename}.js"`,
          },
        });
      }

      case "har": {
        // HAR format (reverse conversion - simplified)
        const graph = scenario.graph as {
          nodes?: Record<string, {
            type: string;
            parameters?: {
              method?: string;
              url?: string;
              headers?: Array<{ key: string; value: string }>;
              body?: string;
            };
          }>;
        };

        const entries: Array<{
          startedDateTime: string;
          time: number;
          request: {
            method: string;
            url: string;
            httpVersion: string;
            headers: Array<{ name: string; value: string }>;
            queryString: Array<{ name: string; value: string }>;
            headersSize: number;
            bodySize: number;
            postData?: { mimeType: string; text: string };
          };
          response: {
            status: number;
            statusText: string;
            httpVersion: string;
            headers: Array<{ name: string; value: string }>;
            content: { size: number; mimeType: string };
            redirectURL: string;
            headersSize: number;
            bodySize: number;
          };
          cache: Record<string, unknown>;
          timings: { send: number; wait: number; receive: number };
        }> = [];

        const nodes = graph.nodes || {};
        const baseTime = new Date();

        Object.values(nodes).forEach((node, index) => {
          if (node.type === "http_request" && node.parameters) {
            const params = node.parameters;
            const entryTime = new Date(baseTime.getTime() + index * 1000);

            entries.push({
              startedDateTime: entryTime.toISOString(),
              time: 100,
              request: {
                method: params.method || "GET",
                url: params.url || "",
                httpVersion: "HTTP/1.1",
                headers: (params.headers || []).map((h) => ({
                  name: h.key,
                  value: h.value,
                })),
                queryString: [],
                headersSize: -1,
                bodySize: params.body ? params.body.length : 0,
                ...(params.body && {
                  postData: {
                    mimeType: "application/json",
                    text: params.body,
                  },
                }),
              },
              response: {
                status: 200,
                statusText: "OK",
                httpVersion: "HTTP/1.1",
                headers: [],
                content: { size: 0, mimeType: "application/json" },
                redirectURL: "",
                headersSize: -1,
                bodySize: 0,
              },
              cache: {},
              timings: { send: 0, wait: 100, receive: 0 },
            });
          }
        });

        const har = {
          log: {
            version: "1.2",
            creator: {
              name: "K6Flow",
              version: "1.0",
            },
            entries,
          },
        };

        return new Response(JSON.stringify(har, null, 2), {
          headers: {
            "Content-Type": "application/json",
            "Content-Disposition": `attachment; filename="${filename}.har"`,
          },
        });
      }

      default:
        return jsonError(400, `Unknown format: ${format}. Supported: json, k6, har`);
    }
  } catch (e) {
    console.error("Failed to export scenario:", e);
    return jsonError(500, "Failed to export scenario");
  }
}
