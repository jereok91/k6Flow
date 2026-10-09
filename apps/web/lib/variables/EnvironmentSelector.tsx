"use client";

// k6flow-variables V-T4: environment dropdown shown next to "Ejecutar" in the editor.
// The selection is persisted by `useSelectedEnvironment` and passed to the run.

import Link from "next/link";
import type { EnvironmentSummary } from "./use-variables";

interface EnvironmentSelectorProps {
  environments: readonly EnvironmentSummary[];
  selectedId: string | null;
  onChange: (id: string | null) => void;
  loading?: boolean;
  error?: string | null;
  disabled?: boolean;
}

export function EnvironmentSelector({
  environments,
  selectedId,
  onChange,
  loading,
  error,
  disabled,
}: EnvironmentSelectorProps) {
  return (
    <div className="flex items-center gap-1" title={error ? `Entornos: ${error}` : "Entorno de ejecución"}>
      <span className="material-symbols-outlined text-[16px] text-on-surface-variant">layers</span>
      <select
        value={selectedId ?? ""}
        onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
        disabled={disabled || loading}
        aria-label="Entorno de ejecución"
        className={`h-9 max-w-[180px] rounded-xl border bg-surface-container-lowest px-2 text-body-sm text-on-surface outline-none focus:border-primary-container disabled:opacity-50 ${
          error ? "border-error" : "border-outline-variant"
        }`}
      >
        <option value="">{loading ? "Cargando..." : "Sin entorno"}</option>
        {environments.map((env) => (
          <option key={env.id} value={env.id}>
            {env.name}
          </option>
        ))}
      </select>
      <Link
        href="/environments"
        className="flex h-9 w-9 items-center justify-center rounded-xl text-on-surface-variant hover:bg-surface-container hover:text-on-surface"
        title="Gestionar entornos"
        aria-label="Gestionar entornos"
      >
        <span className="material-symbols-outlined text-[16px]">tune</span>
      </Link>
    </div>
  );
}
