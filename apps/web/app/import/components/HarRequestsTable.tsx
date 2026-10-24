"use client";

/**
 * Requests table of the loaded HAR: one row per request that matches the
 * filters, with the include checkbox that decides what the import keeps.
 */

import type { PreviewEntry } from "../../../lib/import/har-preview";
import { statusTone } from "./helpers";

interface HarRequestsTableProps {
  /** Rows that match the filters, in file order. */
  entries: readonly PreviewEntry[];
  /** Indexes of the rows that would be imported. */
  selection: ReadonlySet<number>;
  /** Toggles one row, by its index in the original file. */
  onToggle: (index: number) => void;
}

export function HarRequestsTable({ entries, selection, onToggle }: HarRequestsTableProps) {
  return (
    <section className="card p-0 overflow-hidden">
      {entries.length === 0 ? (
        <div className="text-center py-space-xl">
          <span className="material-symbols-outlined text-on-surface-variant text-[40px] mb-space-md">
            filter_alt_off
          </span>
          <p className="text-body-md text-on-surface-variant">
            Ninguna petición coincide con los filtros.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-surface-container-low">
              <tr className="text-left text-label-code-sm text-on-surface-variant uppercase">
                <th className="table-cell w-12 text-center">Incluir</th>
                <th className="table-cell w-20">Método</th>
                <th className="table-cell">Petición</th>
                <th className="table-cell w-24">Tipo</th>
                <th className="table-cell w-20">Estado</th>
                <th className="table-cell w-24">Duración</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.index} className="table-row">
                  <td className="table-cell text-center">
                    <input
                      type="checkbox"
                      checked={selection.has(entry.index)}
                      onChange={() => onToggle(entry.index)}
                      aria-label={`Incluir ${entry.method} ${entry.url}`}
                    />
                  </td>
                  <td className="table-cell font-mono text-on-surface">{entry.method}</td>
                  <td className="table-cell">
                    <span className="font-mono text-on-surface-variant">{entry.origin}</span>
                    <span className="font-mono text-on-surface">{entry.path}</span>
                  </td>
                  <td className="table-cell font-mono text-on-surface-variant">
                    {entry.resourceType}
                  </td>
                  <td className="table-cell">
                    <span className={statusTone(entry.status)}>{entry.status}</span>
                  </td>
                  <td className="table-cell font-mono text-on-surface-variant">
                    {Math.round(entry.durationMs)} ms
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
