"use client";

// k6flow-variables V-T4: scenario variables panel (editor) and the shared editable
// VariableTable, also used by the environments manager.
// Secret values are never loaded or rendered: a stored secret shows a placeholder and
// an empty field keeps the stored value (sent as `value: null`).

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  emptyVariableRow,
  keepsStoredSecret,
  mapServerErrors,
  toReplacePayload,
  toVariableRows,
  validateVariableRows,
  type MaskedVariable,
  type RowErrors,
  type SaveVariablesResult,
  type VariableReplaceItem,
  type VariableRow,
  type VariableSetState,
} from "./use-variables";
import { TokenChip } from "./VariableInput";

export const STORED_SECRET_PLACEHOLDER = "•••••• (guardado)";

// -----------------------------------------------------------------------------
// VariableTable (shared)
// -----------------------------------------------------------------------------

interface VariableTableProps {
  /** Server state (masked). The table resets to it whenever it changes. */
  variables: MaskedVariable[];
  loading?: boolean;
  saving?: boolean;
  onSave: (items: VariableReplaceItem[]) => Promise<SaveVariablesResult>;
  /** Names referenced by the graph (shows an "in use" badge). */
  usedNames?: ReadonlySet<string>;
  /** Names also defined at a lower precedence level (shows an "overrides" badge). */
  overriddenNames?: ReadonlySet<string>;
  overriddenLabel?: string;
  onDirtyChange?: (dirty: boolean) => void;
}

const cellInput =
  "w-full rounded-lg border bg-surface-container-lowest px-2 py-1.5 font-mono text-[12px] text-on-surface outline-none focus:border-primary-container";

