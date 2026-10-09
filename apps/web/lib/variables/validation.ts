// k6flow-variables V-T2: pure validation for variable sets and environment
// names. No DB access; the store and routes build on these.

import { findSecretEnvCollisions, isValidVariableName } from "@k6flow/shared";
import type { VariableDefinition } from "@k6flow/shared";

export const MAX_VARIABLES_PER_SET = 200;
/** Maximum value size in UTF-8 bytes (8 KiB). */
export const MAX_VARIABLE_VALUE_BYTES = 8 * 1024;
export const MAX_ENVIRONMENT_NAME_LENGTH = 100;

export type VariableErrorCode =
  | "invalid-shape"
  | "invalid-name"
  | "duplicate-name"
  | "value-too-large"
  | "too-many"
  | "secret-env-collision"
  | "missing-value";

/** One structured error. `index` is the position in the submitted list; null = whole set. */
export interface VariableError {
  index: number | null;
  field: "name" | "value" | "secret" | null;
  code: VariableErrorCode;
  message: string;
}

/**
 * One item of a "replace set" request. For secrets, `value: null` (or an omitted
 * value) means "keep the stored value", so the UI never has to resend a secret.
 */
export interface VariableReplaceItem {
  name: string;
  value: string | null;
  secret: boolean;
}

const encoder = new TextEncoder();

/** Validates a complete variable set (names, uniqueness, size, count, secret env collisions). */
export function validateVariableSet(variables: readonly VariableDefinition[]): VariableError[] {
  if (variables.length > MAX_VARIABLES_PER_SET) {
    return [tooMany(variables.length)];
  }
  const errors: VariableError[] = [];
  const seen = new Set<string>();
  variables.forEach((variable, index) => {
    if (!isValidVariableName(variable.name)) {
      errors.push({
        index,
        field: "name",
        code: "invalid-name",
        message: `Invalid variable name "${variable.name}": must start with a letter or "_" and contain up to 64 of [A-Za-z0-9_.-]`,
      });
    } else if (seen.has(variable.name)) {
      errors.push({
        index,
        field: "name",
        code: "duplicate-name",
        message: `Duplicate variable name "${variable.name}"`,
      });
    }
    seen.add(variable.name);
    if (encoder.encode(variable.value).length > MAX_VARIABLE_VALUE_BYTES) {
      errors.push({
        index,
        field: "value",
        code: "value-too-large",
        message: `Value of "${variable.name}" exceeds ${MAX_VARIABLE_VALUE_BYTES} bytes`,
      });
    }
  });
  const collisions = findSecretEnvCollisions(
    variables.map((variable): [string, { secret: boolean }] => [variable.name, { secret: variable.secret }]),
  );
  for (const collision of collisions) {
    errors.push({
      index: null,
      field: "name",
      code: "secret-env-collision",
      message: `Secret variables ${collision.names.map((n) => `"${n}"`).join(", ")} all map to ${collision.envName}; rename one of them`,
    });
  }
  return errors;
}

export type ParseVariableSetResult =
  | { ok: true; items: VariableReplaceItem[] }
  | { ok: false; errors: VariableError[] };

/** Parses a PUT body `{ variables: [{ name, value?, secret? }] }` (shape only). */
export function parseVariableSetBody(body: unknown): ParseVariableSetResult {
  const list =
    typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as { variables?: unknown }).variables
      : undefined;
  if (!Array.isArray(list)) {
    return {
      ok: false,
      errors: [{ index: null, field: null, code: "invalid-shape", message: "Body must be { variables: [...] }" }],
    };
  }
  if (list.length > MAX_VARIABLES_PER_SET) {
    return { ok: false, errors: [tooMany(list.length)] };
  }
  const items: VariableReplaceItem[] = [];
  const errors: VariableError[] = [];
  list.forEach((raw, index) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      errors.push(shapeError(index, null, "Each variable must be an object"));
      return;
    }
    const { name, value, secret } = raw as { name?: unknown; value?: unknown; secret?: unknown };
    if (typeof name !== "string") {
      errors.push(shapeError(index, "name", "name must be a string"));
      return;
    }
    if (value !== undefined && value !== null && typeof value !== "string") {
      errors.push(shapeError(index, "value", "value must be a string or null"));
      return;
    }
    if (secret !== undefined && typeof secret !== "boolean") {
      errors.push(shapeError(index, "secret", "secret must be a boolean"));
      return;
    }
    items.push({ name, value: value ?? null, secret: secret ?? false });
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, items };
}

export type PrepareReplacementResult =
  | { ok: true; variables: VariableDefinition[] }
  | { ok: false; errors: VariableError[] };

/**
 * "Replace set" semantics: the client sends the full list and anything omitted is
 * deleted. A secret item with `value: null` keeps the stored value of the variable
 * with the same name. A non-secret item must carry a value, so a stored secret value
 * can never be turned into readable plaintext. The merged set is then validated.
 */
export function prepareVariableReplacement(
  items: readonly VariableReplaceItem[],
  existing: readonly VariableDefinition[],
): PrepareReplacementResult {
  const stored = new Map(existing.map((variable) => [variable.name, variable.value]));
  const errors: VariableError[] = [];
  const variables: VariableDefinition[] = [];
  // Submitted index of each entry in `variables` (missing-value items are skipped).
  const origin: number[] = [];
  items.forEach((item, index) => {
    if (item.value !== null) {
      variables.push({ name: item.name, value: item.value, secret: item.secret });
      origin.push(index);
      return;
    }
    const kept = item.secret ? stored.get(item.name) : undefined;
    if (kept === undefined) {
      errors.push({
        index,
        field: "value",
        code: "missing-value",
        message: item.secret
          ? `Secret "${item.name}" has no stored value; provide one`
          : `Variable "${item.name}" needs a value`,
      });
      return;
    }
    variables.push({ name: item.name, value: kept, secret: true });
    origin.push(index);
  });
  for (const error of validateVariableSet(variables)) {
    errors.push(error.index === null ? error : { ...error, index: origin[error.index] });
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, variables };
}

export type ParseEnvironmentNameResult = { ok: true; name: string } | { ok: false; message: string };

export function parseEnvironmentName(body: unknown): ParseEnvironmentNameResult {
  const name =
    typeof body === "object" && body !== null ? (body as { name?: unknown }).name : undefined;
  if (typeof name !== "string" || name.trim() === "") {
    return { ok: false, message: "Environment name must be a non-empty string" };
  }
  const trimmed = name.trim();
  if (trimmed.length > MAX_ENVIRONMENT_NAME_LENGTH) {
    return { ok: false, message: `Environment name must be at most ${MAX_ENVIRONMENT_NAME_LENGTH} characters` };
  }
  return { ok: true, name: trimmed };
}

function tooMany(count: number): VariableError {
  return {
    index: null,
    field: null,
    code: "too-many",
    message: `At most ${MAX_VARIABLES_PER_SET} variables per set (got ${count})`,
  };
}

function shapeError(index: number, field: VariableError["field"], message: string): VariableError {
  return { index, field, code: "invalid-shape", message };
}
