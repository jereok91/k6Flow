"use client";

// k6flow-variables V-T4: list, create, rename and delete environments, and edit each
// environment's variables with the shared VariableTable.

import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { VariableTable } from "./VariablesPanel";
import {
  useEnvironmentVariables,
  useEnvironments,
  useSelectedEnvironment,
  type EnvironmentSummary,
} from "./use-variables";

const UNSAVED_PROMPT = "Hay cambios sin guardar en las variables. ¿Descartarlos?";

export function EnvironmentsManager() {
  const envs = useEnvironments();
  const runSelection = useSelectedEnvironment(envs.environments, envs.loaded && envs.error === null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  // Keep a valid active environment: default to the first one.
  useEffect(() => {
    if (!envs.loaded) return;
    if (activeId === null || !envs.environments.some((env) => env.id === activeId)) {
      setActiveId(envs.environments[0]?.id ?? null);
    }
  }, [envs.loaded, envs.environments, activeId]);

  const active = envs.environments.find((env) => env.id === activeId) ?? null;
  const variables = useEnvironmentVariables(active?.id ?? null);

  const confirmDiscard = () => !dirty || window.confirm(UNSAVED_PROMPT);

  const selectEnvironment = (id: string) => {
    if (id === activeId || !confirmDiscard()) return;
    setDirty(false);
    setActiveId(id);
  };

  const handleCreate = async (event: FormEvent) => {
    event.preventDefault();
    const name = newName.trim();
    if (!name || !confirmDiscard()) return;
    setCreating(true);
    setActionError(null);
    const result = await envs.create(name);
    setCreating(false);
    if (!result.ok) {
      setActionError(result.message);
      return;
    }
    setNewName("");
    setDirty(false);
    setActiveId(result.value.id);
  };

  const handleRename = async (env: EnvironmentSummary, name: string): Promise<boolean> => {
    setActionError(null);
    const result = await envs.rename(env.id, name);
    if (!result.ok) {
      setActionError(result.message);
      return false;
    }
    return true;
  };

  const handleDelete = async (env: EnvironmentSummary) => {
    if (!window.confirm(`¿Eliminar el entorno "${env.name}" y todas sus variables?`)) return;
    setActionError(null);
    const result = await envs.remove(env.id);
    if (!result.ok) {
      setActionError(result.message);
      return;
    }
    if (env.id === activeId) setDirty(false);
  };

  const handleDirtyChange = useCallback((value: boolean) => setDirty(value), []);

  const createDisabled = !newName.trim() || creating;

  return (
    <div style={layoutStyle}>
      {/* Environment list */}
      <section style={{ ...cardStyle, ...listCardStyle }}>
        <form onSubmit={handleCreate} style={createRowStyle}>
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Nuevo entorno (ej. staging)"
            maxLength={100}
            className="input"
            style={fieldStyle}
            aria-label="Nombre del nuevo entorno"
          />
          <button
            type="submit"
            disabled={createDisabled}
            className="btn-primary"
            style={{ ...controlButtonStyle, ...(createDisabled ? disabledStyle : null) }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 18 }}>
              add
            </span>
            <span>{creating ? "..." : "Crear"}</span>
          </button>
        </form>

        {actionError && (
          <div style={errorBoxStyle} role="alert">
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>
              error
            </span>
            <span>{actionError}</span>
          </div>
        )}

        {envs.loading && !envs.loaded ? (
          <p style={mutedTextStyle}>Cargando entornos...</p>
        ) : envs.error ? (
          <div style={errorBoxStyle} role="alert">
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>
              error
            </span>
            <div>
              <p style={{ margin: 0 }}>{envs.error}</p>
              <button type="button" onClick={() => void envs.reload()} style={linkButtonStyle}>
                Reintentar
              </button>
            </div>
          </div>
        ) : envs.environments.length === 0 ? (
          <div style={emptyStateStyle}>
            <span className="material-symbols-outlined" style={{ fontSize: 32, color: "var(--color-on-surface-variant)" }}>
              layers
            </span>
            <p style={{ ...mutedTextStyle, textAlign: "center" }}>
              Aún no hay entornos. Crea uno (dev, staging, prod...) para reutilizar variables entre escenarios.
            </p>
          </div>
        ) : (
          <ul style={listStyle}>
            {envs.environments.map((env) => (
              <EnvironmentItem
                key={env.id}
                env={env}
                active={env.id === activeId}
                usedInEditor={env.id === runSelection.selectedId}
                onSelect={() => selectEnvironment(env.id)}
                onRename={(name) => handleRename(env, name)}
                onDelete={() => void handleDelete(env)}
              />
            ))}
          </ul>
        )}
      </section>

      {/* Variables of the active environment */}
      <section style={{ ...cardStyle, ...detailCardStyle }}>
        {active === null ? (
          <div style={emptyStateStyle}>
            <span className="material-symbols-outlined" style={{ fontSize: 32, color: "var(--color-on-surface-variant)" }}>
              data_object
            </span>
            <p style={{ ...mutedTextStyle, textAlign: "center" }}>
              Selecciona o crea un entorno para editar sus variables.
            </p>
          </div>
        ) : (
          <>
            <div style={detailHeaderStyle}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="material-symbols-outlined" style={{ fontSize: 18, color: "var(--color-primary)" }}>
                  layers
                </span>
                <h2 style={detailTitleStyle}>{active.name}</h2>
              </div>
              <p style={mutedTextStyle}>
                Usa las variables como <code style={codeStyle}>{"{{nombre}}"}</code> en URL, cabeceras y body. Las
                variables del escenario con el mismo nombre tienen prioridad.
              </p>
            </div>
            {variables.error && !variables.loading ? (
              <div style={errorBoxStyle} role="alert">
                <span className="material-symbols-outlined" style={{ fontSize: 16 }}>
                  error
                </span>
                <div>
                  <p style={{ margin: 0 }}>{variables.error}</p>
                  <button type="button" onClick={() => void variables.reload()} style={linkButtonStyle}>
                    Reintentar
                  </button>
                </div>
              </div>
            ) : (
              <VariableTable
                key={active.id}
                variables={variables.variables}
                loading={variables.loading}
                saving={variables.saving}
                onSave={variables.save}
                onDirtyChange={handleDirtyChange}
              />
            )}
          </>
        )}
      </section>
    </div>
  );
}

