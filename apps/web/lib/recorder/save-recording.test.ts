import { describe, expect, it } from "vitest";
import { graphDraftCompositionSchema } from "@k6flow/shared";
import { createScenarioGraph, type ReviewedEntry } from "./save-recording";

const reviewed = (
  id: string,
  method: string,
  url: string,
  options: { stepId?: string; stepName?: string; thinkTime?: number; postData?: string; contentType?: string } = {},
): ReviewedEntry => ({
  entry: {
    request: {
      id,
      timestamp: 1,
      method,
      url,
      headers: options.contentType ? { "content-type": options.contentType } : {},
      postData: options.postData,
      resourceType: "Fetch",
    },
    response: {
      id,
      timestamp: 2,
      status: 200,
      statusText: "OK",
      headers: {},
      mimeType: "application/json",
      bodySize: 2,
      bodyTruncated: false,
    },
    timing: { startTime: 1, endTime: 2, durationMs: 1 },
  },
  stepId: options.stepId ?? "step-1",
  stepName: options.stepName ?? "Navigate: login",
  thinkTime: options.thinkTime ?? 0,
});

describe("createScenarioGraph", () => {
  it("produces a composition the editor schema accepts", () => {
    const graph = createScenarioGraph(
      [
        reviewed("r1", "GET", "https://app.example.com/login"),
        reviewed("r2", "POST", "https://app.example.com/api/session", {
          stepId: "step-2",
          stepName: "Submit login",
          thinkTime: 2.5,
          postData: '{"user":"ana"}',
          contentType: "application/json",
        }),
      ],
    );

    const parsed = graphDraftCompositionSchema.safeParse(graph);

    expect(parsed.success ? null : parsed.error.issues).toBeNull();
    expect(graph.version).toBe(1);
    expect(Array.isArray(graph.nodes)).toBe(true);
    expect(Array.isArray(graph.connections)).toBe(true);
  });

  it("links the requests in order and turns each step's think time into a wait", () => {
    const graph = createScenarioGraph(
      [
        reviewed("r1", "GET", "https://app.example.com/login"),
        reviewed("r2", "POST", "https://app.example.com/api/session", { thinkTime: 2.5 }),
        reviewed("r3", "GET", "https://app.example.com/admin", { thinkTime: 0 }),
      ],
    );

    expect(graph.nodes.map((node) => node.id)).toEqual(["rec-1", "rec-2", "rec-3"]);
    expect(graph.connections).toEqual([
      { source: "rec-1", target: "rec-2", waitSeconds: 2.5 },
      { source: "rec-2", target: "rec-3" },
    ]);
  });

  it("gives every node a readable label and an editor position", () => {
    const graph = createScenarioGraph([reviewed("r1", "GET", "https://app.example.com/login?next=%2F")]);

    expect(graph.nodes[0]).toMatchObject({
      kind: "http-request",
      references: [],
      label: "GET /login",
      position: { x: 100, y: 100 },
    });
  });

  it("keeps the request as typed parameters the editor can edit", () => {
    const graph = createScenarioGraph(
      [reviewed("r1", "POST", "https://app.example.com/api/session?tenant=acme", {
        postData: '{"user":"ana"}',
        contentType: "application/json",
      })],
    );

    expect(graph.nodes[0].parameters).toMatchObject({
      method: "POST",
      url: { kind: "literal", value: "https://app.example.com/api/session" },
      query: [{ name: "tenant", value: { kind: "literal", value: "acme" } }],
      body: { kind: "json", value: { kind: "literal", value: '{"user":"ana"}' } },
    });
  });

  it("clamps a wait the connection schema would reject", () => {
    const graph = createScenarioGraph(
      [reviewed("r1", "GET", "https://app.example.com/a"), reviewed("r2", "GET", "https://app.example.com/b", { thinkTime: 9_999 })],
    );

    expect(graph.connections[0].waitSeconds).toBe(3600);
  });
});
