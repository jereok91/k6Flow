/**
 * Postman-style `{{name}}` variables (k6flow-variables V-T1).
 *
 * Placeholders live inside literal string parameters; the graph schema is unchanged.
 * - Syntax: `{{name}}` or `{{ name }}` (surrounding whitespace trimmed).
 * - Names match `VARIABLE_NAME_PATTERN`.
 * - Malformed placeholders (`{{}}`, `{{bad name}}`, unclosed `{{x`) stay literal text.
 * - There is no escape syntax: `\{{x}}` is a literal backslash followed by a placeholder.
 */

/** Variable name: starts with a letter or `_`, up to 64 characters of `[A-Za-z0-9_.-]`. */
export const VARIABLE_NAME_PATTERN = "[A-Za-z_][A-Za-z0-9_.-]{0,63}";
const VARIABLE_NAME_REGEX = new RegExp(`^${VARIABLE_NAME_PATTERN}$`);

/** Prefix of the k6 environment variable that carries a secret value. */
export const SECRET_ENV_PREFIX = "K6FLOW_VAR_";

export type TemplateSegment =
  | { type: "text"; value: string }
  | { type: "var"; name: string };

export interface VariableDefinition {
  name: string;
  value: string;
  secret: boolean;
}

/** Input to `mergeVariables`; secrets may have no value on the client. */
export type VariableInput = Omit<VariableDefinition, "value"> & { value?: string };

/** Resolved variables by name. `value` may be absent for secrets on the client. */
export type ResolvedVariables = Map<string, { value?: string; secret: boolean }>;

export function isValidVariableName(name: string): boolean {
  return VARIABLE_NAME_REGEX.test(name);
}

/** Splits text into literal text and variable segments. Adjacent text is merged. */
export function parseTemplate(text: string): TemplateSegment[] {
  const segments: TemplateSegment[] = [];
  let buffer = "";
  let pos = 0;
  while (pos < text.length) {
    const open = text.indexOf("{{", pos);
    if (open === -1) break;
    const close = text.indexOf("}}", open + 2);
    if (close === -1) break;
    const name = text.slice(open + 2, close).trim();
    if (isValidVariableName(name)) {
      buffer += text.slice(pos, open);
      if (buffer) segments.push({ type: "text", value: buffer });
      buffer = "";
      segments.push({ type: "var", name });
      pos = close + 2;
    } else {
      // Not a placeholder: keep one character and rescan (recovers `{{{x}}}` and `{{a {{b}}`).
      buffer += text.slice(pos, open + 1);
      pos = open + 1;
    }
  }
  buffer += text.slice(pos);
  if (buffer) segments.push({ type: "text", value: buffer });
  return segments;
}

/** Unique variable names in first-appearance order. */
export function findVariables(text: string): string[] {
  const names = new Set<string>();
  for (const segment of parseTemplate(text)) {
    if (segment.type === "var") names.add(segment.name);
  }
  return [...names];
}

/** Merges environment and scenario variables; scenario variables win by name. */
export function mergeVariables(
  environmentVars: readonly VariableInput[],
  scenarioVars: readonly VariableInput[],
): ResolvedVariables {
  const merged: ResolvedVariables = new Map();
  for (const variable of [...environmentVars, ...scenarioVars]) {
    merged.set(variable.name, variable.value === undefined
      ? { secret: variable.secret }
      : { value: variable.value, secret: variable.secret });
  }
  return merged;
}

/**
 * k6 env name for a secret: `K6FLOW_VAR_` + uppercased name with every char outside
 * `[A-Z0-9_]` replaced by `_`. Not injective: `api.key`, `api-key` and `API_KEY` all
 * map to `K6FLOW_VAR_API_KEY`; use `findSecretEnvCollisions` to detect that.
 */
export function secretEnvName(name: string): string {
  return SECRET_ENV_PREFIX + name.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
}

export interface SecretEnvCollision {
  envName: string;
  /** Colliding secret variable names, sorted. */
  names: string[];
}

/** Reports secret variables whose names map to the same env name (sorted by env name). */
export function findSecretEnvCollisions(
  variables: ResolvedVariables | Iterable<[string, { secret: boolean }]>,
): SecretEnvCollision[] {
  const byEnv = new Map<string, Set<string>>();
  for (const [name, variable] of variables) {
    if (!variable.secret) continue;
    const envName = secretEnvName(name);
    const names = byEnv.get(envName) ?? new Set<string>();
    names.add(name);
    byEnv.set(envName, names);
  }
  return [...byEnv.entries()]
    .filter(([, names]) => names.size > 1)
    .map(([envName, names]) => ({ envName, names: [...names].sort() }))
    .sort((a, b) => (a.envName < b.envName ? -1 : a.envName > b.envName ? 1 : 0));
}

/**
 * Safe JS string literal: JSON escaping plus U+2028/U+2029 and `<` escaped, so the
 * literal can never terminate early, start a template/expression, or close a `<script>`.
 */
export function toJsStringLiteral(value: string): string {
  return JSON.stringify(value)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
    .replace(/</g, "\\u003c");
}

export interface RenderedTemplate {
  /** JS expression evaluating to the interpolated string. */
  expression: string;
  /** Unique referenced names missing from `variables`, in order. */
  unknown: string[];
  /** Unique non-secret names present but without a value, in order. */
  missingValue: string[];
  /** Unique referenced secret variable names, in order. */
  secretNames: string[];
  /** Unique env names of referenced secrets, in order. */
  secretEnv: string[];
}

/**
 * Renders text with placeholders as a JS string expression (`"a" + "b" + __ENV["X"]`).
 * Returns null when the text has no placeholder, so callers keep their existing output.
 * Non-secret values are inlined as escaped literals; secret values are never inlined and
 * become `__ENV["K6FLOW_VAR_<NAME>"]`. Unresolved placeholders keep their `{{name}}` text.
 */
export function renderTemplateExpression(
  text: string,
  variables: ResolvedVariables,
): RenderedTemplate | null {
  const segments = parseTemplate(text);
  if (!segments.some((segment) => segment.type === "var")) return null;
  const unknown = new Set<string>();
  const missingValue = new Set<string>();
  const secretNames = new Set<string>();
  const parts: string[] = [];
  for (const segment of segments) {
    if (segment.type === "text") {
      parts.push(toJsStringLiteral(segment.value));
      continue;
    }
    const variable = variables.get(segment.name);
    if (!variable) {
      unknown.add(segment.name);
      parts.push(toJsStringLiteral(`{{${segment.name}}}`));
    } else if (variable.secret) {
      secretNames.add(segment.name);
      parts.push(`__ENV[${toJsStringLiteral(secretEnvName(segment.name))}]`);
    } else if (variable.value === undefined) {
      missingValue.add(segment.name);
      parts.push(toJsStringLiteral(`{{${segment.name}}}`));
    } else {
      parts.push(toJsStringLiteral(variable.value));
    }
  }
  return {
    expression: parts.join(" + "),
    unknown: [...unknown],
    missingValue: [...missingValue],
    secretNames: [...secretNames],
    secretEnv: [...new Set([...secretNames].map(secretEnvName))],
  };
}
