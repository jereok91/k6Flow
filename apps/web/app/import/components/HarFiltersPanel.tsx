"use client";

/**
 * Filters panel: resource-type and method toggles, status/domain/search fields,
 * the selection counters and the "mark visible" actions.
 *
 * The panel never filters anything itself: it only edits the form state the page
 * feeds into `lib/import/har-preview.ts`, and reports what the current selection
 * would import through `summary`.
 */

import { HAR_RESOURCE_TYPES } from "@k6flow/shared";
import type { HarResourceType } from "@k6flow/shared";
import type { PreviewSummary } from "../../../lib/import/har-preview";
import { FilterChipGroup } from "./FilterChipGroup";
import { resourceTypeList, toggleIn } from "./helpers";
import { EMPTY_FILTERS } from "./types";
import type { FilterState } from "./types";

interface HarFiltersPanelProps {
  filters: FilterState;
  /** Functional update, so the panel always toggles the latest filters. */
  onFiltersChange: (update: (previous: FilterState) => FilterState) => void;
  /** Resource types the table currently allows. */
  activeResourceTypes: readonly HarResourceType[];
  /** Methods the table currently allows. */
  activeMethods: readonly string[];
  /** Methods present in the file. */
  methodOptions: readonly string[];
  /** Counters of the current selection. */
  summary: PreviewSummary;
  /** Rows that match the filters. */
  visibleCount: number;
  onSelectVisible: () => void;
  onDeselectVisible: () => void;
}

export function HarFiltersPanel({
  filters,
  onFiltersChange,
  activeResourceTypes,
  activeMethods,
  methodOptions,
  summary,
  visibleCount,
  onSelectVisible,
  onDeselectVisible,
}: HarFiltersPanelProps) {
  return (
    <section className="card flex flex-col gap-space-md">
      <div className="flex items-center justify-between gap-space-md">
        <h2 className="text-headline-sm text-on-surface font-medium">Filtros</h2>
        <button
          type="button"
          onClick={() => onFiltersChange(() => EMPTY_FILTERS)}
          className="btn-secondary"
        >
          <span className="material-symbols-outlined text-[16px]">filter_alt_off</span>
          <span>Limpiar filtros</span>
        </button>
      </div>

      <FilterChipGroup
        label="Tipo de petición"
        values={HAR_RESOURCE_TYPES}
        active={activeResourceTypes}
        onToggle={(resourceType) =>
          onFiltersChange((previous) => ({
            ...previous,
            resourceTypes: toggleIn(resourceTypeList(previous.resourceTypes), resourceType),
          }))
        }
      />

      <FilterChipGroup
        label="Método"
        values={methodOptions}
        active={activeMethods}
        onToggle={(method) =>
          onFiltersChange((previous) => ({
            ...previous,
            methods: toggleIn(
              previous.methods.length === 0 ? [...methodOptions] : previous.methods,
              method,
            ),
          }))
        }
      />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-space-md">
        <div>
          <label className="block text-body-sm text-on-surface-variant mb-space-sm">
            Estado mínimo
          </label>
          <input
            type="number"
            min={0}
            value={filters.statusMin}
            onChange={(event) =>
              onFiltersChange((previous) => ({ ...previous, statusMin: event.target.value }))
            }
            placeholder="200"
            className="input"
          />
        </div>
        <div>
          <label className="block text-body-sm text-on-surface-variant mb-space-sm">
            Estado máximo
          </label>
          <input
            type="number"
            min={0}
            value={filters.statusMax}
            onChange={(event) =>
              onFiltersChange((previous) => ({ ...previous, statusMax: event.target.value }))
            }
            placeholder="299"
            className="input"
          />
        </div>
        <div>
          <label className="block text-body-sm text-on-surface-variant mb-space-sm">
            Incluir dominios
          </label>
          <input
            type="text"
            value={filters.includeDomains}
            onChange={(event) =>
              onFiltersChange((previous) => ({ ...previous, includeDomains: event.target.value }))
            }
            placeholder="api.example.com, example.com"
            className="input"
          />
        </div>
        <div>
          <label className="block text-body-sm text-on-surface-variant mb-space-sm">
            Excluir dominios
          </label>
          <input
            type="text"
            value={filters.excludeDomains}
            onChange={(event) =>
              onFiltersChange((previous) => ({ ...previous, excludeDomains: event.target.value }))
            }
            placeholder="google-analytics.com, sentry.io"
            className="input"
          />
        </div>
      </div>

      <div>
        <label className="block text-body-sm text-on-surface-variant mb-space-sm">
          Buscar en método o URL
        </label>
        <div className="relative flex items-center">
          <span className="material-symbols-outlined absolute left-space-md text-[18px] text-on-surface-variant">
            search
          </span>
          <input
            type="text"
            value={filters.text}
            onChange={(event) =>
              onFiltersChange((previous) => ({ ...previous, text: event.target.value }))
            }
            placeholder="/api/v1/items"
            className="input pl-10"
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-space-md text-body-sm text-on-surface-variant">
        <span>
          <span className="badge-success">{summary.kept} seleccionadas</span>
        </span>
        <span>
          <span className="badge-warning">{summary.dropped} fuera</span>
        </span>
        <span className="font-mono">{visibleCount} visibles</span>
        <span className="text-label-code-sm text-on-surface-variant">
          Solo se importan las peticiones visibles que estén marcadas.
        </span>
        <div className="flex items-center gap-space-xs ml-auto">
          <button type="button" onClick={onSelectVisible} className="btn-secondary">
            <span className="material-symbols-outlined text-[16px]">check_box</span>
            <span>Marcar visibles</span>
          </button>
          <button type="button" onClick={onDeselectVisible} className="btn-secondary">
            <span className="material-symbols-outlined text-[16px]">
              check_box_outline_blank
            </span>
            <span>Desmarcar visibles</span>
          </button>
        </div>
      </div>
    </section>
  );
}
