"use client";

// k6flow-variables V-T4: controlled text input/textarea with `{{name}}` token preview
// (known vs undefined variables) and autocomplete after typing `{{`.

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent, SyntheticEvent } from "react";
import { inputStyle } from "../editor/ConfigPanel";
import {
  applyAutocomplete,
  filterVariableNames,
  getAutocompleteContext,
  segmentTemplate,
  type AutocompleteContext,
  type HighlightSegment,
} from "./template-highlight";

const MAX_SUGGESTIONS = 8;

interface VariableInputProps {
  value: string;
  onChange: (value: string) => void;
  /** Names defined in the merged set (selected environment + scenario). */
  variableNames: readonly string[];
  placeholder?: string;
  disabled?: boolean;
  multiline?: boolean;
  rows?: number;
  mono?: boolean;
  /** "inline": whole value with chips (short fields); "chips": only the token chips (bodies). */
  preview?: "inline" | "chips";
}

type FieldElement = HTMLInputElement | HTMLTextAreaElement;

export function VariableInput({
  value,
  onChange,
  variableNames,
  placeholder,
  disabled,
  multiline,
  rows = 3,
  mono,
  preview = "inline",
}: VariableInputProps) {
  const fieldRef = useRef<FieldElement | null>(null);
  const pendingCaret = useRef<number | null>(null);
  const [context, setContext] = useState<AutocompleteContext | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const suggestions = useMemo(
    () => (context ? filterVariableNames(variableNames, context.query).slice(0, MAX_SUGGESTIONS) : []),
    [context, variableNames],
  );
  const segments = useMemo(() => segmentTemplate(value, variableNames), [value, variableNames]);

  // Restore the caret after an autocomplete insertion re-renders the controlled value.
  useLayoutEffect(() => {
    const caret = pendingCaret.current;
    const field = fieldRef.current;
    if (caret === null || !field) return;
    pendingCaret.current = null;
    field.focus();
    field.setSelectionRange(caret, caret);
  }, [value]);

  const refreshContext = (field: FieldElement) => {
    const { selectionStart, selectionEnd } = field;
    const next =
      selectionStart !== null && selectionStart === selectionEnd
        ? getAutocompleteContext(field.value, selectionStart)
        : null;
    setContext(next);
    setActiveIndex(0);
  };

  const choose = (name: string) => {
    if (!context) return;
    const result = applyAutocomplete(value, context, name);
    pendingCaret.current = result.caret;
    setContext(null);
    onChange(result.text);
  };

  const handleChange = (event: ChangeEvent<FieldElement>) => {
    onChange(event.target.value);
    refreshContext(event.target);
  };

  const handleKeyDown = (event: KeyboardEvent<FieldElement>) => {
    if (!context) return;
    if (event.key === "Escape") {
      event.preventDefault();
      setContext(null);
      return;
    }
    if (suggestions.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((i) => (i + 1) % suggestions.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
    } else if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      choose(suggestions[Math.min(activeIndex, suggestions.length - 1)]);
    }
  };

  const handleNavigation = (event: SyntheticEvent<FieldElement>) => {
    const key = (event as KeyboardEvent<FieldElement>).key;
    if (key && !["ArrowLeft", "ArrowRight", "Home", "End"].includes(key)) return;
    refreshContext(event.currentTarget);
  };

  const fieldProps = {
    value,
    placeholder,
    disabled,
    onChange: handleChange,
    onKeyDown: handleKeyDown,
    onKeyUp: handleNavigation,
    onClick: handleNavigation,
    onBlur: () => setContext(null),
    spellCheck: false,
    autoComplete: "off",
    "aria-autocomplete": "list" as const,
    "aria-expanded": context !== null,
  };

  return (
    <div>
      <div style={{ position: "relative" }}>
        {multiline ? (
          <textarea
            {...fieldProps}
            ref={(el) => {
              fieldRef.current = el;
            }}
            rows={rows}
            style={{
              ...inputStyle,
              resize: "vertical",
              fontFamily: mono ? "'Fira Code', 'Monaco', 'Consolas', monospace" : undefined,
              fontSize: mono ? "13px" : undefined,
              lineHeight: mono ? "1.5" : undefined,
            }}
          />
        ) : (
          <input
            {...fieldProps}
            ref={(el) => {
              fieldRef.current = el;
            }}
            type="text"
            style={inputStyle}
          />
        )}
        {context && (
          <div
            role="listbox"
            className="absolute left-0 right-0 z-20 mt-1 overflow-hidden rounded-lg border border-outline-variant bg-surface-container-high shadow-lg"
          >
            {suggestions.length === 0 ? (
              <div className="px-3 py-2 text-[11px] text-on-surface-variant">
                {variableNames.length === 0
                  ? "No variables defined. Add them in Variables or Entornos."
                  : "No matching variables"}
              </div>
            ) : (
              suggestions.map((name, index) => (
                <button
                  key={name}
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  // Keep focus in the field so the caret survives the insertion.
                  onMouseDown={(event) => {
                    event.preventDefault();
                    choose(name);
                  }}
                  onMouseEnter={() => setActiveIndex(index)}
                  className={`block w-full px-3 py-1.5 text-left font-mono text-[12px] ${
                    index === activeIndex ? "bg-secondary/20 text-on-surface" : "text-on-surface-variant"
                  }`}
                >
                  {`{{${name}}}`}
                </button>
              ))
            )}
          </div>
        )}
      </div>
      <TokenPreview segments={segments} mode={preview} />
    </div>
  );
}

function TokenPreview({ segments, mode }: { segments: HighlightSegment[]; mode: "inline" | "chips" }) {
  const tokens = segments.filter((s): s is Exclude<HighlightSegment, { type: "text" }> => s.type !== "text");
  if (tokens.length === 0) return null;

  if (mode === "chips") {
    const seen = new Set<string>();
    const unique = tokens.filter((t) => (seen.has(t.name) ? false : (seen.add(t.name), true)));
    return (
      <div className="mt-1 flex flex-wrap gap-1">
        {unique.map((token) => (
          <TokenChip key={token.name} token={token} />
        ))}
      </div>
    );
  }

  return (
    <div className="mt-1 break-all font-mono text-[11px] leading-5 text-on-surface-variant">
      {segments.map((segment, index) =>
        segment.type === "text" ? (
          <span key={index}>{segment.value}</span>
        ) : (
          <TokenChip key={index} token={segment} />
        ),
      )}
    </div>
  );
}

export function TokenChip({ token }: { token: { type: "known" | "unknown"; name: string } }) {
  const known = token.type === "known";
  return (
    <span
      title={
        known
          ? `Variable "${token.name}" is defined`
          : `Variable "${token.name}" is not defined in the scenario or the selected environment`
      }
      className={`mx-[1px] inline-flex items-center gap-0.5 rounded px-1 font-mono text-[11px] leading-4 ${
        known
          ? "border border-secondary/40 bg-secondary/15 text-secondary"
          : "border border-amber-500/50 bg-amber-500/15 text-amber-500"
      }`}
    >
      {!known && <span aria-hidden>⚠</span>}
      {`{{${token.name}}}`}
    </span>
  );
}
