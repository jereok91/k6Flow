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

  return (
    <div className="grid grid-cols-1 gap-space-lg lg:grid-cols-[300px_minmax(0,1fr)]">
      {/* Environment list */}
      <section className="flex flex-col gap-space-md rounded-xl border border-surface-container-high bg-surface-container-low p-space-lg">
        <form onSubmit={handleCreate} className="flex gap-space-sm">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Nuevo entorno (ej. staging)"
            maxLength={100}
            className="input text-body-sm"
            aria-label="Nombre del nuevo entorno"
          />
          <button type="submit" disabled={!newName.trim() || creating} className="btn-primary disabled:opacity-50">
            <span className="material-symbols-outlined text-[16px]">add</span>
            <span>{creating ? "..." : "Crear"}</span>
          </button>
        </form>

        {actionError && <p className="text-body-sm text-error">{actionError}</p>}

        {envs.loading && !envs.loaded ? (
          <p className="text-body-sm text-on-surface-variant">Cargando entornos...</p>
        ) : envs.error ? (
          <div className="text-body-sm text-error">
            <p>{envs.error}</p>
            <button type="button" onClick={() => void envs.reload()} className="mt-1 underline">
              Reintentar
            </button>
          </div>
        ) : envs.environments.length === 0 ? (
          <p className="text-body-sm text-on-surface-variant">
            Aún no hay entornos. Crea uno (dev, staging, prod...) para reutilizar variables entre escenarios.
          </p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
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
      <section className="rounded-xl border border-surface-container-high bg-surface-container-low p-space-lg">
        {active === null ? (
          <p className="text-body-md text-on-surface-variant">Selecciona o crea un entorno para editar sus variables.</p>
        ) : (
          <>
            <div className="mb-space-md flex flex-col gap-1">
              <h2 className="m-0 text-headline-sm font-semibold text-on-surface">{active.name}</h2>
              <p className="m-0 text-body-sm text-on-surface-variant">
                Usa las variables como <code className="font-mono text-secondary">{"{{nombre}}"}</code> en URL,
                cabeceras y body. Las variables del escenario con el mismo nombre tienen prioridad.
              </p>
            </div>
            {variables.error && !variables.loading ? (
              <div className="text-body-sm text-error">
                <p>{variables.error}</p>
                <button type="button" onClick={() => void variables.reload()} className="mt-1 underline">
                  Reintentar
                </button>
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
        <form onSubmit={submit} className="flex items-center gap-1">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={100}
            autoFocus
            className="input py-1 text-body-sm"
            aria-label="Nuevo nombre del entorno"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setEditing(false);
                setName(env.name);
              }
            }}
          />
          <button type="submit" disabled={busy} className="p-1 text-secondary" title="Guardar nombre">
            <span className="material-symbols-outlined text-[18px]">check</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setEditing(false);
              setName(env.name);
            }}
            className="p-1 text-on-surface-variant"
            title="Cancelar"
          >
            <span className="material-symbols-outlined text-[18px]">close</span>
          </button>
        </form>
      </li>
    );
  }

  return (
    <li
      className={`group flex items-center gap-1 rounded-lg px-2 py-1.5 ${
        active ? "bg-surface-container-high" : "hover:bg-surface-container"
      }`}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-2 text-left text-body-sm text-on-surface"
      >
        <span className="material-symbols-outlined text-[16px] text-on-surface-variant">layers</span>
        <span className="truncate">{env.name}</span>
        {usedInEditor && (
          <span className="shrink-0 rounded bg-secondary/15 px-1 text-[10px] text-secondary" title="Seleccionado en el editor">
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
        className="p-1 text-on-surface-variant hover:text-on-surface"
        title="Renombrar"
        aria-label={`Renombrar ${env.name}`}
      >
        <span className="material-symbols-outlined text-[16px]">edit</span>
      </button>
      <button
        type="button"
        onClick={onDelete}
        className="p-1 text-on-surface-variant hover:text-error"
        title="Eliminar"
        aria-label={`Eliminar ${env.name}`}
      >
        <span className="material-symbols-outlined text-[16px]">delete</span>
      </button>
    </li>
  );
}