export function VariableTable({
  variables,
  loading,
  saving,
  onSave,
  usedNames,
  overriddenNames,
  overriddenLabel = "overrides environment",
  onDirtyChange,
}: VariableTableProps) {
  const [rows, setRows] = useState<VariableRow[]>(() => toVariableRows(variables));
  const [dirty, setDirty] = useState(false);
  const [showAllErrors, setShowAllErrors] = useState(false);
  const [serverErrors, setServerErrors] = useState<Record<string, RowErrors>>({});
  const [generalErrors, setGeneralErrors] = useState<string[]>([]);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    setRows(toVariableRows(variables));
    setDirty(false);
    setShowAllErrors(false);
    setServerErrors({});
    setGeneralErrors([]);
  }, [variables]);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const clientErrors = useMemo(() => validateVariableRows(rows), [rows]);

  const errorFor = (row: VariableRow, field: keyof RowErrors): string | undefined => {
    const server = serverErrors[row.key]?.[field];
    if (server) return server;
    const client = clientErrors[row.key]?.[field];
    if (!client) return undefined;
    // Before a save attempt only show name problems the user has already typed.
    if (showAllErrors || (field === "name" && row.name !== "")) return client;
    return undefined;
  };

  const edit = (key: string, patch: Partial<VariableRow>) => {
    setRows((prev) => prev.map((row) => (row.key === key ? { ...row, ...patch } : row)));
    setServerErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
    setDirty(true);
    setSavedAt(null);
  };

  const addRow = () => {
    setRows((prev) => [...prev, emptyVariableRow()]);
    setDirty(true);
    setSavedAt(null);
  };

  const removeRow = (key: string) => {
    // Server errors are indexed by position: drop them all once rows shift.
    setRows((prev) => prev.filter((row) => row.key !== key));
    setServerErrors({});
    setDirty(true);
    setSavedAt(null);
  };

  const discard = () => {
    setRows(toVariableRows(variables));
    setDirty(false);
    setShowAllErrors(false);
    setServerErrors({});
    setGeneralErrors([]);
  };

  const save = async () => {
    setShowAllErrors(true);
    setGeneralErrors([]);
    if (Object.keys(clientErrors).length > 0) return;
    const submitted = rows;
    const result = await onSave(toReplacePayload(submitted));
    if (result.ok) {
      setSavedAt(Date.now());
      return;
    }
    const mapped = mapServerErrors(submitted, result.errors);
    setServerErrors(mapped.rows);
    setGeneralErrors(mapped.general.length > 0 || result.errors.length > 0 ? mapped.general : [result.message]);
  };

  if (loading) {
    return <p className="py-space-md text-[12px] text-on-surface-variant">Loading variables...</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-outline-variant px-3 py-3 text-center text-[12px] text-on-surface-variant">
          No variables yet.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_56px_24px] gap-2 px-1 text-[11px] font-medium uppercase tracking-wide text-on-surface-variant">
            <span>Name</span>
            <span>Value</span>
            <span className="text-center">Secret</span>
            <span />
          </div>
          {rows.map((row) => {
            const nameError = errorFor(row, "name");
            const valueError = errorFor(row, "value");
            const keepsStored = keepsStoredSecret(row);
            const used = usedNames?.has(row.name);
            const overrides = overriddenNames?.has(row.name);
            return (
              <div key={row.key} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_56px_24px] items-start gap-2">
                <div className="min-w-0">
                  <input
                    type="text"
                    value={row.name}
                    onChange={(e) => edit(row.key, { name: e.target.value })}
                    placeholder="name"
                    spellCheck={false}
                    autoComplete="off"
                    aria-label="Variable name"
                    aria-invalid={!!nameError}
                    className={`${cellInput} ${nameError ? "border-error" : "border-outline-variant"}`}
                  />
                  {(used || overrides) && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {used && (
                        <span className="rounded bg-secondary/15 px-1 text-[10px] text-secondary">in use</span>
                      )}
                      {overrides && (
                        <span className="rounded bg-tertiary/15 px-1 text-[10px] text-tertiary">{overriddenLabel}</span>
                      )}
                    </div>
                  )}
                  {nameError && <p className="mt-1 text-[11px] text-error">{nameError}</p>}
                </div>
                <div className="min-w-0">
                  {row.secret ? (
                    <input
                      type="password"
                      value={row.value}
                      onChange={(e) => edit(row.key, { value: e.target.value })}
                      placeholder={keepsStored ? STORED_SECRET_PLACEHOLDER : "secret value"}
                      autoComplete="new-password"
                      aria-label="Secret value"
                      aria-invalid={!!valueError}
                      className={`${cellInput} ${valueError ? "border-error" : "border-outline-variant"}`}
                    />
                  ) : (
                    <input
                      type="text"
                      value={row.value}
                      onChange={(e) => edit(row.key, { value: e.target.value })}
                      placeholder="value"
                      spellCheck={false}
                      autoComplete="off"
                      aria-label="Variable value"
                      aria-invalid={!!valueError}
                      className={`${cellInput} ${valueError ? "border-error" : "border-outline-variant"}`}
                    />
                  )}
                  {row.secret && keepsStored && row.value === "" && !valueError && (
                    <p className="mt-1 text-[10px] text-on-surface-variant">Leave empty to keep the stored value</p>
                  )}
                  {valueError && <p className="mt-1 text-[11px] text-error">{valueError}</p>}
                </div>
                <label className="flex h-[30px] cursor-pointer items-center justify-center" title="Secret: masked, never returned by the API, passed to k6 as an environment variable">
                  <input
                    type="checkbox"
                    checked={row.secret}
                    onChange={(e) => edit(row.key, { secret: e.target.checked })}
                    aria-label="Secret"
                    className="h-4 w-4 accent-[var(--color-primary)]"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => removeRow(row.key)}
                  className="flex h-[30px] items-center justify-center text-on-surface-variant hover:text-error"
                  title="Delete variable"
                  aria-label={`Delete variable ${row.name}`}
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      )}

      {generalErrors.length > 0 && (
        <div className="rounded-lg border border-error/40 bg-error/10 px-3 py-2 text-[12px] text-error">
          {generalErrors.map((message, index) => (
            <p key={index}>{message}</p>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between gap-2 pt-1">
        <button type="button" onClick={addRow} className="text-sm text-primary hover:underline">
          + Add variable
        </button>
        <div className="flex items-center gap-2">
          {savedAt !== null && !dirty && <span className="text-[11px] text-secondary">✓ Saved</span>}
          <button
            type="button"
            onClick={discard}
            disabled={!dirty || saving}
            className="rounded-lg border border-outline-variant px-3 py-1.5 text-sm text-on-surface disabled:cursor-not-allowed disabled:opacity-50"
          >
            Discard
          </button>
          <button
            type="button"
            onClick={save}
            disabled={!dirty || saving}
            className="rounded-lg bg-primary-container px-3 py-1.5 text-sm font-semibold text-on-primary-container transition-colors hover:bg-tertiary-container disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// VariablesPanel (editor)
// -----------------------------------------------------------------------------

interface VariablesPanelProps {
  scenarioId: string | number | null;
  scenarioVariables: VariableSetState;
  environmentName: string | null;
  environmentVariables: VariableSetState;
  /** Names referenced by the graph literal fields. */
  usedNames: readonly string[];
  onClose: () => void;
}

export function VariablesPanel({
  scenarioId,
  scenarioVariables,
  environmentName,
  environmentVariables,
  usedNames,
  onClose,
}: VariablesPanelProps) {
  const usedSet = useMemo(() => new Set(usedNames), [usedNames]);
  const scenarioNames = useMemo(
    () => new Set(scenarioVariables.variables.map((v) => v.name)),
    [scenarioVariables.variables],
  );
  const environmentNames = useMemo(
    () => new Set(environmentName ? environmentVariables.variables.map((v) => v.name) : []),
    [environmentName, environmentVariables.variables],
  );
  const undefinedNames = usedNames.filter((name) => !scenarioNames.has(name) && !environmentNames.has(name));

  return (
    <div style={panelStyle}>
      <div style={headerStyle}>
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-[18px] text-primary">data_object</span>
          <h3 className="m-0 text-[14px] font-semibold text-on-surface">Variables</h3>
        </div>
        <button onClick={onClose} style={closeButtonStyle} aria-label="Close">
          ✕
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        <p className="mb-3 text-[11px] text-on-surface-variant">
          Reference variables as <code className="font-mono text-secondary">{"{{name}}"}</code> in URL, header values and
          body. Scenario variables override environment variables with the same name.
        </p>

        {/* Usage in the graph */}
        <section className="mb-4 rounded-lg border border-surface-container-high bg-surface-container-lowest p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h4 className="m-0 text-[12px] font-medium text-on-surface-variant">Used in this scenario</h4>
            <span className="text-[11px] text-on-surface-variant">
              Environment:{" "}
              <span className="font-medium text-on-surface">{environmentName ?? "Sin entorno"}</span>
            </span>
          </div>
          {usedNames.length === 0 ? (
            <p className="text-[11px] text-on-surface-variant">No {"{{variables}}"} referenced by the graph.</p>
          ) : (
            <div className="flex flex-wrap gap-1">
              {usedNames.map((name) => (
                <TokenChip
                  key={name}
                  token={{ type: scenarioNames.has(name) || environmentNames.has(name) ? "known" : "unknown", name }}
                />
              ))}
            </div>
          )}
          {undefinedNames.length > 0 && (
            <p className="mt-2 text-[11px] text-amber-500">
              ⚠ {undefinedNames.length} undefined: {undefinedNames.join(", ")}. The run will fail until they are
              defined here or in the selected environment.
            </p>
          )}
          {environmentVariables.error && (
            <p className="mt-2 text-[11px] text-error">Environment variables: {environmentVariables.error}</p>
          )}
        </section>

        {/* Scenario variables */}
        <h4 className="mb-2 text-[12px] font-medium text-on-surface-variant">Scenario variables</h4>
        {scenarioId === null ? (
          <p className="rounded-lg border border-dashed border-outline-variant px-3 py-3 text-[12px] text-on-surface-variant">
            Save the scenario first to define scenario variables. Environment variables still apply.
          </p>
        ) : scenarioVariables.error && !scenarioVariables.loading ? (
          <div className="rounded-lg border border-error/40 bg-error/10 px-3 py-2 text-[12px] text-error">
            <p>{scenarioVariables.error}</p>
            <button type="button" onClick={() => void scenarioVariables.reload()} className="mt-1 underline">
              Retry
            </button>
          </div>
        ) : (
          <VariableTable
            variables={scenarioVariables.variables}
            loading={scenarioVariables.loading}
            saving={scenarioVariables.saving}
            onSave={scenarioVariables.save}
            usedNames={usedSet}
            overriddenNames={environmentNames}
          />
        )}

        {/* Environment summary */}
        <section className="mt-4 border-t border-surface-container-high pt-3">
          <div className="mb-2 flex items-center justify-between">
            <h4 className="m-0 text-[12px] font-medium text-on-surface-variant">
              Environment variables{environmentName ? ` · ${environmentName}` : ""}
            </h4>
            <Link href="/environments" className="text-[11px] text-primary hover:underline">
              Gestionar entornos
            </Link>
          </div>
          {environmentName === null ? (
            <p className="text-[11px] text-on-surface-variant">No environment selected (Sin entorno).</p>
          ) : environmentVariables.loading ? (
            <p className="text-[11px] text-on-surface-variant">Loading...</p>
          ) : environmentVariables.variables.length === 0 ? (
            <p className="text-[11px] text-on-surface-variant">This environment has no variables.</p>
          ) : (
            <div className="flex flex-wrap gap-1">
              {environmentVariables.variables.map((variable) => (
                <span
                  key={variable.name}
                  className={`rounded border border-outline-variant px-1 font-mono text-[11px] ${
                    scenarioNames.has(variable.name) ? "text-on-surface-variant line-through" : "text-on-surface"
                  }`}
                  title={scenarioNames.has(variable.name) ? "Overridden by a scenario variable" : undefined}
                >
                  {variable.secret ? "🔒 " : ""}
                  {variable.name}
                </span>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

const panelStyle: React.CSSProperties = {
  position: "absolute",
  top: "16px",
  right: "16px",
  width: "560px",
  maxWidth: "calc(100% - 32px)",
  maxHeight: "calc(100% - 32px)",
  background: "var(--color-surface-container-low)",
  border: "1px solid var(--color-surface-container-high)",
  borderRadius: "12px",
  boxShadow: "var(--shadow-modal)",
  zIndex: 100,
  display: "flex",
  flexDirection: "column",
  fontFamily: "var(--font-sans)",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "12px 16px",
  borderBottom: "2px solid var(--color-primary)",
};

const closeButtonStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  fontSize: "16px",
  color: "var(--color-on-surface-variant)",
  cursor: "pointer",
  padding: "4px",
};
