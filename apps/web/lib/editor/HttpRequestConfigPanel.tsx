"use client";

// K6F4-05c: HTTP Request node configuration panel.
// Supports headers with variable references and cURL import.

import { useState } from "react";
import { ConfigPanel, FormField, TextInput, SelectInput, TextArea } from "./ConfigPanel";
import { parseCurl } from "./curl-import";

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

interface HttpRequestConfigPanelProps {
  parameters?: HttpRequestParams;
  availableOutputs?: AvailableOutput[];
  onChange: (params: HttpRequestParams) => void;
  onClose: () => void;
}

export function HttpRequestConfigPanel({
  parameters,
  availableOutputs = [],
  onChange,
  onClose,
}: HttpRequestConfigPanelProps) {
  const [showCurlImport, setShowCurlImport] = useState(false);
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

      <FormField label="URL" hint="The endpoint to request">
        <TextInput
          value={url}
          onChange={updateUrl}
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
                  <TextInput
                    value={header.value.value ?? ""}
                    onChange={(v) => updateHeaderLiteralValue(index, v)}
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
          <TextArea
            value={bodyText}
            onChange={updateBodyText}
            placeholder={bodyKind === "json" ? '{"key": "value"}' : bodyKind === "xml" ? '<root>...</root>' : bodyKind === "form" ? 'username=test&password=123' : "Request body..."}
            rows={6}
            mono
          />
        </FormField>
      )}
    </ConfigPanel>
  );
}
