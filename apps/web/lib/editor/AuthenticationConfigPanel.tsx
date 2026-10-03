"use client";

// K6F4-05c: Authentication node configuration panel.
// Simplified UI for the authentication request and output extraction.

import { ConfigPanel, FormField, TextInput, SelectInput, TextArea } from "./ConfigPanel";

const HTTP_METHODS = [
  { value: "GET", label: "GET" },
  { value: "POST", label: "POST" },
  { value: "PUT", label: "PUT" },
];

interface AuthOutput {
  name: string;
  selector: { kind: "json-path"; path: string[] } | { kind: "header"; name: string };
  expectedType: "string" | "json";
  required: true;
}

interface AuthParams {
  method: { kind: "http"; request: { method: string; url: { kind: "literal"; value: string }; body?: unknown } };
  outputs: AuthOutput[];
  onOutputFailure: "stop-current-vu-iteration";
}

interface AuthenticationConfigPanelProps {
  parameters?: AuthParams;
  onChange: (params: AuthParams) => void;
  onClose: () => void;
}

export function AuthenticationConfigPanel({
  parameters,
  onChange,
  onClose,
}: AuthenticationConfigPanelProps) {
  const method = parameters?.method?.request?.method ?? "POST";
  const url =
    parameters?.method?.request?.url?.kind === "literal"
      ? parameters.method.request.url.value
      : "";
  const outputName = parameters?.outputs?.[0]?.name ?? "token";
  const outputPath =
    parameters?.outputs?.[0]?.selector?.kind === "json-path"
      ? parameters.outputs[0].selector.path.join(".")
      : "";

  const update = (updates: Partial<{ method: string; url: string; outputName: string; outputPath: string }>) => {
    const newMethod = updates.method ?? method;
    const newUrl = updates.url ?? url;
    const newOutputName = updates.outputName ?? outputName;
    const newOutputPath = updates.outputPath ?? outputPath;

    onChange({
      method: {
        kind: "http",
        request: {
          method: newMethod,
          url: { kind: "literal", value: newUrl },
        },
      },
      outputs: [
        {
          name: newOutputName,
          selector: { kind: "json-path", path: newOutputPath.split(".").filter(Boolean) },
          expectedType: "string",
          required: true,
        },
      ],
      onOutputFailure: "stop-current-vu-iteration",
    });
  };

  return (
    <ConfigPanel kind="authentication" title="Authentication" onClose={onClose}>
      <FormField label="Method">
        <SelectInput
          value={method}
          onChange={(v) => update({ method: v })}
          options={HTTP_METHODS}
        />
      </FormField>

      <FormField label="Login URL" hint="Authentication endpoint">
        <TextInput
          value={url}
          onChange={(v) => update({ url: v })}
          placeholder="https://api.example.com/auth/login"
        />
      </FormField>

      <FormField label="Output Name" hint="Name for the extracted token">
        <TextInput
          value={outputName}
          onChange={(v) => update({ outputName: v })}
          placeholder="token"
        />
      </FormField>

      <FormField label="JSON Path" hint="Path to token in response (e.g., data.accessToken)">
        <TextInput
          value={outputPath}
          onChange={(v) => update({ outputPath: v })}
          placeholder="data.accessToken"
        />
      </FormField>
    </ConfigPanel>
  );
}
