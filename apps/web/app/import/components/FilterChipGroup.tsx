"use client";

/** One row of toggle chips, as the resource-type and method filters render it. */

interface FilterChipGroupProps<Value extends string> {
  /** Field label shown above the chips. */
  label: string;
  /** Chips, in the order the caller wants them. */
  values: readonly Value[];
  /** Chips drawn as active. */
  active: readonly Value[];
  /** Called with the chip value; the caller decides what toggling it means. */
  onToggle: (value: Value) => void;
}

export function FilterChipGroup<Value extends string>({
  label,
  values,
  active,
  onToggle,
}: FilterChipGroupProps<Value>) {
  return (
    <div className="flex flex-col gap-space-xs">
      <span className="text-body-sm text-on-surface-variant">{label}</span>
      <div className="flex flex-wrap gap-space-xs">
        {values.map((value) => {
          const isActive = active.includes(value);
          return (
            <button
              key={value}
              type="button"
              onClick={() => onToggle(value)}
              className={`px-space-md py-1 rounded-lg text-body-sm font-mono transition-all ${
                isActive
                  ? "bg-surface-container-high text-on-surface shadow-sm"
                  : "bg-surface-container-lowest text-on-surface-variant"
              }`}
            >
              {value}
            </button>
          );
        })}
      </div>
    </div>
  );
}
