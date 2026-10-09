"use client";

// k6flow-variables V-T4: scenario variables panel (editor) and the shared editable
// VariableTable, also used by the environments manager.
// Secret values are never loaded or rendered: a stored secret shows a placeholder and
// an empty field keeps the stored value (sent as `value: null`).
// Styling: inline styles over the theme CSS variables from app/globals.css (as in
// app/executions/page.tsx and lib/editor/*Panel.tsx) plus the globals.css component
// classes (.input, .btn-primary, .btn-secondary, .table-row, .badge-*).

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
import { inputStyle } from "../editor/ConfigPanel";

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
    return <p style={{ ...hintTextStyle, padding: "12px 0" }}>Loading variables...</p>;
  }

  const actionsDisabled = !dirty || saving;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      {rows.length === 0 ? (
        <div style={emptyTableStyle}>
          <span className="material-symbols-outlined" style={{ fontSize: 24 }}>
            data_object
          </span>
          <span>No variables yet.</span>
        </div>
      ) : (
        <div style={tableContainerStyle}>
          <table style={tableStyle}>
            <colgroup>
              <col style={{ width: "40%" }} />
              <col />
              <col style={{ width: "56px" }} />
              <col style={{ width: "40px" }} />
            </colgroup>
            <thead>
              <tr>
                <th style={thStyle}>Name</th>
                <th style={thStyle}>Value</th>
                <th style={{ ...thStyle, textAlign: "center" }}>Secret</th>
                <th style={thStyle}>
                  <span style={visuallyHiddenStyle}>Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const nameError = errorFor(row, "name");
                const valueError = errorFor(row, "value");
                const keepsStored = keepsStoredSecret(row);
                const used = usedNames?.has(row.name);
                const overrides = overriddenNames?.has(row.name);
                const hasError = !!nameError || !!valueError;
                return (
                  <tr key={row.key} className="table-row" style={hasError ? errorRowStyle : undefined}>
                    <td style={hasError ? { ...tdStyle, ...errorCellMarkerStyle } : tdStyle}>
                      <input
                        type="text"
                        value={row.name}
                        onChange={(e) => edit(row.key, { name: e.target.value })}
                        placeholder="name"
                        spellCheck={false}
                        autoComplete="off"
                        aria-label="Variable name"
                        aria-invalid={!!nameError}
                        className="input"
                        style={nameError ? cellInputErrorStyle : cellInputStyle}
                      />
                      {(used || overrides) && (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: "4px", marginTop: "6px" }}>
                          {used && (
                            <span className="badge-success" style={smallBadgeStyle}>
                              in use
                            </span>
                          )}
                          {overrides && (
                            <span style={{ ...smallBadgeStyle, ...overrideBadgeStyle }}>{overriddenLabel}</span>
                          )}
                        </div>
                      )}
                      {nameError && <p style={fieldErrorStyle}>{nameError}</p>}
                    </td>
                    <td style={tdStyle}>
                      {row.secret ? (
                        <input
                          type="password"
                          value={row.value}
                          onChange={(e) => edit(row.key, { value: e.target.value })}
                          placeholder={keepsStored ? STORED_SECRET_PLACEHOLDER : "secret value"}
                          autoComplete="new-password"
                          aria-label="Secret value"
                          aria-invalid={!!valueError}
                          className="input"
                          style={valueError ? cellInputErrorStyle : cellInputStyle}
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
                          className="input"
                          style={valueError ? cellInputErrorStyle : cellInputStyle}
                        />
                      )}
                      {row.secret && keepsStored && row.value === "" && !valueError && (
                        <p style={{ ...hintTextStyle, fontSize: "10px", marginTop: "4px" }}>
                          Leave empty to keep the stored value
                        </p>
                      )}
                      {valueError && <p style={fieldErrorStyle}>{valueError}</p>}
                    </td>
                    <td style={{ ...tdStyle, textAlign: "center" }}>
                      <label
                        style={{ ...secretToggleStyle, ...(row.secret ? secretToggleOnStyle : null) }}
                        title="Secret: masked, never returned by the API, passed to k6 as an environment variable"
                      >
                        <input
                          type="checkbox"
                          checked={row.secret}
                          onChange={(e) => edit(row.key, { secret: e.target.checked })}
                          aria-label="Secret"
                          style={visuallyHiddenStyle}
                        />
                        <span className="material-symbols-outlined" style={{ fontSize: 16 }} aria-hidden="true">
                          {row.secret ? "lock" : "lock_open"}
                        </span>
                      </label>
                    </td>
                    <td style={{ ...tdStyle, textAlign: "center" }}>
                      <button
                        type="button"
                        onClick={() => removeRow(row.key)}
                        style={iconButtonStyle}
                        title="Delete variable"
                        aria-label={`Delete variable ${row.name}`}
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: 16 }}>
                          delete
                        </span>
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {generalErrors.length > 0 && (
        <div style={errorBoxStyle} role="alert">
          {generalErrors.map((message, index) => (
            <p key={index} style={{ margin: 0 }}>
              {message}
            </p>
          ))}
        </div>
      )}

      <div style={footerStyle}>
        <button type="button" onClick={addRow} style={textButtonStyle}>
          <span className="material-symbols-outlined" style={{ fontSize: 16 }}>
            add
          </span>
          <span>Add variable</span>
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          {savedAt !== null && !dirty && (
            <span style={savedStyle}>
              <span className="material-symbols-outlined" style={{ fontSize: 14 }}>
                check_circle
              </span>
              Saved
            </span>
          )}
          <button
            type="button"
            onClick={discard}
            disabled={actionsDisabled}
            className="btn-secondary"
            style={{ ...footerButtonStyle, ...(actionsDisabled ? disabledStyle : null) }}
          >
            Discard
          </button>
          <button
            type="button"
            onClick={save}
            disabled={actionsDisabled}
            className="btn-primary"
            style={{ ...footerButtonStyle, ...(actionsDisabled ? disabledStyle : null) }}
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
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span className="material-symbols-outlined" style={{ fontSize: 18, color: "var(--color-primary)" }}>
            data_object
          </span>
          <h3 style={panelTitleStyle}>Variables</h3>
        </div>
        <button onClick={onClose} style={closeButtonStyle} aria-label="Close">
          <span className="material-symbols-outlined" style={{ fontSize: 18 }}>
            close
          </span>
        </button>
      </div>

      <div style={panelBodyStyle}>
        <p style={{ ...hintTextStyle, marginBottom: "12px" }}>
          Reference variables as <code style={codeStyle}>{"{{name}}"}</code> in URL, header values and body. Scenario
          variables override environment variables with the same name.
        </p>

        {/* Usage in the graph */}
        <section style={usageCardStyle}>
          <div style={sectionHeaderStyle}>
            <h4 style={sectionTitleStyle}>Used in this scenario</h4>
            <span style={hintTextStyle}>
              Environment:{" "}
              <span style={{ fontWeight: 500, color: "var(--color-on-surface)" }}>{environmentName ?? "Sin entorno"}</span>
            </span>
          </div>
          {usedNames.length === 0 ? (
            <p style={hintTextStyle}>No {"{{variables}}"} referenced by the graph.</p>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "4px" }}>
              {usedNames.map((name) => (
                <TokenChip
                  key={name}
                  token={{ type: scenarioNames.has(name) || environmentNames.has(name) ? "known" : "unknown", name }}
                />
              ))}
            </div>
          )}
          {undefinedNames.length > 0 && (
            <p style={warningTextStyle}>
              <span className="material-symbols-outlined" style={{ fontSize: 14 }}>
                warning
              </span>
              <span>
                {undefinedNames.length} undefined: {undefinedNames.join(", ")}. The run will fail until they are defined
                here or in the selected environment.
              </span>
            </p>
          )}
          {environmentVariables.error && (
            <p style={fieldErrorStyle}>Environment variables: {environmentVariables.error}</p>
          )}
        </section>

        {/* Scenario variables */}
        <h4 style={{ ...sectionTitleStyle, marginBottom: "8px" }}>Scenario variables</h4>
        {scenarioId === null ? (
          <p style={{ ...emptyTableStyle, margin: 0 }}>
            Save the scenario first to define scenario variables. Environment variables still apply.
          </p>
        ) : scenarioVariables.error && !scenarioVariables.loading ? (
          <div style={errorBoxStyle} role="alert">
            <p style={{ margin: 0 }}>{scenarioVariables.error}</p>
            <button type="button" onClick={() => void scenarioVariables.reload()} style={linkButtonStyle}>
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
        <section style={envSummaryStyle}>
          <div style={sectionHeaderStyle}>
            <h4 style={sectionTitleStyle}>
              Environment variables{environmentName ? ` · ${environmentName}` : ""}
            </h4>
            <Link href="/environments" style={manageLinkStyle}>
              <span className="material-symbols-outlined" style={{ fontSize: 14 }}>
                tune
              </span>
              Gestionar entornos
            </Link>
          </div>
          {environmentName === null ? (
            <p style={hintTextStyle}>No environment selected (Sin entorno).</p>
          ) : environmentVariables.loading ? (
            <p style={hintTextStyle}>Loading...</p>
          ) : environmentVariables.variables.length === 0 ? (
            <p style={hintTextStyle}>This environment has no variables.</p>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "4px" }}>
              {environmentVariables.variables.map((variable) => {
                const overridden = scenarioNames.has(variable.name);
                return (
                  <span
                    key={variable.name}
                    style={{ ...envChipStyle, ...(overridden ? envChipOverriddenStyle : null) }}
                    title={overridden ? "Overridden by a scenario variable" : undefined}
                  >
                    {variable.secret && (
                      <span className="material-symbols-outlined" style={{ fontSize: 12 }} aria-label="secret">
                        lock
                      </span>
                    )}
                    {variable.name}
                  </span>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Styles
// -----------------------------------------------------------------------------

// Table (mirrors app/executions/page.tsx, compacted to fit the 560px editor panel).
const tableContainerStyle: React.CSSProperties = {
  background: "var(--color-surface-container-lowest)",
  border: "1px solid var(--color-surface-container)",
  borderRadius: "8px",
  overflow: "hidden",
};

const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  tableLayout: "fixed",
};

const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "8px 10px",
  fontSize: "11px",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.5px",
  color: "var(--color-on-surface-variant)",
  background: "var(--color-surface-container)",
  borderBottom: "1px solid var(--color-surface-container-high)",
};

const tdStyle: React.CSSProperties = {
  padding: "8px 10px",
  verticalAlign: "top",
  fontSize: "13px",
  color: "var(--color-on-surface)",
};

const errorRowStyle: React.CSSProperties = {
  background: "color-mix(in srgb, var(--color-error) 8%, transparent)",
};

const errorCellMarkerStyle: React.CSSProperties = {
  boxShadow: "inset 2px 0 0 var(--color-error)",
};

const cellInputStyle: React.CSSProperties = {
  ...inputStyle,
  height: "32px",
  padding: "6px 8px",
  fontSize: "12px",
};

const cellInputErrorStyle: React.CSSProperties = {
  ...cellInputStyle,
  borderColor: "var(--color-error)",
};

const fieldErrorStyle: React.CSSProperties = {
  margin: "4px 0 0",
  fontSize: "11px",
  lineHeight: "16px",
  color: "var(--color-error)",
};

const smallBadgeStyle: React.CSSProperties = {
  padding: "0 6px",
  fontSize: "10px",
  lineHeight: "16px",
  borderRadius: "6px",
};

const overrideBadgeStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  fontWeight: 500,
  color: "var(--color-tertiary)",
  background: "color-mix(in srgb, var(--color-tertiary) 10%, transparent)",
  border: "1px solid color-mix(in srgb, var(--color-tertiary) 30%, transparent)",
};

const secretToggleStyle: React.CSSProperties = {
  position: "relative",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: "32px",
  height: "32px",
  borderRadius: "8px",
  border: "1px solid var(--color-outline-variant)",
  color: "var(--color-on-surface-variant)",
  cursor: "pointer",
  boxSizing: "border-box",
  transition: "background 0.15s, color 0.15s, border-color 0.15s",
};

const secretToggleOnStyle: React.CSSProperties = {
  color: "var(--color-primary)",
  borderColor: "var(--color-primary-container)",
  background: "color-mix(in srgb, var(--color-primary-container) 20%, transparent)",
};

const visuallyHiddenStyle: React.CSSProperties = {
  position: "absolute",
  width: "1px",
  height: "1px",
  padding: 0,
  margin: "-1px",
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
};

const iconButtonStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: "32px",
  height: "32px",
  padding: 0,
  background: "none",
  border: "none",
  borderRadius: "8px",
  color: "var(--color-on-surface-variant)",
  cursor: "pointer",
};

const emptyTableStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: "6px",
  padding: "20px 12px",
  textAlign: "center",
  fontSize: "12px",
  lineHeight: "18px",
  color: "var(--color-on-surface-variant)",
  border: "1px dashed var(--color-outline-variant)",
  borderRadius: "8px",
};

const errorBoxStyle: React.CSSProperties = {
  padding: "8px 12px",
  fontSize: "12px",
  lineHeight: "18px",
  color: "var(--color-error)",
  background: "color-mix(in srgb, var(--color-error) 10%, transparent)",
  border: "1px solid color-mix(in srgb, var(--color-error) 30%, transparent)",
  borderRadius: "8px",
};

const linkButtonStyle: React.CSSProperties = {
  marginTop: "4px",
  padding: 0,
  background: "none",
  border: "none",
  color: "inherit",
  fontSize: "12px",
  textDecoration: "underline",
  cursor: "pointer",
};

const footerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  flexWrap: "wrap",
  gap: "8px",
};

const textButtonStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "4px",
  height: "32px",
  padding: "0 10px 0 6px",
  background: "none",
  border: "none",
  borderRadius: "8px",
  color: "var(--color-primary)",
  fontSize: "13px",
  fontWeight: 500,
  cursor: "pointer",
};

const footerButtonStyle: React.CSSProperties = {
  height: "32px",
  padding: "0 14px",
  fontSize: "13px",
  cursor: "pointer",
  boxSizing: "border-box",
};

const disabledStyle: React.CSSProperties = {
  opacity: 0.5,
  cursor: "not-allowed",
  boxShadow: "none",
};

const savedStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "4px",
  fontSize: "11px",
  color: "var(--color-secondary)",
};

const hintTextStyle: React.CSSProperties = {
  margin: 0,
  fontSize: "11px",
  lineHeight: "16px",
  color: "var(--color-on-surface-variant)",
};

const codeStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  color: "var(--color-secondary)",
};

// Panel (mirrors lib/editor/RunHistoryPanel.tsx / ScriptPanel.tsx).
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

const panelTitleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: "14px",
  fontWeight: 600,
  color: "var(--color-on-surface)",
};

const closeButtonStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  background: "none",
  border: "none",
  color: "var(--color-on-surface-variant)",
  cursor: "pointer",
  padding: "4px",
};

