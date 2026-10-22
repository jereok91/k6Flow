/**
 * The `/editor` URL contract.
 *
 * Every entry point that opens the editor with a scenario loaded writes its
 * parameter through `scenarioEditorHref`, and the editor reads it back through
 * `resolveEditorScenarioId`. Keeping both halves here is the point: when they
 * lived in separate files they disagreed (`?id=<uuid>` was read with `parseInt`,
 * which yields NaN and silently opened an empty editor).
 *
 * Scenario ids are opaque text ids (UUIDs), so the parameter is never converted
 * to a number. The legacy `?id=` name stays readable for links already handed out.
 */

/** Canonical href that opens the editor with one scenario loaded. */
export function scenarioEditorHref(scenarioId: string): string {
  return `/editor?scenario=${encodeURIComponent(scenarioId)}`;
}

interface QueryParams {
  get(name: string): string | null;
}

/** First named parameter carrying a value; a blank value is not one. */
function firstNonBlank(params: QueryParams, names: readonly string[]): string | null {
  for (const name of names) {
    const value = params.get(name)?.trim() ?? "";
    if (value !== "") return value;
  }
  return null;
}

/**
 * Scenario id requested by an editor URL, or null when the URL names none.
 * `?scenario=` wins over the legacy `?id=`, and a blank value is not an id.
 */
export function resolveEditorScenarioId(params: QueryParams): string | null {
  return firstNonBlank(params, ["scenario", "id"]);
}
