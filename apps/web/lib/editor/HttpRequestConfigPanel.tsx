"use client";

// K6F4-05c: HTTP Request node configuration panel.
// Supports headers with variable references and cURL import.

import { useMemo, useState } from "react";
import { ConfigPanel, FormField, TextInput, SelectInput, TextArea } from "./ConfigPanel";
import { parseCurl } from "./curl-import";
import { VariableInput } from "../variables/VariableInput";
import { EndpointTestResultView } from "./EndpointTestInspector";
import type { EndpointTestClientResult } from "./endpoint-test-client";
import { parameterReferences } from "./node-interactions";

const HTTP_METHODS = [
  { value: "GET", label: "GET" },
  { value: "POST", label: "POST" },
  { value: "PUT", label: "PUT" },
  { value: "PATCH", label: "PATCH" },
  { value: "DELETE", label: "DELETE" },
  { value: "HEAD", label: "HEAD" },
  { value: "OPTIONS", label: "OPTIONS" },
];

// Available output from upstream nodes (Authentication, User Pool)
export interface AvailableOutput {
  nodeId: string;
  nodeLabel: string;
  outputName: string;
}

interface HeaderValue {
  kind: "literal" | "reference";
  value?: string;
  reference?: { producerNodeId: string; output: string };
}

interface HeaderEntry {
  name: string;
  value: HeaderValue;
}

interface HttpRequestParams {
  method: string;
  url: { kind: "literal"; value: string } | { kind: "reference"; reference: unknown };
  headers?: HeaderEntry[];
  body?: 
    | { kind: "none" } 
    | { kind: "text"; value: { kind: "literal"; value: string } } 
    | { kind: "json"; value: { kind: "literal"; value: string } }
    | { kind: "xml"; value: { kind: "literal"; value: string } }
    | { kind: "form"; value: { kind: "literal"; value: string } };
}

const NO_VARIABLES: readonly string[] = [];

/** One producer reference of this request, keyed exactly as the samples map the server expects. */
export interface EndpointTestReference {
  readonly key: string;
  readonly label: string;
}

/**
 * Schema-slot references only (url, headers, body): literal values are never treated as
 * references, and a reference used in two slots appears once because the samples map is keyed.
 */
export function collectReferences(parameters: HttpRequestParams | undefined): EndpointTestReference[] {
  return parameterReferences("http-request", parameters).map((reference) => ({
    key: `${reference.producerNodeId}:${reference.output}`,
    label: `${reference.producerNodeId}.${reference.output}`,
  }));
}

/** Only the values typed for a current reference are sent; a stale map entry is dropped. */
export function collectSampleValues(
  references: readonly EndpointTestReference[],
  values: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const samples: Record<string, string> = {};
  for (const reference of references) {
    const value = values[reference.key];
    if (value !== undefined) samples[reference.key] = value;
  }
  return samples;
}

/**
 * The exact action of the run button: it refuses while a test is in flight and hands the
 * run callback only the values typed for the current references. Kept pure so the disabled
 * and payload rules are testable without a DOM harness.
 */
export function runEndpointTestWithSamples(
  references: readonly EndpointTestReference[],
  values: Readonly<Record<string, string>>,
  running: boolean,
  onRun: ((samples: Readonly<Record<string, string>>) => void) | undefined,
): void {
  if (!onRun || running) return;
  onRun(collectSampleValues(references, values));
}

interface HttpRequestConfigPanelProps {
  parameters?: HttpRequestParams;
  availableOutputs?: AvailableOutput[];
  /** `{{name}}` variables defined in the merged set (selected environment + scenario). */
  variableNames?: readonly string[];
  onChange: (params: HttpRequestParams) => void;
  onClose: () => void;
  /**
   * Present only in the editor: runs one diagnostic endpoint test with the user-typed
   * sample values. When absent the panel renders exactly as it did before.
   */
  onRunEndpointTest?: (samples: Readonly<Record<string, string>>) => void;
  /** Disables the run button and the sample inputs while a test is in flight. */
  endpointTestRunning?: boolean;
  /** Memory-only last result for this node. */
  endpointTestResult?: EndpointTestClientResult;
  /** Dismisses the last result; the dismiss action only appears when it is provided. */
  onDismissEndpointTestResult?: () => void;
}

