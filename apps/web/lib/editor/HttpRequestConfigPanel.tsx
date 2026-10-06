"use client";

// K6F4-05c: HTTP Request node configuration panel.

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

interface HttpRequestParams {
  method: string;
  url: { kind: "literal"; value: string } | { kind: "reference"; reference: unknown };
  headers?: { name: string; value: { kind: "literal"; value: string } }[];
  body?: 
    | { kind: "none" } 
    | { kind: "text"; value: { kind: "literal"; value: string } } 
    | { kind: "json"; value: { kind: "literal"; value: string } }
    | { kind: "xml"; value: { kind: "literal"; value: string } }
    | { kind: "form"; value: { kind: "literal"; value: string } };
}

interface HttpRequestConfigPanelProps {
  parameters?: HttpRequestParams;
  onChange: (params: HttpRequestParams) => void;
  onClose: () => void;
}

export function HttpRequestConfigPanel({
  parameters,
  onChange,
  onClose,
}: HttpRequestConfigPanelProps) {
  const method = parameters?.method ?? "GET";
  const url = parameters?.url?.kind === "literal" ? parameters.url.value : "";
  const bodyKind = parameters?.body?.kind ?? "none";
  const bodyText =
    parameters?.body && 
    parameters.body.kind !== "none" && 
    "value" in parameters.body && 
    parameters.body.value.kind === "literal"
      ? parameters.body.value.value
      : "";

  const updateMethod = (newMethod: string) => {
    onChange({
      ...parameters,
      method: newMethod,
      url: parameters?.url ?? { kind: "literal", value: "" },
    } as HttpRequestParams);
  };

  const updateUrl = (newUrl: string) => {
    onChange({
      ...parameters,
      method: parameters?.method ?? "GET",
      url: { kind: "literal", value: newUrl },
    } as HttpRequestParams);
  };

  const updateBodyKind = (newKind: string) => {
    const baseParams = {
      method: parameters?.method ?? "GET",
      url: parameters?.url ?? { kind: "literal", value: "" },
    };
    if (newKind === "none") {
      onChange({ ...baseParams, body: { kind: "none" } } as HttpRequestParams);
    } else {
      // text, json, xml all use the same structure with different contentType
      onChange({
        ...baseParams,
        body: { kind: newKind, value: { kind: "literal", value: bodyText } },
      } as HttpRequestParams);
    }
  };

  const updateBodyText = (newText: string) => {
    const currentKind = parameters?.body?.kind ?? "text";
    onChange({
      method: parameters?.method ?? "GET",
      url: parameters?.url ?? { kind: "literal", value: "" },
      body: { kind: currentKind === "none" ? "text" : currentKind, value: { kind: "literal", value: newText } },
    } as HttpRequestParams);
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

  return (
    <ConfigPanel kind="http-request" title="HTTP Request" onClose={onClose}>
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
