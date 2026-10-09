"use client";

// k6flow-variables V-T4: client hooks for environments and variable sets, plus pure
// helpers for the editable variable table. Secret values never reach the browser:
// reads are masked (`{ name, secret: true, hasValue }`) and a secret left empty is
// sent as `value: null`, which keeps the stored value on the server.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isValidVariableName, mergeVariables } from "@k6flow/shared";

// -----------------------------------------------------------------------------
// API shapes (mirror lib/variables/store.ts and validation.ts)
// -----------------------------------------------------------------------------

export type MaskedVariable =
  | { name: string; value: string; secret: false }
  | { name: string; secret: true; hasValue: boolean };

export interface EnvironmentSummary {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface VariableApiError {
  index: number | null;
  field: "name" | "value" | "secret" | null;
  code: string;
  message: string;
}

export interface VariableReplaceItem {
  name: string;
  value: string | null;
  secret: boolean;
}

export type SaveVariablesResult =
  | { ok: true; variables: MaskedVariable[] }
  | { ok: false; message: string; errors: VariableApiError[] };

export type MutationResult<T> = { ok: true; value: T } | { ok: false; message: string };

export const SELECTED_ENVIRONMENT_STORAGE_KEY = "k6flow.selectedEnvironmentId";

// -----------------------------------------------------------------------------
// Pure helpers for the variable table
// -----------------------------------------------------------------------------

export interface VariableRow {
  /** Stable React key. */
  key: string;
  name: string;
  /** Typed value. For secrets this starts empty: the stored value is never loaded. */
  value: string;
  secret: boolean;
  /** Name as loaded from the server; null for rows added in the browser. */
  originalName: string | null;
  /** True when the server holds a secret value for `originalName`. */
  storedSecret: boolean;
}

export interface RowErrors {
  name?: string;
  value?: string;
}

let rowSeq = 0;
export function newRowKey(): string {
  rowSeq += 1;
  return `var-row-${rowSeq}`;
}

export function emptyVariableRow(): VariableRow {
  return { key: newRowKey(), name: "", value: "", secret: false, originalName: null, storedSecret: false };
}

export function toVariableRows(variables: readonly MaskedVariable[]): VariableRow[] {
  return variables.map((variable) => ({
    key: newRowKey(),
    name: variable.name,
    value: variable.secret ? "" : variable.value,
    secret: variable.secret,
    originalName: variable.name,
    storedSecret: variable.secret ? variable.hasValue : false,
  }));
}

/** True when an empty secret field keeps a stored value (same name, still secret). */
export function keepsStoredSecret(row: VariableRow): boolean {
  return row.secret && row.storedSecret && row.name === row.originalName;
}

/** "Replace set" payload: an empty secret field is sent as null (keep stored value). */
export function toReplacePayload(rows: readonly VariableRow[]): VariableReplaceItem[] {
  return rows.map((row) => ({
    name: row.name,
    value: row.secret && row.value === "" ? null : row.value,
    secret: row.secret,
  }));
}

/** Client-side checks: required/valid names, duplicates, secrets without a value. */
export function validateVariableRows(rows: readonly VariableRow[]): Record<string, RowErrors> {
  const errors: Record<string, RowErrors> = {};
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.name, (counts.get(row.name) ?? 0) + 1);
  for (const row of rows) {
    const rowErrors: RowErrors = {};
    if (row.name === "") {
      rowErrors.name = "Name is required";
    } else if (!isValidVariableName(row.name)) {
      rowErrors.name = 'Invalid name: start with a letter or "_", then up to 64 of A-Z a-z 0-9 _ . -';
    } else if ((counts.get(row.name) ?? 0) > 1) {
      rowErrors.name = `Duplicate name "${row.name}"`;
    }
    if (row.secret && row.value === "" && !keepsStoredSecret(row)) {
      rowErrors.value = "Enter a value for this secret";
    }
    if (rowErrors.name || rowErrors.value) errors[row.key] = rowErrors;
  }
  return errors;
}

/** Maps 422 errors to rows by submitted index; set-level or unmatched errors go to `general`. */
export function mapServerErrors(
  rows: readonly VariableRow[],
  errors: readonly VariableApiError[],
): { rows: Record<string, RowErrors>; general: string[] } {
  const byRow: Record<string, RowErrors> = {};
  const general: string[] = [];
  for (const error of errors) {
    const row = error.index !== null ? rows[error.index] : undefined;
    if (!row) {
      general.push(error.message);
      continue;
    }
    const field = error.field === "value" ? "value" : "name";
    byRow[row.key] = { ...byRow[row.key], [field]: error.message };
  }
  return { rows: byRow, general };
}

