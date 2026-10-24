/**
 * K6F5-01: Graph-to-K6 translator.
 *
 * Converts a GraphDraftComposition to an executable K6 script string.
 * Deterministic: the same graph always produces the same script (init §13).
 */

import { graphReadyCompositionSchema, type GraphDraftComposition } from "./graph-composition";
import { DIAGNOSTIC_TIMEOUT_MS, diagnosticMetadataSchema, diagnosticPrelude, instrumentDiagnosticNode,
  type DiagnosticMetadata, type RunMode } from "./diagnostic";
import type { HttpParameters } from "./http-parameters";
import type { JsonParameterValue, StringParameterValue } from "./parameter-values";
import {
  findSecretEnvCollisions, renderTemplateExpression, secretEnvName, type ResolvedVariables,
} from "./variables";

/**
 * K6 script generation options.
 */
export interface K6TranslatorOptions {
  /** Opt-in application diagnostic events; load remains the default. */
  mode?: RunMode;
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
  code: "unknown-variable" | "missing-value" | "secret-env-collision" | "disabled-dependency" | "no-enabled-nodes" | "invalid-diagnostic";
  /** Empty for graph-level errors. */
  nodeId: string;
  /** Variable name; disabled producer id for "disabled-dependency"; empty for graph-level errors. */
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
  /** Expected IDs in execution order, including disabled/skipped nodes. */
  diagnostic?: DiagnosticMetadata;
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
  const diagnostic = options.mode === "diagnostic";
  const { variables } = options;
  const vus = diagnostic ? 1 : (options.vus ?? 1);
  const duration = options.duration ?? "30s";
  const iterations = diagnostic ? 1 : options.iterations;
  if (diagnostic && !validDiagnosticGraph(graph)) {
    return { script: "", warnings: [], requiresFiles: [], requiredEnv: [], errors: [{
      code: "invalid-diagnostic", nodeId: "", variable: "", message: "Unsupported or incomplete diagnostic graph",
    }] };
  }
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

  // Disabled nodes are bypassed: dropping them from the sorted order keeps the
  // relative order of the remaining nodes, which is the linear bypass.
  const disabledIds = new Set(graph.nodes.filter((n) => n.disabled === true).map((n) => n.id));
  const enabledNodes = graph.nodes.filter((n) => !disabledIds.has(n.id));
  if (graph.nodes.length > 0 && enabledNodes.length === 0) {
    addError({
      code: "no-enabled-nodes", nodeId: "", variable: "",
      message: "Graph has no enabled nodes; enable at least one node before running",
    });
  }
  const executionIds = sortedIds.filter((id) => !disabledIds.has(id));
  const blockDisabledDependency = (nodeId: string, producerNodeId: string) => addError({
    code: "disabled-dependency", nodeId, variable: producerNodeId,
    message: `Node ${nodeId} depends on disabled node ${producerNodeId}`,
  });
  for (const id of executionIds) {
    const node = nodeMap.get(id);
    if (!node) continue;
    for (const producerNodeId of referencedProducers(node)) {
      if (disabledIds.has(producerNodeId)) blockDisabledDependency(id, producerNodeId);
    }
  }

  // Preserve legacy load names only when their generated binding families cannot
  // overlap. Reserved ordinal names never derive from user-controlled text.
  const legacyNames = sortedIds.map(sanitizeVarName);
  const nodeNames = new Map(sortedIds.map((id, index) => {
    const legacy = legacyNames[index];
    const safe = /^[A-Za-z_][A-Za-z0-9_]*$/.test(legacy) && !RESERVED_IDENTIFIERS.has(legacy)
      && !legacy.startsWith("__") && !legacyNames.some((other, otherIndex) => otherIndex !== index
        && (legacy === other || legacy.startsWith(other + "_") || other.startsWith(legacy + "_")));
    return [id, diagnostic ? `__node${index}` : safe ? legacy : `__k6flow_node${index}`];
  }));

  // Waits live on connections: the pause after a node's request and before the
  // next one. A disabled endpoint makes the edge moot, so it is not waited for.
  const waitsBySource = new Map<string, number[]>();
  for (const conn of graph.connections) {
    if (disabledIds.has(conn.source) || disabledIds.has(conn.target)) continue;
    const wait = conn.waitSeconds;
    if (wait === undefined || wait <= 0) continue;
    waitsBySource.set(conn.source, [...(waitsBySource.get(conn.source) ?? []), wait]);
  }