interface EnvironmentItemProps {
  env: EnvironmentSummary;
  active: boolean;
  usedInEditor: boolean;
  onSelect: () => void;
  onRename: (name: string) => Promise<boolean>;
  onDelete: () => void;
}

function EnvironmentItem({ env, active, usedInEditor, onSelect, onRename, onDelete }: EnvironmentItemProps) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(env.name);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || trimmed === env.name) {
      setEditing(false);
      setName(env.name);
      return;
    }
    setBusy(true);
    const ok = await onRename(trimmed);
    setBusy(false);
    if (ok) setEditing(false);
  };

  if (editing) {
    return (
      <li>
        <form onSubmit={submit} style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={100}
            autoFocus
            className="input"
            style={{ ...fieldStyle, height: 32, padding: "4px 8px" }}
            aria-label="Nuevo nombre del entorno"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setEditing(false);
                setName(env.name);
              }
            }}
          />
          <button
            type="submit"
            disabled={busy}
            style={{ ...iconButtonStyle, color: "var(--color-secondary)", ...(busy ? disabledStyle : null) }}
            title="Guardar nombre"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 18 }}>
              check
            </span>
          </button>
          <button
            type="button"
            onClick={() => {
              setEditing(false);
              setName(env.name);
            }}
            style={iconButtonStyle}
            title="Cancelar"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 18 }}>
              close
            </span>
          </button>
        </form>
      </li>
    );
  }

  return (
    <li
      className="nav-link"
      style={{ ...itemStyle, ...(active ? itemActiveStyle : null) }}
      aria-current={active ? "true" : undefined}
    >
      <button type="button" onClick={onSelect} style={itemSelectButtonStyle}>
        <span
          className="material-symbols-outlined"
          style={{ fontSize: 16, color: active ? "var(--color-primary)" : "var(--color-on-surface-variant)" }}
        >
          layers
        </span>
        <span style={itemNameStyle}>{env.name}</span>
        {usedInEditor && (
          <span className="badge-success" style={{ flexShrink: 0 }} title="Seleccionado en el editor">
            en uso
          </span>
        )}
      </button>
      <button
        type="button"
        onClick={() => {
          setName(env.name);
          setEditing(true);
        }}
        style={iconButtonStyle}
        title="Renombrar"
        aria-label={`Renombrar ${env.name}`}
      >
        <span className="material-symbols-outlined" style={{ fontSize: 16 }}>
          edit
        </span>
      </button>
      <button
        type="button"
        onClick={onDelete}
        style={iconButtonStyle}
        title="Eliminar"
        aria-label={`Eliminar ${env.name}`}
      >
        <span className="material-symbols-outlined" style={{ fontSize: 16 }}>
          delete
        </span>
      </button>
    </li>
  );
}