/** Names visible to a run: environment variables plus scenario variables. */
export function mergedVariableNames(
  environmentVariables: readonly MaskedVariable[],
  scenarioVariables: readonly MaskedVariable[],
): string[] {
  const strip = (list: readonly MaskedVariable[]) => list.map((v) => ({ name: v.name, secret: v.secret }));
  return [...mergeVariables(strip(environmentVariables), strip(scenarioVariables)).keys()];
}

// -----------------------------------------------------------------------------
// Fetch helpers
// -----------------------------------------------------------------------------

async function readError(res: Response): Promise<{ message: string; errors: VariableApiError[] }> {
  try {
    const body = (await res.json()) as { error?: unknown; errors?: unknown };
    const message = typeof body.error === "string" ? body.error : `Request failed (${res.status})`;
    const errors = Array.isArray(body.errors) ? (body.errors as VariableApiError[]) : [];
    return { message, errors };
  } catch {
    return { message: `Request failed (${res.status})`, errors: [] };
  }
}

const JSON_HEADERS = { "Content-Type": "application/json" };
const EMPTY_VARIABLES: MaskedVariable[] = [];

// -----------------------------------------------------------------------------
// Hooks
// -----------------------------------------------------------------------------

export interface VariableSetState {
  /** False when there is nothing to load (no scenario/environment). */
  enabled: boolean;
  variables: MaskedVariable[];
  loading: boolean;
  saving: boolean;
  error: string | null;
  reload: () => Promise<void>;
  save: (items: VariableReplaceItem[]) => Promise<SaveVariablesResult>;
}

/** Loads and replaces one variable set. `url` null disables the hook. */
export function useVariableSet(url: string | null): VariableSetState {
  // Results are tagged with the URL they belong to, so switching scenario/environment
  // never shows the previous set while the new one loads.
  const [result, setResult] = useState<{ url: string | null; variables: MaskedVariable[]; error: string | null }>(
    { url: null, variables: [], error: null },
  );
  const [saving, setSaving] = useState(false);
  const requestRef = useRef(0);

  const reload = useCallback(async () => {
    const request = ++requestRef.current;
    if (url === null) {
      setResult({ url: null, variables: [], error: null });
      return;
    }
    setResult((prev) => (prev.url === url ? { ...prev, url: null } : prev));
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (request !== requestRef.current) return;
      if (!res.ok) {
        const { message } = await readError(res);
        if (request === requestRef.current) setResult({ url, variables: [], error: message });
        return;
      }
      const data = (await res.json()) as { variables?: MaskedVariable[] };
      if (request !== requestRef.current) return;
      setResult({ url, variables: Array.isArray(data.variables) ? data.variables : [], error: null });
    } catch {
      if (request === requestRef.current) {
        setResult({ url, variables: [], error: "Network error loading variables" });
      }
    }
  }, [url]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const save = useCallback(
    async (items: VariableReplaceItem[]): Promise<SaveVariablesResult> => {
      if (url === null) return { ok: false, message: "Nothing to save", errors: [] };
      setSaving(true);
      try {
        const res = await fetch(url, {
          method: "PUT",
          headers: JSON_HEADERS,
          body: JSON.stringify({ variables: items }),
        });
        if (!res.ok) {
          const { message, errors } = await readError(res);
          return { ok: false, message, errors };
        }
        const data = (await res.json()) as { variables?: MaskedVariable[] };
        const saved = Array.isArray(data.variables) ? data.variables : [];
        requestRef.current += 1; // a save supersedes any in-flight load
        setResult({ url, variables: saved, error: null });
        return { ok: true, variables: saved };
      } catch {
        return { ok: false, message: "Network error saving variables", errors: [] };
      } finally {
        setSaving(false);
      }
    },
    [url],
  );

  const current = result.url === url;
  return {
    enabled: url !== null,
    variables: current ? result.variables : EMPTY_VARIABLES,
    loading: url !== null && !current,
    saving,
    error: current ? result.error : null,
    reload,
    save,
  };
}

export function useScenarioVariables(scenarioId: string | number | null | undefined): VariableSetState {
  return useVariableSet(
    scenarioId === null || scenarioId === undefined || scenarioId === ""
      ? null
      : `/api/scenarios/${encodeURIComponent(String(scenarioId))}/variables`,
  );
}

