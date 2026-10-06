"use client";

// K6F4-05c: HTTP Request node configuration panel.
// Supports headers with variable references and cURL import.

import { useState } from "react";
import { ConfigPanel, FormField, TextInput, SelectInput, TextArea } from "./ConfigPanel";

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

// Parse cURL command into request parameters
function parseCurl(curl: string): Partial<HttpRequestParams> | null {
  try {
    // Normalize: remove line continuations and extra whitespace
    const normalized = curl
      .replace(/\\\n/g, " ")
      .replace(/\\\r\n/g, " ")
      .trim();

    // Must start with curl
    if (!normalized.toLowerCase().startsWith("curl")) {
      return null;
    }

    const result: Partial<HttpRequestParams> = {
      method: "GET",
      headers: [],
    };

    // Extract URL (usually the last argument or after curl command)
    const urlMatch = normalized.match(/['"]?(https?:\/\/[^\s'"]+)['"]?/);
    if (urlMatch) {
      result.url = { kind: "literal", value: urlMatch[1] };
    }

    // Extract method: -X or --request
    const methodMatch = normalized.match(/-X\s+(['"]?)(\w+)\1|--request\s+(['"]?)(\w+)\3/i);
    if (methodMatch) {
      result.method = (methodMatch[2] || methodMatch[4]).toUpperCase();
    }

    // Extract headers: -H or --header
    const headerRegex = /-H\s+['"]([^'"]+)['"]|--header\s+['"]([^'"]+)['"]/gi;
    let headerMatch;
    while ((headerMatch = headerRegex.exec(normalized)) !== null) {
      const headerStr = headerMatch[1] || headerMatch[2];
      const colonIdx = headerStr.indexOf(":");
      if (colonIdx > 0) {
        const name = headerStr.slice(0, colonIdx).trim();
        const value = headerStr.slice(colonIdx + 1).trim();
        // Skip Content-Type if we're setting body (will be auto-set)
        if (name.toLowerCase() !== "content-type") {
          result.headers!.push({
            name,
            value: { kind: "literal", value },
          });
        }
      }
    }

    // Extract data/body: -d or --data or --data-raw
    const dataMatch = normalized.match(/-d\s+['"]([^'"]+)['"]|--data(?:-raw)?\s+['"]([^'"]+)['"]/i);
    if (dataMatch) {
      const bodyContent = dataMatch[1] || dataMatch[2];
      // Try to detect if it's JSON
      try {
        JSON.parse(bodyContent);
        result.body = { kind: "json", value: { kind: "literal", value: bodyContent } };
        if (!result.method || result.method === "GET") {
          result.method = "POST";
        }
      } catch {
        // Not JSON, treat as form or text
        if (bodyContent.includes("=")) {
          result.body = { kind: "form", value: { kind: "literal", value: bodyContent } };
        } else {
          result.body = { kind: "text", value: { kind: "literal", value: bodyContent } };
        }
        if (!result.method || result.method === "GET") {
          result.method = "POST";
        }
      }
    }

    return result;
  } catch {
    return null;
  }
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
    if (parsed) {
      updateParams({
        method: parsed.method ?? method,
        url: parsed.url ?? parameters?.url,
        headers: [...headers, ...(parsed.headers ?? [])],
        body: parsed.body ?? parameters?.body,
      });
      setShowCurlImport(false);
      setCurlInput("");
      setCurlError(null);
    } else {
      setCurlError("Could not parse cURL command. Make sure it starts with 'curl'.");
    }
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
              onChange={setCurlInput}
              placeholder={'curl -X POST "https://api.example.com" -H "Authorization: Bearer token" -d \'{"key":"value"}\''}

              rows={3}
              mono
            />
            {curlError && <p className="text-sm text-red-500">{curlError}</p>}
            <button
              type="button"
              onClick={handleCurlImport}
              disabled={!curlInput.trim()}
              className="px-3 py-1 text-sm bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-50"
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
