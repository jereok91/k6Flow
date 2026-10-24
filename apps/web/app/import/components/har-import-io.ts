/**
 * The two places the HAR import screen talks to the outside world: reading the
 * picked file and posting the pruned HAR to `/api/import/har`.
 *
 * Both return a discriminated result instead of throwing, so the page only maps
 * an outcome to state and no error message lives in a presentational component.
 */

import { validateHar } from "@k6flow/shared";
import type { Har } from "@k6flow/shared";
import { harEntries } from "../../../lib/import/har-preview";
import type { ImportOptionsBody, ImportResponse, ImportedScenario } from "./types";

/** Outcome of reading a picked file: a validated HAR or the message to show. */
export type HarFileResult =
  | { ok: true; har: Har; indexes: number[] }
  | { ok: false; error: string };

/** Reads, parses and validates a picked `.har`, the same way the page always did. */
export async function readHarFile(file: File): Promise<HarFileResult> {
  let text: string;
  try {
    text = await file.text();
  } catch {
    return { ok: false, error: "No se pudo leer el archivo. Intenta exportarlo de nuevo." };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false,
      error:
        "El archivo no es JSON válido. Exporta el HAR desde la pestaña Red de las DevTools (Export HAR...).",
    };
  }

  if (!validateHar(parsed)) {
    return {
      ok: false,
      error: "El archivo no tiene formato HAR: falta log.entries con las peticiones.",
    };
  }

  const rows = harEntries(parsed);
  if (rows.length === 0) {
    return { ok: false, error: "El HAR no contiene peticiones para importar." };
  }

  return { ok: true, har: parsed, indexes: rows.map((row) => row.index) };
}

/** Body of `POST /api/import/har`: the already pruned HAR plus its options. */
export interface HarImportRequest {
  name: string;
  har: Har;
  applySuggestedVariables: boolean;
  options: ImportOptionsBody;
}

/** Outcome of the import: the created scenario or the message to show. */
export type HarImportOutcome =
  | { ok: true; scenario: ImportedScenario }
  | { ok: false; error: string };

/** Posts the pruned HAR and normalises every failure into a Spanish message. */
export async function postHarImport(request: HarImportRequest): Promise<HarImportOutcome> {
  try {
    const response = await fetch("/api/import/har", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: request.name,
        har: request.har,
        applySuggestedVariables: request.applySuggestedVariables,
        options: request.options,
      }),
    });

    const payload = (await response.json().catch(() => null)) as
      | (Partial<ImportResponse> & { error?: string })
      | null;

    if (!response.ok) {
      return {
        ok: false,
        error: payload?.error ?? `No se pudo importar el HAR (HTTP ${response.status}).`,
      };
    }

    if (payload?.id === undefined || payload.stats === undefined) {
      return { ok: false, error: "La respuesta del servidor no trajo el escenario creado." };
    }

    return {
      ok: true,
      scenario: {
        id: payload.id,
        name: payload.name ?? request.name,
        stats: payload.stats,
        warnings: payload.warnings ?? [],
      },
    };
  } catch {
    return { ok: false, error: "No se pudo contactar con el servidor de importación." };
  }
}
