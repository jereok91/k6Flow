"use client";

// Configures the wait a connection carries: the pause between the source
// request and the next one. The value is stored in seconds; the user may type
// seconds or minutes.

import { useState } from "react";
import { ConfigPanel } from "./ConfigPanel";
import {
  MAX_WAIT_SECONDS,
  WAIT_UNITS,
  isValidWait,
  toDisplay,
  toDisplayInUnit,
  toSeconds,
  type WaitUnit,
} from "./connection-wait";

const UNIT_LABELS: Record<WaitUnit, string> = { seconds: "segundos", minutes: "minutos" };
const MAX_PER_UNIT: Record<WaitUnit, number> = { seconds: MAX_WAIT_SECONDS, minutes: MAX_WAIT_SECONDS / 60 };

interface ConnectionConfigPanelProps {
  /** Labels of the nodes at both ends, for the header. */
  fromLabel: string;
  toLabel: string;
  waitSeconds?: number;
  onChange: (waitSeconds: number | undefined) => void;
  onClose: () => void;
}

export function ConnectionConfigPanel({
  fromLabel,
  toLabel,
  waitSeconds,
  onChange,
  onClose,
}: ConnectionConfigPanelProps) {
  const shown = toDisplay(waitSeconds ?? 0);
  const [value, setValue] = useState(String(shown.value));
  const [unit, setUnit] = useState<WaitUnit>(shown.unit);

  const seconds = toSeconds(Number(value), unit);
  const valid = value.trim() !== "" && isValidWait(seconds);

  // Keep the total when the unit changes: 300 s stays 300 s, shown as 5 min.
  const changeUnit = (nextUnit: WaitUnit) => {
    setValue(toDisplayInUnit(toSeconds(Number(value) || 0, unit), nextUnit));
    setUnit(nextUnit);
  };

  const save = () => {
    if (!valid) return;
    onChange(seconds > 0 ? seconds : undefined);
    onClose();
  };

  return (
    <ConfigPanel kind="http-request" title="Espera en la conexión" onClose={onClose}>
      <div className="flex flex-col gap-space-sm text-body-sm text-on-surface">
        <p className="text-on-surface-variant">
          {fromLabel} → {toLabel}
        </p>

        <label htmlFor="connection-wait-value">Tiempo de espera entre peticiones</label>
        <div className="flex gap-space-sm">
          <input
            id="connection-wait-value"
            className="input"
            type="number"
            min={0}
            max={MAX_PER_UNIT[unit]}
            step="any"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          <select
            className="input"
            aria-label="Unidad del tiempo de espera"
            value={unit}
            onChange={(event) => changeUnit(event.target.value as WaitUnit)}
          >
            {WAIT_UNITS.map((candidate) => (
              <option key={candidate} value={candidate}>
                {UNIT_LABELS[candidate]}
              </option>
            ))}
          </select>
        </div>

        {!valid && (
          <p className="text-error">
            Ingresá un valor entre 0 y {MAX_PER_UNIT[unit]} {UNIT_LABELS[unit]}
          </p>
        )}

        <p className="text-on-surface-variant">
          Se traduce a sleep({valid ? seconds : 0}) en el script de k6.
        </p>

        <div className="flex gap-space-sm">
          <button className="btn-primary" onClick={save} disabled={!valid}>
            Guardar
          </button>
          <button
            className="btn-secondary"
            onClick={() => {
              onChange(undefined);
              onClose();
            }}
          >
            Quitar espera
          </button>
        </div>
      </div>
    </ConfigPanel>
  );
}