export function useEnvironmentVariables(environmentId: string | null | undefined): VariableSetState {
  return useVariableSet(environmentId ? `/api/environments/${encodeURIComponent(environmentId)}/variables` : null);
}

export interface EnvironmentsState {
  environments: EnvironmentSummary[];
  loading: boolean;
  /** True after the first load attempt finished (success or failure). */
  loaded: boolean;
  error: string | null;
  reload: () => Promise<void>;
  create: (name: string) => Promise<MutationResult<EnvironmentSummary>>;
  rename: (id: string, name: string) => Promise<MutationResult<EnvironmentSummary>>;
  remove: (id: string) => Promise<MutationResult<string>>;
}

function sortEnvironments(list: EnvironmentSummary[]): EnvironmentSummary[] {
  return [...list].sort((a, b) => a.name.localeCompare(b.name));
}

export function useEnvironments(): EnvironmentsState {
  const [environments, setEnvironments] = useState<EnvironmentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/environments", { cache: "no-store" });
      if (!res.ok) {
        setError((await readError(res)).message);
        return;
      }
      const data = (await res.json()) as { environments?: EnvironmentSummary[] };
      setEnvironments(sortEnvironments(Array.isArray(data.environments) ? data.environments : []));
    } catch {
      setError("Network error loading environments");
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const create = useCallback(async (name: string): Promise<MutationResult<EnvironmentSummary>> => {
    try {
      const res = await fetch("/api/environments", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ name }),
      });
      if (!res.ok) return { ok: false, message: (await readError(res)).message };
      const created = (await res.json()) as EnvironmentSummary;
      setEnvironments((prev) => sortEnvironments([...prev, created]));
      return { ok: true, value: created };
    } catch {
      return { ok: false, message: "Network error creating environment" };
    }
  }, []);

  const rename = useCallback(async (id: string, name: string): Promise<MutationResult<EnvironmentSummary>> => {
    try {
      const res = await fetch(`/api/environments/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: JSON_HEADERS,
        body: JSON.stringify({ name }),
      });
      if (!res.ok) return { ok: false, message: (await readError(res)).message };
      const renamed = (await res.json()) as EnvironmentSummary;
      setEnvironments((prev) => sortEnvironments(prev.map((env) => (env.id === id ? renamed : env))));
      return { ok: true, value: renamed };
    } catch {
      return { ok: false, message: "Network error renaming environment" };
    }
  }, []);

  const remove = useCallback(async (id: string): Promise<MutationResult<string>> => {
    try {
      const res = await fetch(`/api/environments/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) return { ok: false, message: (await readError(res)).message };
      setEnvironments((prev) => prev.filter((env) => env.id !== id));
      return { ok: true, value: id };
    } catch {
      return { ok: false, message: "Network error deleting environment" };
    }
  }, []);

  return { environments, loading, loaded, error, reload, create, rename, remove };
}

function readStoredEnvironmentId(): string | null {
  try {
    return window.localStorage.getItem(SELECTED_ENVIRONMENT_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredEnvironmentId(id: string | null): void {
  try {
    if (id === null) window.localStorage.removeItem(SELECTED_ENVIRONMENT_STORAGE_KEY);
    else window.localStorage.setItem(SELECTED_ENVIRONMENT_STORAGE_KEY, id);
  } catch {
    // Storage unavailable (private mode, quota): selection stays in memory only.
  }
}

/**
 * Selected environment id persisted in localStorage and validated against the
 * user's environments: an id that is not in the list resolves to null. Pass
 * `listKnown` only after a successful load, so a failed fetch never clears the choice.
 */
export function useSelectedEnvironment(
  environments: readonly EnvironmentSummary[],
  listKnown: boolean,
): { selectedId: string | null; setSelectedId: (id: string | null) => void } {
  const [storedId, setStoredId] = useState<string | null>(null);

  useEffect(() => {
    setStoredId(readStoredEnvironmentId());
  }, []);

  const valid = useMemo(
    () => storedId !== null && environments.some((env) => env.id === storedId),
    [storedId, environments],
  );

  // Drop a stale id (deleted environment, other user) once the list is known.
  useEffect(() => {
    if (listKnown && storedId !== null && !valid) {
      setStoredId(null);
      writeStoredEnvironmentId(null);
    }
  }, [listKnown, storedId, valid]);

  const setSelectedId = useCallback((id: string | null) => {
    setStoredId(id);
    writeStoredEnvironmentId(id);
  }, []);

  return { selectedId: valid ? storedId : null, setSelectedId };
}
