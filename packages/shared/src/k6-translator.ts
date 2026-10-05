/**
 * K6F5-01: Graph-to-K6 translator.
 *
 * Converts a GraphDraftComposition to an executable K6 script string.
 * Deterministic: the same graph always produces the same script (init §13).
 */

import type { GraphDraftComposition } from "./graph-composition";

/**
 * K6 script generation options.
 */
export interface K6TranslatorOptions {
  /** Virtual users (default: 1) */
  vus?: number;
  /** Duration string (default: "30s") */
  duration?: string;
  /** Iterations (if set, overrides duration) */
  iterations?: number;
}

/**
 * Result of K6 script generation.
 */
export interface K6TranslatorResult {
  /** The generated K6 script */
  script: string;
  /** Warnings encountered during generation */
  warnings: string[];
  /** Whether the script requires external files (e.g., CSV) */
  requiresFiles: string[];
}

type GraphNode = GraphDraftComposition["nodes"][number];

/**
 * Translates a GraphDraftComposition to a K6 script.
 *
 * The output is deterministic: same input always produces same output.
 * Node order in the script follows topological sort based on edges.
 */
export function translateToK6(
  graph: GraphDraftComposition,
  options: K6TranslatorOptions = {},
): K6TranslatorResult {
  const { vus = 1, duration = "30s", iterations } = options;
  const warnings: string[] = [];
  const requiresFiles: string[] = [];

  // Build dependency graph for topological sort
  const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const node of graph.nodes) {
    inDegree.set(node.id, 0);
    adjacency.set(node.id, []);
  }

  for (const conn of graph.connections) {
    const targets = adjacency.get(conn.source) ?? [];
    targets.push(conn.target);
    adjacency.set(conn.source, targets);
    inDegree.set(conn.target, (inDegree.get(conn.target) ?? 0) + 1);
  }

  // Kahn's algorithm for topological sort (deterministic: sort by id)
  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id);
  }
  queue.sort(); // Deterministic order

  const sortedIds: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    sortedIds.push(id);
    const targets = adjacency.get(id) ?? [];
    for (const target of targets.sort()) {
      const newDegree = (inDegree.get(target) ?? 1) - 1;
      inDegree.set(target, newDegree);
      if (newDegree === 0) {
        // Insert in sorted position for determinism
        const insertIdx = queue.findIndex((q) => q > target);
        if (insertIdx === -1) queue.push(target);
        else queue.splice(insertIdx, 0, target);
      }
    }
  }

  // Check for cycles
  if (sortedIds.length !== graph.nodes.length) {
    warnings.push("Graph contains cycles; some nodes may not execute");
  }

  // Generate imports
  const imports: string[] = ["import http from 'k6/http';"];
  const hasChecks = graph.nodes.some((n) => n.kind === "response-validation");
  if (hasChecks) {
    imports.push("import { check } from 'k6';");
  }
  const hasUserPool = graph.nodes.some((n) => n.kind === "user-pool");
  if (hasUserPool) {
    imports.push("import { SharedArray } from 'k6/data';");
    imports.push("import papaparse from 'https://jslib.k6.io/papaparse/5.1.1/index.js';");
  }

  // Generate options
  const optionsLines: string[] = ["export const options = {"];
  optionsLines.push(`  vus: ${vus},`);
  if (iterations !== undefined) {
    optionsLines.push(`  iterations: ${iterations},`);
  } else {
    optionsLines.push(`  duration: '${duration}',`);
  }
  optionsLines.push("};");

  // Generate setup for user pools
  const setupLines: string[] = [];
  for (const node of graph.nodes) {
    if (node.kind === "user-pool" && node.parameters) {
      const params = node.parameters;
      const mode = params.mode ?? "csv";
      
      if (mode === "manual" && params.manualUsers && params.manualUsers.length > 0) {
        // Manual mode: embed users directly in script
        setupLines.push("");
        setupLines.push(`// User pool (manual): ${node.id}`);
        const usersJson = JSON.stringify(params.manualUsers);
        setupLines.push(`const ${sanitizeVarName(node.id)}_data = new SharedArray('${node.id}', function () {`);
        setupLines.push(`  return ${usersJson};`);
        setupLines.push("});");
      } else if (params.attachment) {
        // CSV mode: load from file
        const fileId = params.attachment.id;
        requiresFiles.push(`${fileId}.csv`);
        setupLines.push("");
        setupLines.push(`// User pool: ${node.id}`);
        setupLines.push(`const ${sanitizeVarName(node.id)}_data = new SharedArray('${fileId}', function () {`);
        setupLines.push(`  return papaparse.parse(open('./${fileId}.csv'), { header: true }).data;`);
        setupLines.push("});");
      }
    }
  }

  // Generate default function body
  const bodyLines: string[] = [];
  const varMap = new Map<string, string>(); // node.id -> variable name

  for (const id of sortedIds) {
    const node = nodeMap.get(id);
    if (!node) continue;

    const varName = sanitizeVarName(id);

    switch (node.kind) {
      case "user-pool": {
        if (!node.parameters) break;
        const params = node.parameters;
        bodyLines.push("");
        bodyLines.push(`  // ${node.id}`);
        bodyLines.push(`  const ${varName} = ${varName}_data[__VU % ${varName}_data.length];`);
        // Map outputs
        for (const output of params.outputs) {
          varMap.set(`${id}.${output.name}`, `${varName}.${output.name}`);
        }
        break;
      }

      case "authentication": {
        if (!node.parameters) break;
        const params = node.parameters;
        const req = params.method.request;
        const method = req.method;
        const url = req.url.kind === "literal" ? req.url.value : "''";

        bodyLines.push("");
        bodyLines.push(`  // ${node.id}`);
        bodyLines.push(`  const ${varName}_res = http.${method.toLowerCase()}('${url}', null, {`);
        bodyLines.push("    headers: { 'Content-Type': 'application/json' },");
        bodyLines.push("  });");

        // Extract outputs
        for (const output of params.outputs) {
          if (output.selector.kind === "json-path") {
            const jsonPath = output.selector.path.join(".");
            bodyLines.push(`  const ${varName}_${output.name} = ${varName}_res.json('${jsonPath}');`);
            varMap.set(`${id}.${output.name}`, `${varName}_${output.name}`);
          }
        }
        varMap.set(`${id}.response`, `${varName}_res`);
        break;
      }

      case "http-request": {
        if (!node.parameters) break;
        const params = node.parameters;
        const method = params.method;
        let url = "''";
        if (params.url.kind === "literal") {
          url = `'${params.url.value}'`;
        } else if (params.url.kind === "reference") {
          const ref = params.url.reference;
          url = varMap.get(`${ref.producerNodeId}.${ref.output}`) ?? "''";
        }

        let body = "null";
        if (params.body?.kind === "text" && params.body.value.kind === "literal") {
          body = `'${escapeString(params.body.value.value)}'`;
        } else if (params.body?.kind === "json") {
          body = "JSON.stringify({})"; // Simplified
        }

        bodyLines.push("");
        bodyLines.push(`  // ${node.id}`);
        bodyLines.push(`  const ${varName}_res = http.${method.toLowerCase()}(${url}, ${body}, {`);
        bodyLines.push("    headers: { 'Content-Type': 'application/json' },");
        bodyLines.push("  });");
        varMap.set(`${id}.response`, `${varName}_res`);
        break;
      }

      case "response-validation": {
        if (!node.parameters) break;
        const params = node.parameters;
        const responseRef = params.response;
        const responseVar = varMap.get(`${responseRef.producerNodeId}.${responseRef.output}`) ?? "null";

        bodyLines.push("");
        bodyLines.push(`  // ${node.id}`);
        bodyLines.push(`  check(${responseVar}, {`);

        for (const chk of params.checks) {
          let checkExpr = "true";
          if (chk.kind === "status") {
            const op = operatorToJs(chk.operator);
            checkExpr = `(r) => r.status ${op} ${chk.expected}`;
          } else if (chk.kind === "body-text" && chk.predicate.operator === "contains-literal") {
            checkExpr = `(r) => r.body.includes('${escapeString(chk.predicate.expected ?? "")}')`;
          } else if (chk.kind === "duration-ms") {
            const op = operatorToJs(chk.operator);
            checkExpr = `(r) => r.timings.duration ${op} ${chk.expected}`;
          }
          bodyLines.push(`    '${chk.name}': ${checkExpr},`);
        }

        bodyLines.push("  });");
        break;
      }
    }
  }

  // Assemble script
  const script = [
    "// Generated by k6flow",
    "// Do not edit manually",
    "",
    ...imports,
    "",
    ...optionsLines,
    ...setupLines,
    "",
    "export default function () {",
    ...bodyLines,
    "}",
    "",
  ].join("\n");

  return { script, warnings, requiresFiles };
}

/** Sanitize a node ID to a valid JS variable name */
function sanitizeVarName(id: string): string {
  return id.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^(\d)/, "_$1");
}

/** Escape a string for JS string literal */
function escapeString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n");
}

/** Convert operator to JS operator */
function operatorToJs(op: string): string {
  switch (op) {
    case "eq": return "===";
    case "ne": return "!==";
    case "lt": return "<";
    case "lte": return "<=";
    case "gt": return ">";
    case "gte": return ">=";
    default: return "===";
  }
}
