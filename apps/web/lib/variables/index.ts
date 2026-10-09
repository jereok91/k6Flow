// k6flow-variables V-T4: client-side variables UI exports.
// Server-only modules (store.ts, validation.ts) are intentionally not re-exported here.

export { VariablesPanel, VariableTable, STORED_SECRET_PLACEHOLDER } from "./VariablesPanel";
export { EnvironmentsManager } from "./EnvironmentsManager";
export { EnvironmentSelector } from "./EnvironmentSelector";
export { VariableInput, TokenChip } from "./VariableInput";
export {
  segmentTemplate,
  getAutocompleteContext,
  filterVariableNames,
  applyAutocomplete,
  collectGraphVariables,
  type HighlightSegment,
  type AutocompleteContext,
} from "./template-highlight";
export {
  useEnvironments,
  useEnvironmentVariables,
  useScenarioVariables,
  useSelectedEnvironment,
  useVariableSet,
  mergedVariableNames,
  SELECTED_ENVIRONMENT_STORAGE_KEY,
  type EnvironmentSummary,
  type MaskedVariable,
  type VariableSetState,
} from "./use-variables";
