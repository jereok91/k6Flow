/**
 * K6F5-01: Graph-to-K6 translator.
 *
 * Converts a GraphDraftComposition to an executable K6 script string.
 * Deterministic: the same graph always produces the same script (init §13).
 */

import type { GraphDraftComposition } from "./graph-composition";
import {
  findSecretEnvCollisions, renderTemplateExpression, secretEnvName, type ResolvedVariables,
} from "./variables";

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
  /**
   * Resolved `{{name}}` variables. When omitted, placeholders are not interpolated
   * (output stays byte-identical to the pre-variables translator).
   */
  variables?: ResolvedVariables;
}

/** A translation problem that should block running the script. */
export interface K6TranslationError {
  code: "unknown-variable" | "missing-value" | "secret-env-collision";
  nodeId: string;
  variable: string;
  message: string;
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
  /** Blocking problems (e.g. unknown variables). Empty when the script is runnable. */
  errors: K6TranslationError[];
  /** Env names (unique, sorted) of referenced secret variables the run must inject. */
  requiredEnv: string[];
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
  const { vus = 1, duration = "30s", iterations, variables } = options;
  const warnings: string[] = [];
  const requiresFiles: string[] = [];
  const errors: K6TranslationError[] = [];
  const errorKeys = new Set<string>();
  const secretFirstNode = new Map<string, string>(); // secret name -> first node id

  const addError = (error: K6TranslationError) => {
    const key = `${error.code}\u0000${error.nodeId}\u0000${error.variable}`;
    if (errorKeys.has(key)) return;
    errorKeys.add(key);
    errors.push(error);
  };

