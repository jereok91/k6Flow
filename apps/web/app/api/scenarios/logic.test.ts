import { describe, expect, it } from "vitest";
import {
  validateGraph,
  canAccessScenario,
  classifyCreateScenario,
  classifyUpdateScenario,
} from "./logic";
import type { SafeUser } from "../../../lib/auth/safe-user";

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const minimalValidGraph = {
  version: 1 as const,
  nodes: [],
  connections: [],
};

const graphWithHttpNode = {
  version: 1 as const,
  nodes: [
    {
      id: "node-1",
      kind: "http-request" as const,
      references: [],
      parameters: {
        method: "GET",
        url: { kind: "literal" as const, value: "https://example.com" },
      },
    },
  ],
  connections: [],
};

const testDate = new Date("2026-01-01T00:00:00Z");
const ownerUser: SafeUser = { id: "user-1", username: "owner", role: "user", createdAt: testDate };
const otherUser: SafeUser = { id: "user-2", username: "other", role: "user", createdAt: testDate };
const adminUser: SafeUser = { id: "admin-1", username: "admin", role: "admin", createdAt: testDate };

// -----------------------------------------------------------------------------
// validateGraph
// -----------------------------------------------------------------------------

describe("validateGraph", () => {
  it("accepts a minimal valid graph", () => {
    const result = validateGraph(minimalValidGraph);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.graph).toEqual(minimalValidGraph);
    }
  });

  it("accepts a graph with an HTTP node", () => {
    const result = validateGraph(graphWithHttpNode);
    expect(result.valid).toBe(true);
  });

  it("rejects null", () => {
    const result = validateGraph(null);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it("rejects missing version", () => {
    const result = validateGraph({ nodes: [], connections: [] });
    expect(result.valid).toBe(false);
  });

  it("rejects invalid node kind", () => {
    const result = validateGraph({
      version: 1,
      nodes: [{ id: "n1", kind: "unknown", references: [] }],
      connections: [],
    });
    expect(result.valid).toBe(false);
  });

  it("returns flattened error paths", () => {
    const result = validateGraph({ version: 1, nodes: "not-an-array", connections: [] });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes("nodes"))).toBe(true);
    }
  });
});

// -----------------------------------------------------------------------------
// canAccessScenario
// -----------------------------------------------------------------------------

describe("canAccessScenario", () => {
  it("allows owner to access their scenario", () => {
    expect(canAccessScenario("user-1", ownerUser)).toBe(true);
  });

  it("denies non-owner non-admin", () => {
    expect(canAccessScenario("user-1", otherUser)).toBe(false);
  });

  it("allows admin to access any scenario", () => {
    expect(canAccessScenario("user-1", adminUser)).toBe(true);
    expect(canAccessScenario("user-2", adminUser)).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// classifyCreateScenario
// -----------------------------------------------------------------------------

describe("classifyCreateScenario", () => {
  it("accepts valid name and graph", () => {
    const result = classifyCreateScenario({
      name: "My Scenario",
      graph: minimalValidGraph,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.name).toBe("My Scenario");
      expect(result.graph).toEqual(minimalValidGraph);
    }
  });

  it("trims whitespace from name", () => {
    const result = classifyCreateScenario({
      name: "  Trimmed  ",
      graph: minimalValidGraph,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.name).toBe("Trimmed");
    }
  });

  it("rejects missing name", () => {
    const result = classifyCreateScenario({ graph: minimalValidGraph });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid-shape");
    }
  });

  it("rejects missing graph", () => {
    const result = classifyCreateScenario({ name: "Test" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid-shape");
    }
  });

  it("rejects empty string name", () => {
    const result = classifyCreateScenario({ name: "", graph: minimalValidGraph });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid-shape");
    }
  });

  it("rejects whitespace-only name", () => {
    const result = classifyCreateScenario({ name: "   ", graph: minimalValidGraph });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid-shape");
    }
  });

  it("rejects invalid graph", () => {
    const result = classifyCreateScenario({ name: "Test", graph: { invalid: true } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid-graph");
      expect(result.message).toContain("Invalid graph");
    }
  });

  it("rejects non-object body", () => {
    const result = classifyCreateScenario("not an object");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid-shape");
    }
  });

  it("rejects null body", () => {
    const result = classifyCreateScenario(null);
    expect(result.ok).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// classifyUpdateScenario
// -----------------------------------------------------------------------------

describe("classifyUpdateScenario", () => {
  it("accepts name-only update", () => {
    const result = classifyUpdateScenario({ name: "New Name" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.name).toBe("New Name");
      expect(result.graph).toBeUndefined();
    }
  });

  it("accepts graph-only update", () => {
    const result = classifyUpdateScenario({ graph: minimalValidGraph });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.name).toBeUndefined();
      expect(result.graph).toEqual(minimalValidGraph);
    }
  });

  it("accepts both name and graph", () => {
    const result = classifyUpdateScenario({
      name: "Updated",
      graph: graphWithHttpNode,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.name).toBe("Updated");
      expect(result.graph).toBeDefined();
    }
  });

  it("trims whitespace from name", () => {
    const result = classifyUpdateScenario({ name: "  Spaced  " });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.name).toBe("Spaced");
    }
  });

  it("rejects empty update", () => {
    const result = classifyUpdateScenario({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("empty-update");
    }
  });

  it("rejects empty string name", () => {
    const result = classifyUpdateScenario({ name: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid-shape");
    }
  });

  it("rejects invalid graph", () => {
    const result = classifyUpdateScenario({ graph: null });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid-graph");
    }
  });

  it("rejects non-object body", () => {
    const result = classifyUpdateScenario("string");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid-shape");
    }
  });

  it("rejects null body", () => {
    const result = classifyUpdateScenario(null);
    expect(result.ok).toBe(false);
  });
});