// -----------------------------------------------------------------------------
// Styles (inline over the theme CSS variables, as in app/executions/page.tsx)
// -----------------------------------------------------------------------------

const layoutStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "flex-start",
  gap: "16px",
};

const cardStyle: React.CSSProperties = {
  background: "var(--color-surface-container-low)",
  border: "1px solid var(--color-surface-container-high)",
  borderRadius: "12px",
  padding: "16px",
  boxSizing: "border-box",
};

const listCardStyle: React.CSSProperties = {
  flex: "1 1 280px",
  maxWidth: "340px",
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  gap: "12px",
};

const detailCardStyle: React.CSSProperties = {
  flex: "999 1 480px",
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  gap: "16px",
};

const createRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "stretch",
  gap: "8px",
};

const fieldStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  height: "36px",
  fontSize: "13px",
  boxSizing: "border-box",
};

const controlButtonStyle: React.CSSProperties = {
  height: "36px",
  flexShrink: 0,
  fontSize: "13px",
  cursor: "pointer",
  boxSizing: "border-box",
};

const disabledStyle: React.CSSProperties = {
  opacity: 0.5,
  cursor: "not-allowed",
  boxShadow: "none",
};

const mutedTextStyle: React.CSSProperties = {
  margin: 0,
  fontSize: "13px",
  lineHeight: "20px",
  color: "var(--color-on-surface-variant)",
};

const errorBoxStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: "8px",
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

const emptyStateStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: "8px",
  padding: "32px 16px",
  border: "1px dashed var(--color-outline-variant)",
  borderRadius: "8px",
};

const listStyle: React.CSSProperties = {
  margin: 0,
  padding: 0,
  listStyle: "none",
  display: "flex",
  flexDirection: "column",
  gap: "2px",
};

const itemStyle: React.CSSProperties = {
  gap: "4px",
  padding: "4px 4px 4px 10px",
  border: "1px solid transparent",
};

const itemActiveStyle: React.CSSProperties = {
  background: "var(--color-surface-container-high)",
  borderColor: "var(--color-outline-variant)",
  color: "var(--color-on-surface)",
};

const itemSelectButtonStyle: React.CSSProperties = {
  display: "flex",
  flex: 1,
  minWidth: 0,
  alignItems: "center",
  gap: "8px",
  padding: "4px 0",
  background: "none",
  border: "none",
  color: "var(--color-on-surface)",
  fontSize: "13px",
  textAlign: "left",
  cursor: "pointer",
};

const itemNameStyle: React.CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const iconButtonStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: "28px",
  height: "28px",
  flexShrink: 0,
  padding: 0,
  background: "none",
  border: "none",
  borderRadius: "6px",
  color: "var(--color-on-surface-variant)",
  cursor: "pointer",
};

const detailHeaderStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "4px",
  paddingBottom: "12px",
  borderBottom: "1px solid var(--color-surface-container-high)",
};

const detailTitleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: "16px",
  lineHeight: "24px",
  fontWeight: 600,
  color: "var(--color-on-surface)",
};

const codeStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "12px",
  color: "var(--color-secondary)",
};