  /**
   * Interpolates `{{name}}` placeholders in a literal. Returns `fallback` (the exact
   * pre-variables output) when no variables were supplied or the text has no placeholder.
   */
  const interpolate = (text: string, nodeId: string, fallback: string): string => {
    if (!variables) return fallback;
    const rendered = renderTemplateExpression(text, variables);
    if (!rendered) return fallback;
    for (const name of rendered.unknown) {
      addError({ code: "unknown-variable", nodeId, variable: name,
        message: `Unknown variable "{{${name}}}" in node ${nodeId}` });
    }
    for (const name of rendered.missingValue) {
      addError({ code: "missing-value", nodeId, variable: name,
        message: `Variable "{{${name}}}" in node ${nodeId} has no value` });
    }
    for (const name of rendered.secretNames) {
      if (!secretFirstNode.has(name)) secretFirstNode.set(name, nodeId);
    }
    return rendered.expression;
  };

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
        // WARNING: Passwords are embedded in plain text - use CSV mode for production!
        setupLines.push("");
        setupLines.push(`// User pool (manual): ${node.id}`);
        setupLines.push("// WARNING: Passwords embedded in script. Use CSV mode for production.");
        // Use JSON.stringify for safe serialization of user data
        const usersJson = JSON.stringify(params.manualUsers);
        // Use JSON.stringify for safe string escaping in generated JS
        const safeNodeId = JSON.stringify(node.id);
        setupLines.push(`const ${sanitizeVarName(node.id)}_data = new SharedArray(${safeNodeId}, function () {`);
        setupLines.push(`  return ${usersJson};`);
        setupLines.push("});");
      } else if (params.attachment) {
        // CSV mode: load from file
        const fileId = params.attachment.id;
        requiresFiles.push(`${fileId}.csv`);
        setupLines.push("");
        setupLines.push(`// User pool: ${node.id}`);
        // Use JSON.stringify for safe string escaping in generated JS
        const safeFileId = JSON.stringify(fileId);
        const safeFilePath = JSON.stringify(`./${fileId}.csv`);
        setupLines.push(`const ${sanitizeVarName(node.id)}_data = new SharedArray(${safeFileId}, function () {`);
        setupLines.push(`  return papaparse.parse(open(${safeFilePath}), { header: true }).data;`);
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
        // Skip if no data configured
        if (!params.manualUsers && !params.attachment) break;
        if (params.manualUsers && params.manualUsers.length === 0) break;
        
        bodyLines.push("");
        bodyLines.push(`  // ${node.id}`);
        bodyLines.push(`  const ${varName} = ${varName}_data[__VU % ${varName}_data.length];`);
        
        // Map outputs - use explicit outputs if defined, otherwise infer from manualUsers fields
        let outputNames: string[] = [];
        if (params.outputs && params.outputs.length > 0) {
          outputNames = params.outputs.map((o: { name: string }) => o.name);
        } else if (params.manualUsers && params.manualUsers.length > 0) {
          // Infer outputs from the keys of the first manual user
          outputNames = Object.keys(params.manualUsers[0]);
        }
        
        for (const name of outputNames) {
          varMap.set(`${id}.${name}`, `${varName}[${JSON.stringify(name)}]`);
        }
        break;
      }

      case "authentication": {
        if (!node.parameters) break;
        const params = node.parameters;
        // Skip if no method configured
        if (!params.method || params.method.kind !== "http" || !params.method.request) break;
        
        const req = params.method.request;
        const method = req.method;
        const url = req.url?.kind === "literal" ? req.url.value.trim() : "";

        bodyLines.push("");
        bodyLines.push(`  // ${node.id}`);
        
        // Generate body from bodyTemplate if available
        let authBody = "null";
        if (params.bodyTemplate && params.bodyTemplate.length > 0) {
          const bodyObj: string[] = [];
          for (const field of params.bodyTemplate) {
            // Sanitize field key to prevent code injection
            const safeKey = JSON.stringify(field.key);
            // Sanitize variable name for safe fallback placeholder
            const safeVariable = sanitizeVarName(field.variable);
            // Look up variable in varMap (from User Pool outputs)
            let value = `"{{${safeVariable}}}"`; // fallback placeholder - sanitized
            // Try to find the variable from connected User Pool
            for (const [key, mappedVar] of varMap.entries()) {
              if (key.endsWith(`.${field.variable}`)) {
                // mappedVar is already safe (uses bracket notation with JSON.stringify)
                value = mappedVar;
                break;
              }
            }
            // Use bracket notation with quoted key for safety
            bodyObj.push(`    [${safeKey}]: ${value}`);
          }
          bodyLines.push(`  const ${varName}_body = JSON.stringify({`);
          bodyLines.push(bodyObj.join(",\n"));
          bodyLines.push("  });");
          authBody = `${varName}_body`;
        }
        
        const authUrl = interpolate(url, node.id, `'${url}'`);
        bodyLines.push(`  const ${varName}_res = http.${method.toLowerCase()}(${authUrl}, ${authBody}, {`);
        bodyLines.push("    headers: { 'Content-Type': 'application/json' },");
        bodyLines.push("  });");

        // Extract outputs
        if (params.outputs && Array.isArray(params.outputs)) {
          for (const output of params.outputs) {
            if (output.selector?.kind === "json-path") {
              // Filter empty segments (can occur during UI editing)
              const jsonPath = output.selector.path.filter(Boolean).join(".");
              bodyLines.push(`  const ${varName}_${output.name} = ${varName}_res.json('${jsonPath}');`);
              varMap.set(`${id}.${output.name}`, `${varName}_${output.name}`);
            }
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
          const trimmed = params.url.value.trim();
          url = interpolate(trimmed, node.id, `'${trimmed}'`);
        } else if (params.url.kind === "reference") {
          const ref = params.url.reference;
          url = varMap.get(`${ref.producerNodeId}.${ref.output}`) ?? "''";
        }

        let body = "null";
        let contentType = "application/json";
        // JSON bodies are interpolated on the raw text; values are not JSON-escaped.
        const literalBody = (text: string) => interpolate(text, node.id, `'${escapeString(text)}'`);
        
        if (params.body?.kind === "json" && params.body.value?.kind === "literal") {
          body = literalBody(params.body.value.value);
          contentType = "application/json";
        } else if (params.body?.kind === "xml" && params.body.value?.kind === "literal") {
          body = literalBody(params.body.value.value);
          contentType = "application/xml";
        } else if (params.body?.kind === "form" && params.body.value?.kind === "literal") {
          body = literalBody(params.body.value.value);
          contentType = "application/x-www-form-urlencoded";
        } else if (params.body?.kind === "text" && params.body.value?.kind === "literal") {
          body = literalBody(params.body.value.value);
          contentType = "text/plain";
        }

        // Build headers object with both literal values and variable references
        const headerEntries: string[] = [];
        const methodsWithBody = ["POST", "PUT", "PATCH", "DELETE"];
        
        // Add Content-Type for methods with body
        if (methodsWithBody.includes(method.toUpperCase()) && body !== "null") {
          headerEntries.push(`'Content-Type': '${contentType}'`);
        }
        
        // Add user-defined headers
        if (params.headers && Array.isArray(params.headers)) {
          for (const header of params.headers) {
            if (!header.name) continue; // Skip headers without name
            const headerName = escapeString(header.name);
            let headerValue: string;
            
            if (header.value.kind === "literal") {
              const text = header.value.value ?? "";
              headerValue = interpolate(text, node.id, `'${escapeString(text)}'`);
            } else if (header.value.kind === "reference" && header.value.reference) {
              // Look up the variable from the varMap
              const ref = header.value.reference;
              const varRef = varMap.get(`${ref.producerNodeId}.${ref.output}`);
              if (varRef) {
                // For Authorization header with Bearer pattern, wrap it
                if (header.name.toLowerCase() === "authorization") {
                  headerValue = `'Bearer ' + ${varRef}`;
                } else {
                  headerValue = varRef;
                }
              } else {
                // Fallback to placeholder if variable not found
                headerValue = `'{{${ref.output}}}'`;
              }
            } else {
              continue; // Skip invalid header values
            }
            
            headerEntries.push(`'${headerName}': ${headerValue}`);
          }
        }

        bodyLines.push("");
        bodyLines.push(`  // ${node.id}`);
        
        // Generate headers object
        const headersObj = headerEntries.length > 0
          ? `{ ${headerEntries.join(", ")} }`
          : "{}";
        
        if (methodsWithBody.includes(method.toUpperCase())) {
          bodyLines.push(`  const ${varName}_res = http.${method.toLowerCase()}(${url}, ${body}, {`);
          bodyLines.push(`    headers: ${headersObj},`);
          bodyLines.push("  });");
        } else {
          // GET, HEAD, OPTIONS - no body parameter
          bodyLines.push(`  const ${varName}_res = http.${method.toLowerCase()}(${url}, {`);
          bodyLines.push(`    headers: ${headersObj},`);
          bodyLines.push("  });");
        }
        varMap.set(`${id}.response`, `${varName}_res`);
        break;
      }

      case "response-validation": {
        if (!node.parameters) break;
        const params = node.parameters;
        // Skip if no response reference or checks configured
        if (!params.response || !params.checks || params.checks.length === 0) break;
        
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

  // Secrets whose names map to the same env name cannot be told apart at run time.
  for (const collision of findSecretEnvCollisions(
    [...secretFirstNode.keys()].map((name) => [name, { secret: true }] as [string, { secret: boolean }]),
  )) {
    const variable = collision.names[0];
    const nodeId = secretFirstNode.get(variable)!;
    addError({ code: "secret-env-collision", nodeId, variable,
      message: `Secret variables ${collision.names.map((n) => `"{{${n}}}"`).join(", ")} ` +
        `all map to env ${collision.envName}` });
  }
  const requiredEnv = [...new Set(
    [...secretFirstNode.keys()].map(secretEnvName),
  )].sort();

  return { script, warnings, requiresFiles, errors, requiredEnv };
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
