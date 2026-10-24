"use client";

/**
 * Auth panel: HAR exports usually travel without credentials, so this card lets
 * the user declare one scheme (bearer, basic, API key, cookie or a custom
 * header) and choose which of the already checked requests get that header.
 *
 * Nothing is stamped here: the panel only edits `AuthPanelState`, the page turns
 * it into `buildUploadHar` and both the preview and the upload read that HAR.
 */

import type { PreviewEntry } from "../../../lib/import/har-preview";
import { authHeaderFor, type HarAuthConfig, type HarAuthKind } from "../../../lib/import/har-auth";
import type { AuthPanelState } from "./types";

interface HarAuthPanelProps {
  state: AuthPanelState;
  onChange: (state: AuthPanelState) => void;
  /** Every row of the file, so the scoped list can label the checked ones. */
  rows: readonly PreviewEntry[];
  /** Rows that would be imported (`visible ∧ checked`). */
  selection: ReadonlySet<number>;
}

const KIND_OPTIONS: ReadonlyArray<{ value: HarAuthKind; label: string }> = [
  { value: "none", label: "Sin autenticación" },
  { value: "bearer", label: "Bearer token (JWT)" },
  { value: "basic", label: "Basic" },
  { value: "api-key", label: "API key" },
  { value: "cookie", label: "Cookie" },
  { value: "custom-header", label: "Cabecera personalizada" },
];

const KIND_HINTS: Readonly<Record<HarAuthKind, string>> = {
  none: "Las peticiones se importan tal como vienen en el HAR.",
  bearer: "Añade Authorization: Bearer <token> a las peticiones elegidas.",
  basic: "Añade Authorization: Basic con usuario y contraseña en base64.",
  "api-key": "Añade la clave en su propia cabecera; por defecto x-api-key.",
  cookie: "Añade la cabecera Cookie con el valor que escribas.",
  "custom-header": "Añade la cabecera que escribas con el valor indicado.",
};

interface AuthFieldProps {
  label: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
  /** `password` hides the value for the credential fields. */
  type?: "text" | "password";
}

function AuthField({ label, value, placeholder, onChange, type = "text" }: AuthFieldProps) {
  return (
    <div>
      <label className="block text-body-sm text-on-surface-variant mb-space-sm">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="input"
      />
    </div>
  );
}

export function HarAuthPanel({ state, onChange, rows, selection }: HarAuthPanelProps) {
  const { config, picked } = state;
  const update = (patch: Partial<HarAuthConfig>): void =>
    onChange({ ...state, config: { ...config, ...patch } });
  const header = authHeaderFor(config);
  const isSome = config.scope === "some";
  const scopedRows = rows.filter((row) => selection.has(row.index));
  const isChecked = (index: number): boolean => picked === null || picked.has(index);

  const togglePicked = (index: number): void => {
    const next = new Set(picked ?? selection);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    onChange({ ...state, picked: next });
  };

  return (
    <section className="card flex flex-col gap-space-md" aria-labelledby="har-auth">
      <div className="flex items-center justify-between gap-space-md">
        <h2 id="har-auth" className="text-headline-sm text-on-surface font-medium">
          Autenticación
        </h2>
        <span className={header === null ? "badge-warning" : "badge-success"}>
          {header === null ? "sin cabecera" : header.name}
        </span>
      </div>

      <p className="text-body-sm text-on-surface-variant">
        Los HAR suelen exportarse sin credenciales. Elige un esquema y se añadirá a las peticiones
        que decidas antes de importarlas; el archivo no se envía hasta confirmar.
      </p>

      <div>
        <label className="block text-body-sm text-on-surface-variant mb-space-sm">
          Esquema de autenticación
        </label>
        <select
          value={config.kind}
          onChange={(event) => update({ kind: event.target.value as HarAuthKind })}
          className="input"
        >
          {KIND_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      {config.kind === "bearer" && (
        <AuthField
          label="Token"
          value={config.token ?? ""}
          onChange={(token) => update({ token })}
          placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6..."
          type="password"
        />
      )}

      {config.kind === "basic" && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-space-md">
          <AuthField
            label="Usuario"
            value={config.username ?? ""}
            onChange={(username) => update({ username })}
            placeholder="usuario@example.com"
          />
          <AuthField
            label="Contraseña"
            value={config.password ?? ""}
            onChange={(password) => update({ password })}
            placeholder="••••••••"
            type="password"
          />
        </div>
      )}

      {(config.kind === "api-key" || config.kind === "custom-header") && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-space-md">
          <AuthField
            label="Cabecera"
            value={config.headerName ?? ""}
            onChange={(headerName) => update({ headerName })}
            placeholder={config.kind === "api-key" ? "x-api-key" : "X-Mi-Cabecera"}
          />
          <AuthField
            label="Valor"
            value={config.headerValue ?? ""}
            onChange={(headerValue) => update({ headerValue })}
            placeholder="valor de la cabecera"
            type="password"
          />
        </div>
      )}

      {config.kind === "cookie" && (
        <AuthField
          label="Cookie"
          value={config.cookie ?? ""}
          onChange={(cookie) => update({ cookie })}
          placeholder="session=abc123; theme=dark"
          type="password"
        />
      )}

      <p className="text-label-code-sm text-on-surface-variant">{KIND_HINTS[config.kind]}</p>

      <div className="flex flex-col gap-space-xs">
        <span className="text-body-sm text-on-surface-variant">Alcance</span>
        <label className="flex items-center gap-space-sm text-body-sm text-on-surface-variant">
          <input
            type="radio"
            name="har-auth-scope"
            checked={!isSome}
            onChange={() => onChange({ ...state, config: { ...config, scope: "all" } })}
          />
          Todas las peticiones seleccionadas
        </label>
        <label className="flex items-center gap-space-sm text-body-sm text-on-surface-variant">
          <input
            type="radio"
            name="har-auth-scope"
            checked={isSome}
            onChange={() => onChange({ ...state, config: { ...config, scope: "some" } })}
          />
          Solo algunas
        </label>
      </div>

      {isSome && (
        <div className="flex flex-col gap-space-xs max-h-48 overflow-y-auto p-space-md rounded-lg bg-surface-container-lowest border border-surface-container">
          {scopedRows.length === 0 ? (
            <p className="text-body-sm text-on-surface-variant">
              Marca peticiones en la tabla para poder elegir aquí cuáles reciben la cabecera.
            </p>
          ) : (
            scopedRows.map((row) => (
              <label
                key={row.index}
                className="flex items-center gap-space-sm text-label-code-sm text-on-surface-variant"
              >
                <input
                  type="checkbox"
                  checked={isChecked(row.index)}
                  onChange={() => togglePicked(row.index)}
                  aria-label={`Autenticar ${row.method} ${row.url}`}
                />
                <span className="font-mono text-on-surface">{row.method}</span>
                <span className="font-mono truncate">{row.path}</span>
              </label>
            ))
          )}
        </div>
      )}

      <p className="text-label-code-sm text-on-surface-variant">
        El token se puede extraer como variable secreta desde el panel de variables sugeridas
        después de importar.
      </p>
    </section>
  );
}