  // Generate imports
  const imports: string[] = ["import http from 'k6/http';"];
  if (diagnostic) imports.push("import { Counter } from 'k6/metrics';");
  const hasChecks = enabledNodes.some((n) => n.kind === "response-validation");
  if (hasChecks) {
    imports.push("import { check } from 'k6';");
  }
  if (waitsBySource.size > 0) {
    imports.push("import { sleep } from 'k6';");
  }
  const hasUserPool = enabledNodes.some((n) => n.kind === "user-pool");
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
  if (diagnostic) optionsLines.push(`  maxDuration: '${DIAGNOSTIC_TIMEOUT_MS / 1000}s',`, "  gracefulStop: '0s',");
  optionsLines.push("};");

  // Generate setup for user pools
  const setupLines: string[] = [];
  for (const node of enabledNodes) {
    if (node.kind === "user-pool" && node.parameters) {
      const poolVar = nodeNames.get(node.id)!;
      const params = node.parameters;
      const mode = params.mode ?? "csv";
      
      if (mode === "manual" && params.manualUsers && params.manualUsers.length > 0) {
        // Manual mode: embed users directly in script
        // WARNING: Passwords are embedded in plain text - use CSV mode for production!
        setupLines.push("");
        setupLines.push(`// User pool (manual): ${JSON.stringify(node.id)}`);
        setupLines.push("// WARNING: Passwords embedded in script. Use CSV mode for production.");
        // Use JSON.stringify for safe serialization of user data
        const usersJson = JSON.stringify(params.manualUsers);
        // Use JSON.stringify for safe string escaping in generated JS
        const safeNodeId = JSON.stringify(node.id);
        setupLines.push(`const ${poolVar}_data = new SharedArray(${safeNodeId}, function () {`);
        setupLines.push(`  return ${usersJson};`);
        setupLines.push("});");
      } else if (params.attachment) {
        // CSV mode: load from file
        const fileId = params.attachment.id;
        requiresFiles.push(`${fileId}.csv`);
        setupLines.push("");
        setupLines.push(`// User pool: ${JSON.stringify(node.id)}`);
        // Use JSON.stringify for safe string escaping in generated JS
        const safeFileId = JSON.stringify(fileId);
        const safeFilePath = JSON.stringify(`./${fileId}.csv`);
        setupLines.push(`const ${poolVar}_data = new SharedArray(${safeFileId}, function () {`);
        setupLines.push(`  return papaparse.parse(open(${safeFilePath}), { header: true }).data;`);
        setupLines.push("});");
      }
    }
  }

  // Generate default function body
  const bodyLines: string[] = [];
  const varMap = new Map<string, string>(); // node.id -> variable name

