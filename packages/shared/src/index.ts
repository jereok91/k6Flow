export { CONTRACT_VERSION, versionEnvelopeSchema } from "./version";
export type { VersionEnvelope } from "./version";
export { graphDraftStructureSchema, graphExecutionTopologySchema } from "./graph";
export type { GraphDraftStructure, GraphExecutionTopology } from "./graph";
export {
  producerOutputReferenceSchema, jsonValueSchema,
  stringParameterValueSchema, jsonParameterValueSchema,
} from "./parameter-values";
export type {
  ProducerOutputReference, JsonValue, StringParameterValue, JsonParameterValue,
} from "./parameter-values";
export {
  httpMethodSchema, httpNamedValueSchema, httpBodySchema, httpParametersSchema,
} from "./http-parameters";
export type { HttpMethod, HttpNamedValue, HttpBody, HttpParameters } from "./http-parameters";
export {
  authJsonPathSegmentSchema, authOutputSelectorSchema, authOutputTypeSchema,
  authOutputSchema, authMethodSchema, authOutputFailurePolicySchema, authParametersSchema,
} from "./auth-parameters";
export type {
  AuthJsonPathSegment, AuthOutputSelector, AuthOutputType, AuthOutput,
  AuthMethod, AuthOutputFailurePolicy, AuthParameters,
} from "./auth-parameters";
export {
  checkJsonPathSegmentSchema, checkNumericOperatorSchema, responseCheckSchema,
  checkFailurePolicySchema, checkParametersSchema,
} from "./check-parameters";
export type {
  CheckJsonPathSegment, CheckNumericOperator, ResponseCheck,
  CheckFailurePolicy, CheckParameters,
} from "./check-parameters";
export {
  csvPoolAttachmentSchema, csvPoolOutputSchema, csvPoolAllocationSchema,
  csvPoolCapacityPolicySchema, csvPoolParametersSchema,
} from "./csv-pool-parameters";
export type {
  CsvPoolAttachment, CsvPoolOutput, CsvPoolAllocation,
  CsvPoolCapacityPolicy, CsvPoolParameters,
} from "./csv-pool-parameters";
export {
  loadStageSchema, loadProfileSchema, loadThresholdSchema,
  loadThresholdPolicySchema, loadParametersSchema,
} from "./load-parameters";
export type {
  LoadStage, LoadProfile, LoadThreshold, LoadThresholdPolicy, LoadParameters,
} from "./load-parameters";
export { graphDraftCompositionSchema, graphReadyCompositionSchema } from "./graph-composition";
export type { GraphDraftComposition, GraphReadyComposition } from "./graph-composition";
export {
  runStatusSchema, runTerminalStatusSchema, idempotencyKeySchema, runStartConfigSchema,
  runReferenceSchema, runStateSchema, runTotalsSchema, runLatencySchema, runSummarySchema,
  runErrorCodeSchema, runErrorCatalogSchema, runErrorResponseSchema, deriveRunStartOutcome,
} from "./runs-rest";
export type {
  RunStatus, RunTerminalStatus, RunStartConfig, RunReference, RunState, RunTotals,
  RunLatency, RunSummary, RunErrorCode, RunErrorCatalog, RunErrorResponse,
  RunStartDedupeRecord, RunStartDedupeOutcome,
} from "./runs-rest";
export { metricsWindowSchema, metricsLatencySchema, metricsFrameSchema } from "./metrics-messages";
export type { MetricsWindow, MetricsLatency, MetricsFrame } from "./metrics-messages";
export {
  recorderStatusSchema, recorderTerminalStatusSchema, recorderCleanupTriggerSchema,
  recorderHeaderEntrySchema, recorderCaptureEntrySchema,
  recorderCreateRequestSchema, recorderCreateResponseSchema,
  recorderStateResponseSchema, recorderStopResponseSchema,
  recorderErrorCodeSchema, recorderErrorCatalogSchema, recorderErrorResponseSchema,
  recorderWsInputFrameSchema, RECORDER_WS_TOPIC_PREFIX,
} from "./recorder-contracts";
export type {
  RecorderStatus, RecorderTerminalStatus, RecorderCleanupTrigger,
  RecorderHeaderEntry, RecorderCaptureEntry,
  RecorderCreateRequest, RecorderCreateResponse,
  RecorderStateResponse, RecorderStopResponse,
  RecorderErrorCode, RecorderErrorCatalog, RecorderErrorResponse,
  RecorderWsInputFrame,
} from "./recorder-contracts";

