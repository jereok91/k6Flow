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
  body?: { kind: "none" } | { kind: "text"; value: { kind: "literal"; value: string } } | { kind: "json"; value: unknown };
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
    parameters?.body?.kind === "text" && parameters.body.value.kind === "literal"
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
    } else if (newKind === "text") {
      onChange({
        ...baseParams,
        body: { kind: "text", value: { kind: "literal", value: "" } },
      } as HttpRequestParams);
    }
  };

  const updateBodyText = (newText: string) => {
    onChange({
      method: parameters?.method ?? "GET",
      url: parameters?.url ?? { kind: "literal", value: "" },
      body: { kind: "text", value: { kind: "literal", value: newText } },
    } as HttpRequestParams);
  };

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
            { value: "text", label: "Text" },
          ]}
        />
      </FormField>

      {bodyKind === "text" && (
        <FormField label="Body Content">
          <TextArea
            value={bodyText}
            onChange={updateBodyText}
            placeholder="Request body..."
            rows={4}
          />
        </FormField>
      )}
    </ConfigPanel>
  );
}