  if (diagnostic) bodyLines.push("  __diagSeq = 0;", "  let __diagFailed = false;");
  for (const id of diagnostic ? sortedIds : executionIds) {
    const node = nodeMap.get(id);
    if (!node) continue;
    if (diagnostic && disabledIds.has(id)) {
      bodyLines.push(...instrumentDiagnosticNode([], id, true, []));
      continue;
    }
    const start = bodyLines.length;
    const varName = nodeNames.get(id)!;

    switch (node.kind) {
      case "user-pool": {
        if (!node.parameters) break;
        const params = node.parameters;
        // Skip if no data configured
        if (!params.manualUsers && !params.attachment) break;
        if (params.manualUsers && params.manualUsers.length === 0) break;
        
        bodyLines.push("");
        bodyLines.push(`  // ${node.id}`);
        bodyLines.push(`  const ${varName} = ${varName}_data[${diagnostic ? "(__VU - 1)" : "__VU"} % ${varName}_data.length];`);
        
        // Map outputs - use explicit outputs if defined, otherwise infer from manualUsers fields
        let outputNames: string[] = [];
        if (params.outputs && params.outputs.length > 0) {
          outputNames = params.outputs.map((o: { name: string }) => o.name);
        } else if (params.manualUsers && params.manualUsers.length > 0) {
          // Infer outputs from the keys of the first manual user
          outputNames = Object.keys(params.manualUsers[0]);
        }
        
        for (const name of outputNames) {
          const field = diagnostic ? params.outputs?.find(output => output.name === name)?.header ?? name : name;
          varMap.set(`${id}.${name}`, `${varName}[${JSON.stringify(field)}]`);
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
            let resolved = false;
            for (const [key, mappedVar] of varMap.entries()) {
              if (key.endsWith(`.${field.variable}`)) {
                // mappedVar is already safe (uses bracket notation with JSON.stringify)
                value = mappedVar;
                resolved = true;
                break;
              }
            }
            // An implicit dependency on a disabled pool must block, not fall back.
            if (diagnostic && !resolved) addError({ code: "invalid-diagnostic", nodeId: id, variable: "",
              message: "Unresolved diagnostic authentication input" });
            if (!resolved) {
              for (const pool of graph.nodes) {
                if (disabledIds.has(pool.id) && userPoolOutputNames(pool).includes(field.variable)) {
                  blockDisabledDependency(id, pool.id);
                }
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
        
        const authBaseUrl = req.url.kind === "reference"
          ? varMap.get(`${req.url.reference.producerNodeId}.${req.url.reference.output}`) ?? "''"
          : interpolate(url, node.id, JSON.stringify(url));
        const authUrl = requestQuery(authBaseUrl, req, node.id, varMap, interpolate);
        if (diagnostic && !params.bodyTemplate?.length && req.body && "value" in req.body) {
          const value = req.body.value;
          authBody = value.kind === "literal" ? interpolate(value.value, node.id, JSON.stringify(value.value))
            : varMap.get(`${value.reference.producerNodeId}.${value.reference.output}`) ?? "null";
        }
        bodyLines.push(diagnostic
          ? `  const ${varName}_res = http.request(${JSON.stringify(method)}, ${authUrl}, ${authBody}, {`
          : `  const ${varName}_res = http.${method.toLowerCase()}(${authUrl}, ${authBody}, {`);
        const authHeaders = (diagnostic ? req.headers ?? [] : []).map(header => {
          const value = parameterExpression(header.value, node.id, varMap, interpolate);
          return `[${JSON.stringify(header.name)}]: ${value}`;
        });
        bodyLines.push(diagnostic
          ? `    headers: { 'Content-Type': 'application/json', ${authHeaders.join(", ")} }, timeout: '${DIAGNOSTIC_TIMEOUT_MS / 1000}s',`
          : "    headers: { 'Content-Type': 'application/json' },");
        bodyLines.push("  });");

        if (diagnostic) {
          bodyLines.push(`  __diagStatus = ${varName}_res.status;`);
          bodyLines.push(`  if (__diagStatus < 200 || __diagStatus >= 400) __diagReason = 'http';`);
          bodyLines.push(`  if (__diagReason === 'none') {`);
          bodyLines.push(`  __diagReason = 'extraction';`);
        }
        // Extract outputs
        if (params.outputs && Array.isArray(params.outputs)) {
          for (const output of params.outputs) {
            if (output.selector?.kind === "json-path") {
              // Filter empty segments (can occur during UI editing)
              const jsonPath = output.selector.path.filter(Boolean).join(".");
              const index = params.outputs.indexOf(output);
              const suffix = sanitizeVarName(output.name);
              const safe = !["res", "body", "data", "checks"].includes(suffix) && !suffix.startsWith("__output")
                && params.outputs.every((other, otherIndex) => otherIndex === index || sanitizeVarName(other.name) !== suffix);
              const outputVar = diagnostic ? `${varName}_output${index}`
                : `${varName}_${safe ? suffix : `__output${index}`}`;
              const selector = diagnostic ? `${varName}_res.json()${output.selector.path.map(segment => `[${JSON.stringify(segment)}]`).join("")}`
                : `${varName}_res.json(${JSON.stringify(jsonPath)})`;
              bodyLines.push(`  const ${outputVar} = ${selector};`);
              if (diagnostic) bodyLines.push(`  if (${outputVar} === undefined || ${outputVar} === null${output.expectedType === "string" ? ` || typeof ${outputVar} !== 'string'` : ""}) throw new Error('extraction');`);
              varMap.set(`${id}.${output.name}`, outputVar);
            }
          }
        }
        if (diagnostic) bodyLines.push(`  __diagReason = 'none';`, `  }`);
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
          url = interpolate(trimmed, node.id, JSON.stringify(trimmed));
        } else if (params.url.kind === "reference") {
          const ref = params.url.reference;
          url = varMap.get(`${ref.producerNodeId}.${ref.output}`) ?? "''";
        }

        url = requestQuery(url, params, node.id, varMap, interpolate);
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
        
        if (diagnostic) {
          if (params.body && 'value' in params.body && params.body.value.kind === 'reference') {
            const ref = params.body.value.reference;
            body = varMap.get(`${ref.producerNodeId}.${ref.output}`) ?? "null";
          }
          bodyLines.push(`  const ${varName}_res = http.request(${JSON.stringify(method)}, ${url}, ${body}, {`);
          bodyLines.push(`    headers: ${headersObj}, timeout: '${DIAGNOSTIC_TIMEOUT_MS / 1000}s',`);
          bodyLines.push("  });");
        } else if (methodsWithBody.includes(method.toUpperCase())) {
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
        bodyLines.push(`  ${diagnostic ? `const ${varName}_checks = ` : ""}check(${responseVar}, {`);

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
          bodyLines.push(`    [${JSON.stringify(chk.name)}]: ${checkExpr},`);
        }

        bodyLines.push("  });");
        break;
      }
    }
    if (diagnostic) {
      const success: string[] = [];
      if (node.kind === "http-request") success.push(
        `  __diagStatus = ${varName}_res.status;`,
        `  if (__diagStatus < 200 || __diagStatus >= 400) __diagReason = 'http';`,
      );
      if (node.kind === "response-validation") success.push(`  if (!${varName}_checks) __diagReason = 'check';`);
      if (node.kind === "user-pool") {
        success.push(`  if (!${varName}) __diagReason = 'pool';`);
        for (const output of node.parameters?.outputs ?? []) success.push(`  if (!${varName} || typeof ${varName}[${JSON.stringify(output.header)}] !== 'string') __diagReason = 'pool';`);
      }
      bodyLines.push(...instrumentDiagnosticNode(bodyLines.splice(start), id, false, success));
    }
    // The wait belongs to the edge leaving this node, so it lands after the
    // node's own work and before the next request.
    for (const wait of waitsBySource.get(id) ?? []) {
      bodyLines.push(`  sleep(${wait});`);
    }
  }
  if (diagnostic) bodyLines.push("  __diagEmit('', 'complete', 0, 0, __diagFailed ? 'failure' : 'success', __diagFailed ? 'prior-failure' : 'none');");

  // Assemble script
  const script = [
    "// Generated by k6flow",
    "// Do not edit manually",
    "",
    ...imports,
    "",
    ...optionsLines,
    ...setupLines,
    ...(diagnostic ? diagnosticPrelude() : []),
    ...(graph.nodes.some(n => (n.kind === "http-request" && n.parameters?.query?.length) ||
      (n.kind === "authentication" && n.parameters?.method.request.query?.length)) ? [QUERY_HELPER] : []),
    "",
    "export default function () {",
    ...bodyLines.map(line => line.trimStart().startsWith("//") ? line.replace(/\r/g, "\\r").replace(/\n/g, "\\n") : line),
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

  return { script, warnings, requiresFiles, errors, requiredEnv,
    ...(diagnostic ? { diagnostic: { nodeIds: sortedIds } } : {}),
  };
}

/** Producer node ids a node consumes: declared references plus embedded parameter references. */
function referencedProducers(node: GraphNode): string[] {
  const ids = new Set(node.references.map((reference) => reference.producerNodeId));
  const add = (value: StringParameterValue | JsonParameterValue | undefined) => {
    if (value?.kind === "reference") ids.add(value.reference.producerNodeId);
  };
  const addRequest = (request: HttpParameters) => {
    add(request.url);
    for (const entry of request.headers ?? []) add(entry.value);
    for (const entry of request.query ?? []) add(entry.value);
    if (request.body && "value" in request.body) add(request.body.value);
  };
  if (node.kind === "http-request" && node.parameters) addRequest(node.parameters);
  if (node.kind === "authentication" && node.parameters?.method.kind === "http") {
    addRequest(node.parameters.method.request);
  }
  if (node.kind === "response-validation" && node.parameters?.response) {
    ids.add(node.parameters.response.producerNodeId);
  }
  return [...ids].sort();
}

/** Output names a user pool exposes, mirroring the body generation below. */
function userPoolOutputNames(node: GraphNode): string[] {
  if (node.kind !== "user-pool" || !node.parameters) return [];
  const params = node.parameters;
  if (params.outputs && params.outputs.length > 0) return params.outputs.map((o) => o.name);
  return params.manualUsers?.[0] ? Object.keys(params.manualUsers[0]) : [];
}

/** Reject drafts and translator features that cannot be faithfully diagnosed. */
function validDiagnosticGraph(graph: GraphDraftComposition): boolean {
  if (!diagnosticMetadataSchema.safeParse({ nodeIds: graph.nodes.map(node => node.id) }).success) return false;
  const ready = graphReadyCompositionSchema.safeParse({ ...graph, load: {
    version: 1, profile: { kind: "constant-vus", vus: 1, durationMs: DIAGNOSTIC_TIMEOUT_MS },
    thresholds: [], thresholdPolicy: "final-pass-fail",
  } });
  if (!ready.success) return false;
  return graph.nodes.every(node => {
    const request = node.kind === "http-request" ? node.parameters
      : node.kind === "authentication" ? node.parameters?.method.request : undefined;
    if (request?.url.kind === "literal" && !request.url.value.trim()) return false;
    if (node.kind === "user-pool") {
      const params = node.parameters;
      return params?.mode === "manual" ? !!params.manualUsers?.length : !!params?.attachment;
    }
    if (node.kind === "authentication") return node.parameters?.outputs.every(output => output.selector.kind === "json-path");
    if (node.kind === "response-validation") return node.parameters?.checks.every(check =>
      check.kind === "status" || check.kind === "duration-ms" ||
      (check.kind === "body-text" && check.predicate.operator === "contains-literal"));
    return true;
  });
}

const QUERY_HELPER = `function __k6flowQuery(url, entries) {
  url = String(url);
  const hash = url.indexOf('#');
  const base = hash < 0 ? url : url.slice(0, hash);
  const fragment = hash < 0 ? '' : url.slice(hash);
  const separator = base.indexOf('?') < 0 ? '?' : /[?&]$/.test(base) ? '' : '&';
  return base + separator + entries.map(entry => encodeURIComponent(entry[0]) + '=' + encodeURIComponent(String(entry[1]))).join('&') + fragment;
}`;

function parameterExpression(value: StringParameterValue, nodeId: string, varMap: Map<string, string>,
  interpolate: (text: string, nodeId: string, fallback: string) => string): string {
  if (value.kind === "literal") return interpolate(value.value, nodeId, JSON.stringify(value.value));
  return varMap.get(`${value.reference.producerNodeId}.${value.reference.output}`) ?? "''";
}

function requestQuery(url: string, params: HttpParameters, nodeId: string, varMap: Map<string, string>,
  interpolate: (text: string, nodeId: string, fallback: string) => string): string {
  if (!params.query?.length) return url;
  return `__k6flowQuery(${url}, [${params.query.map(entry =>
    `[${JSON.stringify(entry.name)}, ${parameterExpression(entry.value, nodeId, varMap, interpolate)}]`).join(", ")}])`;
}

// Keywords and globals that a standalone pool binding must not shadow.
const RESERVED_IDENTIFIERS = new Set(("await break case catch class const continue debugger default delete do else enum export extends false finally for function if implements import in instanceof interface let new null package private protected public return static super switch this throw true try typeof var void while with yield arguments eval http check SharedArray papaparse open options Date encodeURIComponent String JSON undefined NaN Infinity").split(" "));

/** Sanitize a node ID to a valid JS variable name */
function sanitizeVarName(id: string): string {
  return id.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^(\d)/, "_$1");
}

/** Escape a string for JS string literal */
function escapeString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n").replace(/\r/g, "\\r");
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