export {
  DIAGNOSTIC_METRIC, DIAGNOSTIC_MAX_NODES, DIAGNOSTIC_MAX_EVENTS, DIAGNOSTIC_TIMEOUT_MS,
  runModeSchema, diagnosticNodeIdSchema, diagnosticMetadataSchema, diagnosticEventSchema,
} from "./diagnostic";
export type { RunMode, DiagnosticMetadata, DiagnosticEvent } from "./diagnostic";

// K6 translator
export {
  translateToK6, type K6TranslatorOptions, type K6TranslatorResult, type K6TranslationError,
} from './k6-translator';

// {{variable}} templates (k6flow-variables)
export {
  VARIABLE_NAME_PATTERN, SECRET_ENV_PREFIX, isValidVariableName, parseTemplate, findVariables,
  mergeVariables, secretEnvName, findSecretEnvCollisions, toJsStringLiteral,
  renderTemplateExpression,
} from './variables';
export type {
  TemplateSegment, VariableDefinition, VariableInput, ResolvedVariables,
  SecretEnvCollision, RenderedTemplate,
} from './variables';

// Capture-to-graph translator (K6F8)
export {
  captureToNode, capturesToGraph, generateConnections,
  type CaptureGraphNode, type CaptureToGraphOptions,
} from './capture-to-graph';
export {
  detectAuth, suggestAuthPosition,
  type AuthSignal, type AuthDetectionResult,
} from './capture-auth-detection';
export {
  detectDynamicValues, findValueCorrelations,
  type DynamicValue, type DynamicDetectionResult,
} from './capture-dynamic-detection';

export {
  parseNDJSONCapture,
  extractMetadata,
  extractNetworkEntries,
  extractUIEvents,
  extractSteps,
  normalizeNetworkEntry,
  normalizeNetworkEntries,
  classifyNetworkEntry,
  groupBySteps,
  calculateThinkTimes,
  type NDJSONCaptureEvent,
  type NDJSONNetworkEntry,
  type NDJSONUIEvent,
  type NDJSONStep,
  type NDJSONMetadata,
  type NormalizedCaptureEntry,
  type StepGroup,
} from './capture-adapter';

// Visual recorder streaming (K6F10)
export {
  FRAME_TYPE, FRAME_HEADER_SIZE,
  encodeFrameHeader, decodeFrameHeader,
  streamingStateMessageSchema, streamingNavMessageSchema,
  streamingTabsMessageSchema, streamingCursorMessageSchema,
  streamingDialogMessageSchema, streamingFileChooserMessageSchema,
  streamingStatsMessageSchema, streamingStepMessageSchema,
  streamingErrorMessageSchema, streamingPongMessageSchema,
  streamingServerMessageSchema,
  streamingMouseMessageSchema, streamingKeyMessageSchema,
  streamingTextMessageSchema, streamingNavActionMessageSchema,
  streamingTabActionMessageSchema, streamingDialogReplyMessageSchema,
  streamingFileUploadMessageSchema, streamingResizeMessageSchema,
  streamingMarkMessageSchema, streamingPauseMessageSchema,
  streamingResumeMessageSchema, streamingStopMessageSchema,
  streamingPingMessageSchema, streamingClientMessageSchema,
} from './recorder-streaming';
export type {
  FrameHeader, StreamingState,
  StreamingServerMessage, StreamingClientMessage,
  StreamingMouseMessage, StreamingKeyMessage,
} from './recorder-streaming';

// HAR import
export { importHar, validateHar } from './har-import';
export type {
  Har, HarEntry, HarLog, HarImportOptions, HarImportResult,
  HarImportedGraph, HarImportedNode,
} from './har-import';

// Network isolation (SSRF protection)
export { validateUrl, isAllowedDomain, createUrlValidator } from './network-isolation';
export type { NetworkIsolationResult, NetworkIsolationConfig } from './network-isolation';

// Data redaction (sensitive data masking)
export { redactString, redactHeaders, redactHeadersKV, redactJsonBody, redactUrl, redactCapture } from './data-redaction';
export type { RedactionConfig, HttpCapture } from './data-redaction';