const panelBodyStyle: React.CSSProperties = {
  flex: 1,
  overflowY: "auto",
  padding: "16px",
};

const usageCardStyle: React.CSSProperties = {
  marginBottom: "16px",
  padding: "12px",
  background: "var(--color-surface-container-lowest)",
  border: "1px solid var(--color-surface-container-high)",
  borderRadius: "8px",
};

const sectionHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "8px",
  marginBottom: "8px",
};

const sectionTitleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: "12px",
  fontWeight: 500,
  color: "var(--color-on-surface-variant)",
};

const warningTextStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: "4px",
  margin: "8px 0 0",
  fontSize: "11px",
  lineHeight: "16px",
  color: "#f59e0b",
};

const envSummaryStyle: React.CSSProperties = {
  marginTop: "16px",
  paddingTop: "12px",
  borderTop: "1px solid var(--color-surface-container-high)",
};

const manageLinkStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "4px",
  fontSize: "11px",
  color: "var(--color-primary)",
  textDecoration: "none",
};

const envChipStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "2px",
  padding: "0 6px",
  fontFamily: "var(--font-mono)",
  fontSize: "11px",
  lineHeight: "18px",
  color: "var(--color-on-surface)",
  border: "1px solid var(--color-outline-variant)",
  borderRadius: "4px",
};

const envChipOverriddenStyle: React.CSSProperties = {
  color: "var(--color-on-surface-variant)",
  textDecoration: "line-through",
};
