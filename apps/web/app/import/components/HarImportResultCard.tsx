"use client";

/** Result card: the scenario the import created, with its counters and a way in. */

import Link from "next/link";
import { scenarioEditorHref } from "../../../lib/editor/editor-route-params";
import type { ImportedScenario } from "./types";

interface HarImportResultCardProps {
  /** The created scenario, or `null` while there is nothing to show. */
  result: ImportedScenario | null;
}

export function HarImportResultCard({ result }: HarImportResultCardProps) {
  if (result === null) return null;

  return (
    <div className="flex flex-col gap-space-sm p-space-md rounded-lg bg-surface-container-lowest border border-surface-container">
      <div className="flex items-center gap-space-sm">
        <span className="material-symbols-outlined text-[18px] text-success">check_circle</span>
        <span className="text-body-md text-on-surface">
          Escenario «{result.name}» creado
        </span>
      </div>
      <div className="flex flex-wrap gap-space-md text-body-sm text-on-surface-variant">
        <span>{result.stats.importedEntries} peticiones importadas</span>
        <span>{result.stats.steps} pasos</span>
        <span>{result.stats.skippedEntries} omitidas</span>
      </div>
      {result.warnings.length > 0 && (
        <ul className="flex flex-col gap-space-xs">
          {result.warnings.map((warning, position) => (
            <li key={`${position}-${warning}`} className="text-label-code-sm text-on-surface-variant">
              {warning}
            </li>
          ))}
        </ul>
      )}
      <Link href={scenarioEditorHref(result.id)} className="btn-primary justify-center">
        <span className="material-symbols-outlined text-[18px]">account_tree</span>
        <span>Abrir en el editor</span>
      </Link>
    </div>
  );
}
