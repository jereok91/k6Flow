// K6F8-06: E2E proof — capture to graph translation.
// Tests the complete flow: captured traffic → graph nodes → editable scenario.

import { describe, it, expect } from "vitest";
import {
  capturesToGraph,
  generateConnections,
  detectAuth,
  detectDynamicValues,
  findValueCorrelations,
  type RecorderCaptureEntry,
  type CaptureGraphNode,
} from "@k6flow/shared";

describe("Phase 8: Capture to Graph E2E", () => {
  // Simulate a realistic login + API call flow
  const realisticCaptures: RecorderCaptureEntry[] = [
    {
      method: "POST",
      url: "https://api.example.com/auth/login",
      status: 200,
      headers: [
        { name: "Content-Type", value: "application/json" },
      ],
      bodyExcerpt: '{"email":"user@example.com","password":"secret123"}',
      redacted: false,
    },
    {
      method: "GET",
      url: "https://api.example.com/users/me",
      status: 200,
      headers: [
        { name: "Authorization", value: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U" },
      ],
      redacted: false,
    },
    {
      method: "GET",
      url: "https://api.example.com/products?page=1&limit=10",
      status: 200,
      headers: [
        { name: "Authorization", value: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U" },
      ],
      redacted: false,
    },
    {
      method: "POST",
      url: "https://api.example.com/cart/items",
      status: 201,
      headers: [
        { name: "Authorization", value: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U" },
        { name: "Content-Type", value: "application/json" },
      ],
      bodyExcerpt: '{"productId":"abc-123","quantity":2}',
      redacted: false,
    },
  ];

  describe("Complete flow: capture → graph → analysis", () => {
    it("converts captures to graph nodes with correct structure", () => {
      const nodes = capturesToGraph(realisticCaptures);

      expect(nodes).toHaveLength(4);

      // Login request
      expect(nodes[0].kind).toBe("http-request");
      expect(nodes[0].parameters.method).toBe("POST");
      expect(nodes[0].parameters.url.kind).toBe("literal");
      expect((nodes[0].parameters.url as { value: string }).value).toBe(
        "https://api.example.com/auth/login"
      );
      expect(nodes[0].parameters.body?.kind).toBe("json");

      // Get user request with Authorization
      expect(nodes[1].parameters.method).toBe("GET");
      expect(nodes[1].parameters.headers).toBeDefined();

      // Products request with query params
      expect(nodes[2].parameters.query).toHaveLength(2);
      expect(nodes[2].parameters.query?.[0].name).toBe("page");
      expect(nodes[2].parameters.query?.[1].name).toBe("limit");
    });

    it("generates sequential connections between nodes", () => {
      const nodes = capturesToGraph(realisticCaptures);
      const connections = generateConnections(nodes);

      expect(connections).toHaveLength(3);
      expect(connections[0]).toEqual({ source: "capture-0", target: "capture-1" });
      expect(connections[1]).toEqual({ source: "capture-1", target: "capture-2" });
      expect(connections[2]).toEqual({ source: "capture-2", target: "capture-3" });
    });

    it("detects authentication patterns", () => {
      const authResult = detectAuth(realisticCaptures);

      expect(authResult.needsAuth).toBe(true);

      // Should detect the login request
      const loginSignal = authResult.signals.find(
        (s) => s.index === 0 && s.type === "login"
      );
      expect(loginSignal).toBeDefined();
      expect(loginSignal!.confidence).toBeGreaterThanOrEqual(0.7);

      // Should detect Bearer token usage
      const tokenSignals = authResult.signals.filter((s) => s.index > 0);
      expect(tokenSignals.length).toBeGreaterThanOrEqual(1);
    });

    it("detects dynamic values for parameterization", () => {
      const dynamicResult = detectDynamicValues(realisticCaptures);

      // Should detect JWT tokens
      const jwtValues = dynamicResult.values.filter((v) => v.valueType === "jwt");
      expect(jwtValues.length).toBeGreaterThanOrEqual(1);

      // Should correlate same token across requests
      const correlations = findValueCorrelations(dynamicResult);
      // The JWT appears in requests 1, 2, 3 - should be correlated
      expect(correlations.size).toBeGreaterThanOrEqual(1);
    });
  });

  describe("Edge cases", () => {
    it("handles empty capture list", () => {
      const nodes = capturesToGraph([]);
      const connections = generateConnections(nodes);
      const auth = detectAuth([]);
      const dynamic = detectDynamicValues([]);

      expect(nodes).toHaveLength(0);
      expect(connections).toHaveLength(0);
      expect(auth.needsAuth).toBe(false);
      expect(dynamic.values).toHaveLength(0);
    });

    it("handles single capture", () => {
      const single: RecorderCaptureEntry[] = [
        {
          method: "GET",
          url: "https://example.com/api/health",
          status: 200,
          headers: [],
          redacted: false,
        },
      ];

      const nodes = capturesToGraph(single);
      const connections = generateConnections(nodes);

      expect(nodes).toHaveLength(1);
      expect(connections).toHaveLength(0);
    });

    it("handles binary body content", () => {
      const withBinary: RecorderCaptureEntry[] = [
        {
          method: "POST",
          url: "https://example.com/upload",
          status: 200,
          headers: [],
          bodyExcerpt: "[binary content]",
          redacted: false,
        },
      ];

      const nodes = capturesToGraph(withBinary);

      expect(nodes[0].parameters.body).toBeUndefined();
    });

    it("handles malformed URLs gracefully", () => {
      const withBadUrl: RecorderCaptureEntry[] = [
        {
          method: "GET",
          url: "not-a-valid-url",
          status: 200,
          headers: [],
          redacted: false,
        },
      ];

      const nodes = capturesToGraph(withBadUrl);

      expect(nodes[0].parameters.url).toEqual({
        kind: "literal",
        value: "not-a-valid-url",
      });
    });
  });

  describe("Graph compatibility", () => {
    it("produces nodes compatible with editor structure", () => {
      const nodes = capturesToGraph(realisticCaptures);

      // Each node should have required fields for editor
      for (const node of nodes) {
        expect(node.id).toBeDefined();
        expect(node.kind).toBe("http-request");
        expect(node.references).toEqual({});
        expect(node.parameters).toBeDefined();
        expect(node.parameters.method).toBeDefined();
        expect(node.parameters.url).toBeDefined();
      }
    });

    it("produces connections compatible with ReactFlow edges", () => {
      const nodes = capturesToGraph(realisticCaptures);
      const connections = generateConnections(nodes);

      // Each connection should have source and target
      for (const conn of connections) {
        expect(conn.source).toBeDefined();
        expect(conn.target).toBeDefined();
        // Source and target should be valid node IDs
        expect(nodes.find((n) => n.id === conn.source)).toBeDefined();
        expect(nodes.find((n) => n.id === conn.target)).toBeDefined();
      }
    });

    it("metadata tracks original capture info", () => {
      const nodes = capturesToGraph(realisticCaptures);

      // Each node should have metadata
      for (let i = 0; i < nodes.length; i++) {
        expect(nodes[i].meta).toBeDefined();
        expect(nodes[i].meta.originalStatus).toBe(realisticCaptures[i].status);
        expect(nodes[i].meta.redacted).toBe(realisticCaptures[i].redacted);
      }
    });
  });

  describe("OAuth flow detection", () => {
    const oauthFlow: RecorderCaptureEntry[] = [
      {
        method: "POST",
        url: "https://auth.example.com/oauth/token",
        status: 200,
        headers: [{ name: "Content-Type", value: "application/json" }],
        bodyExcerpt: '{"grant_type":"password","username":"user","password":"pass","client_id":"web-app"}',
        redacted: false,
      },
      {
        method: "GET",
        url: "https://api.example.com/resource",
        status: 200,
        headers: [{ name: "Authorization", value: "Bearer eyJtoken" }],
        redacted: false,
      },
    ];

    it("detects OAuth grant_type pattern", () => {
      const auth = detectAuth(oauthFlow);

      const oauthSignal = auth.signals.find((s) => s.type === "oauth");
      expect(oauthSignal).toBeDefined();
      expect(oauthSignal!.confidence).toBeGreaterThanOrEqual(0.8);
    });
  });

  describe("API key detection", () => {
    const apiKeyFlow: RecorderCaptureEntry[] = [
      {
        method: "GET",
        url: "https://api.example.com/data",
        status: 200,
        headers: [{ name: "X-API-Key", value: "sk_live_1234567890abcdefghijklmnop" }],
        redacted: false,
      },
    ];

    it("detects X-API-Key header", () => {
      const dynamic = detectDynamicValues(apiKeyFlow);

      const apiKey = dynamic.values.find((v) => v.location.field === "X-API-Key");
      expect(apiKey).toBeDefined();
    });
  });
});