export function HttpRequestConfigPanel({
  parameters,
  availableOutputs = [],
  variableNames = NO_VARIABLES,
  onChange,
  onClose,
  onRunEndpointTest,
  endpointTestRunning = false,
  endpointTestResult,
  onDismissEndpointTestResult,
}: HttpRequestConfigPanelProps) {
  const [showCurlImport, setShowCurlImport] = useState(false);
  // Samples are typed by the user, memory-only and never written to the scenario.
  const [sampleValues, setSampleValues] = useState<Record<string, string>>({});
  const endpointReferences = useMemo(() => collectReferences(parameters), [parameters]);
  const [curlInput, setCurlInput] = useState("");
  const [curlError, setCurlError] = useState<string | null>(null);
  const [curlSuccess, setCurlSuccess] = useState<{ message: string; warnings: string[] } | null>(null);

  const method = parameters?.method ?? "GET";
  const url = parameters?.url?.kind === "literal" ? parameters.url.value : "";
  const headers = parameters?.headers ?? [];
  const bodyKind = parameters?.body?.kind ?? "none";
  const bodyText =
    parameters?.body && 
    parameters.body.kind !== "none" && 
    "value" in parameters.body && 
    parameters.body.value.kind === "literal"
      ? parameters.body.value.value
      : "";

  const updateParams = (updates: Partial<HttpRequestParams>) => {
    onChange({
      method: parameters?.method ?? "GET",
      url: parameters?.url ?? { kind: "literal", value: "" },
      headers: parameters?.headers,
      body: parameters?.body,
      ...updates,
    } as HttpRequestParams);
  };

  const updateMethod = (newMethod: string) => {
    updateParams({ method: newMethod });
  };

  const updateUrl = (newUrl: string) => {
    updateParams({ url: { kind: "literal", value: newUrl } });
  };

  const updateBodyKind = (newKind: string) => {
    if (newKind === "none") {
      updateParams({ body: { kind: "none" } });
    } else {
      updateParams({
        body: { kind: newKind as "text" | "json" | "xml" | "form", value: { kind: "literal", value: bodyText } },
      });
    }
  };

  const updateBodyText = (newText: string) => {
    const currentKind = parameters?.body?.kind ?? "text";
    updateParams({
      body: { kind: currentKind === "none" ? "text" : currentKind, value: { kind: "literal", value: newText } } as HttpRequestParams["body"],
    });
  };

  // Header management
  const addHeader = () => {
    updateParams({
      headers: [...headers, { name: "", value: { kind: "literal", value: "" } }],
    });
  };

  const removeHeader = (index: number) => {
    updateParams({
      headers: headers.filter((_, i) => i !== index),
    });
  };

  const updateHeaderName = (index: number, name: string) => {
    const newHeaders = [...headers];
    newHeaders[index] = { ...newHeaders[index], name };
    updateParams({ headers: newHeaders });
  };

  const updateHeaderValueKind = (index: number, kind: "literal" | "reference") => {
    const newHeaders = [...headers];
    if (kind === "literal") {
      newHeaders[index] = {
        ...newHeaders[index],
        value: { kind: "literal", value: "" },
      };
    } else {
      // Default to first available output if any
      const firstOutput = availableOutputs[0];
      newHeaders[index] = {
        ...newHeaders[index],
        value: firstOutput
          ? { kind: "reference", reference: { producerNodeId: firstOutput.nodeId, output: firstOutput.outputName } }
          : { kind: "literal", value: "" },
      };
    }
    updateParams({ headers: newHeaders });
  };

  const updateHeaderLiteralValue = (index: number, value: string) => {
    const newHeaders = [...headers];
    newHeaders[index] = {
      ...newHeaders[index],
      value: { kind: "literal", value },
    };
    updateParams({ headers: newHeaders });
  };

  const updateHeaderReference = (index: number, refKey: string) => {
    const [nodeId, outputName] = refKey.split("::");
    const newHeaders = [...headers];
    newHeaders[index] = {
      ...newHeaders[index],
      value: { kind: "reference", reference: { producerNodeId: nodeId, output: outputName } },
    };
    updateParams({ headers: newHeaders });
  };

  // cURL import
  const handleCurlImport = () => {
    const parsed = parseCurl(curlInput);
    if (!parsed.ok) {
      setCurlError(parsed.error);
      setCurlSuccess(null);
      return;
    }
    // An import replaces the request: headers and body are not merged.
    updateParams({
      method: parsed.method,
      url: { kind: "literal", value: parsed.url },
      headers: parsed.headers.map((h) => ({
        name: h.name,
        value: { kind: "literal", value: h.value },
      })),
      body: parsed.body
        ? ({ kind: parsed.body.kind, value: { kind: "literal", value: parsed.body.value } } as HttpRequestParams["body"])
        : { kind: "none" },
    });
    const headerCount = parsed.headers.length;
    setCurlError(null);
    setCurlSuccess({
      message: `Imported ${parsed.method} ${parsed.url} · ${headerCount} header${headerCount === 1 ? "" : "s"}`,
      warnings: parsed.warnings,
    });
  };

  const handleCurlInputChange = (value: string) => {
    setCurlInput(value);
    setCurlError(null);
    setCurlSuccess(null);
  };

  // Validate JSON when body type is json
  const jsonError = bodyKind === "json" && bodyText ? (() => {
    try {
      JSON.parse(bodyText);
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  })() : null;

  const handleRunEndpointTest = () => {
    runEndpointTestWithSamples(endpointReferences, sampleValues, endpointTestRunning, onRunEndpointTest);
  };

  // Get reference key for a header
  const getHeaderRefKey = (header: HeaderEntry): string => {
    if (header.value.kind === "reference" && header.value.reference) {
      return `${header.value.reference.producerNodeId}::${header.value.reference.output}`;
    }
    return "";
  };

  return (
    <ConfigPanel kind="http-request" title="HTTP Request" onClose={onClose}>
      {/* cURL Import Section */}
      <div className="mb-4">
        <button
          type="button"
          onClick={() => setShowCurlImport(!showCurlImport)}
          className="text-sm text-primary hover:underline flex items-center gap-1"
        >
          <span>{showCurlImport ? "▼" : "▶"}</span>
          Import from cURL
        </button>
        {showCurlImport && (
          <div className="mt-2 space-y-2">
            <TextArea
              value={curlInput}
              onChange={handleCurlInputChange}
              placeholder={'curl -X POST "https://api.example.com" -H "Authorization: Bearer token" -d \'{"key":"value"}\''}

              rows={3}
              mono
            />
            {curlError && <p className="text-sm text-error">{curlError}</p>}
            {curlSuccess && (
              <div className="text-sm space-y-1">
                <p className="text-secondary break-all">✓ {curlSuccess.message}</p>
                {curlSuccess.warnings.map((w, i) => (
                  <p key={i} className="text-on-surface-variant">⚠ {w}</p>
                ))}
              </div>
            )}
            <button
              type="button"
              onClick={handleCurlImport}
              disabled={!curlInput.trim()}
              className="px-3 py-1.5 text-sm font-semibold rounded-lg bg-primary-container text-on-primary-container hover:bg-tertiary-container transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Import
            </button>
          </div>
        )}
      </div>

      <FormField label="Method">
        <SelectInput value={method} onChange={updateMethod} options={HTTP_METHODS} />
      </FormField>

      <FormField label="URL" hint="The endpoint to request. Type {{ to insert a variable.">
        <VariableInput
          value={url}
          onChange={updateUrl}
          variableNames={variableNames}
          placeholder="https://api.example.com/endpoint"
        />
      </FormField>

      {/* Headers Section */}
      <FormField label="Headers" hint="Add custom headers. Use variables from Authentication/User Pool.">
        <div className="space-y-2">
          {headers.map((header, index) => (
            <div key={index} className="flex gap-2 items-start">
              <div className="flex-1">
                <TextInput
                  value={header.name}
                  onChange={(v) => updateHeaderName(index, v)}
                  placeholder="Header name"
                />
              </div>
              <span className="text-muted-foreground self-center">:</span>
              <div className="flex-1 space-y-1">
                <SelectInput
                  value={header.value.kind}
                  onChange={(v) => updateHeaderValueKind(index, v as "literal" | "reference")}
                  options={[
                    { value: "literal", label: "Text" },
                    { value: "reference", label: "Variable" },
                  ]}
                />
                {header.value.kind === "literal" ? (
                  <VariableInput
                    value={header.value.value ?? ""}
                    onChange={(v) => updateHeaderLiteralValue(index, v)}
                    variableNames={variableNames}
                    placeholder="Header value"
                  />
                ) : (
                  <SelectInput
                    value={getHeaderRefKey(header)}
                    onChange={(v) => updateHeaderReference(index, v)}
                    options={
                      availableOutputs.length > 0
                        ? availableOutputs.map((o) => ({
                            value: `${o.nodeId}::${o.outputName}`,
                            label: `${o.nodeLabel}.${o.outputName}`,
                          }))
                        : [{ value: "", label: "No variables available" }]
                    }
                  />
                )}
              </div>
              <button
                type="button"
                onClick={() => removeHeader(index)}
                className="p-1 text-muted-foreground hover:text-destructive"
                title="Remove header"
              >
                ✕
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={addHeader}
            className="text-sm text-primary hover:underline"
          >
            + Add Header
          </button>
        </div>
      </FormField>

      <FormField label="Body">
        <SelectInput
          value={bodyKind}
          onChange={updateBodyKind}
          options={[
            { value: "none", label: "None" },
            { value: "json", label: "JSON" },
            { value: "xml", label: "XML" },
            { value: "text", label: "Raw Text" },
            { value: "form", label: "Form URL-Encoded" },
          ]}
        />
      </FormField>

      {bodyKind !== "none" && (
        <FormField 
          label="Body Content" 
          hint={jsonError ? `❌ ${jsonError}` : bodyKind === "json" ? "JSON object" : bodyKind === "xml" ? "XML document" : bodyKind === "form" ? "key=value&key2=value2" : "Raw text"}
          error={!!jsonError}
        >
          <VariableInput
            value={bodyText}
            onChange={updateBodyText}
            variableNames={variableNames}
            placeholder={bodyKind === "json" ? '{"key": "value"}' : bodyKind === "xml" ? '<root>...</root>' : bodyKind === "form" ? 'username=test&password=123' : "Request body..."}
            multiline
            rows={6}
            mono
            preview="chips"
          />
        </FormField>
      )}

      {onRunEndpointTest !== undefined && (
        <div className="mt-4 space-y-2 border-t border-outline-variant pt-4">
          <p className="text-sm font-semibold text-on-surface">Prueba de endpoint</p>
          <p className="text-xs text-on-surface-variant">
            Los valores de muestra se usan solo para esta prueba y no se guardan con el escenario.
          </p>
          {endpointReferences.length > 0 && (
            <div className="space-y-2">
              {endpointReferences.map((reference) => (
                <label key={reference.key} className="block text-sm">
                  <span className="text-on-surface-variant">{reference.label}</span>
                  <TextInput
                    value={sampleValues[reference.key] ?? ""}
                    onChange={(value) =>
                      setSampleValues((current) => ({ ...current, [reference.key]: value }))}
                    placeholder="Valor de muestra"
                    disabled={endpointTestRunning}
                  />
                </label>
              ))}
            </div>
          )}
          <button
            type="button"
            onClick={handleRunEndpointTest}
            disabled={endpointTestRunning}
            className="px-3 py-1.5 text-sm font-semibold rounded-lg bg-primary-container text-on-primary-container hover:bg-tertiary-container transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Probar endpoint
          </button>
          {endpointTestResult !== undefined && (
            <div className="rounded-lg border border-outline-variant p-3">
              <EndpointTestResultView result={endpointTestResult} />
              {onDismissEndpointTestResult && (
                <button
                  type="button"
                  onClick={onDismissEndpointTestResult}
                  className="text-sm text-primary hover:underline"
                >
                  Descartar resultado
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </ConfigPanel>
  );
}
