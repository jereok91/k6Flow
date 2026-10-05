"use client";

// K6F4-05c: Authentication node configuration panel.
// Simplified UI for the authentication request and output extraction.

import { useMemo } from "react";
import { ConfigPanel, FormField, TextInput, SelectInput } from "./ConfigPanel";

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

interface BodyField {
  key: string;
  variable: string;
}

interface AuthParams {
  method: { kind: "http"; request: { method: string; url: { kind: "literal"; value: string }; body?: unknown } };
  outputs: AuthOutput[];
  onOutputFailure: "stop-current-vu-iteration";
  bodyTemplate?: BodyField[];
}

interface AuthenticationConfigPanelProps {
  parameters?: AuthParams;
  onChange: (params: AuthParams) => void;
  onClose: () => void;
}

// Default body template for authentication
const DEFAULT_BODY_TEMPLATE: BodyField[] = [
  { key: "username", variable: "user" },
  { key: "password", variable: "password" },
];

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
  const bodyTemplate = parameters?.bodyTemplate ?? DEFAULT_BODY_TEMPLATE;

  // Generate preview JSON
  const bodyPreview = useMemo(() => {
    const obj: Record<string, string> = {};
    for (const field of bodyTemplate) {
      obj[field.key] = `{{${field.variable}}}`;
    }
    return JSON.stringify(obj, null, 2);
  }, [bodyTemplate]);

  const update = (updates: Partial<{ 
    method: string; 
    url: string; 
    outputName: string; 
    outputPath: string;
    bodyTemplate: BodyField[];
  }>) => {
    const newMethod = updates.method ?? method;
    const newUrl = updates.url ?? url;
    const newOutputName = updates.outputName ?? outputName;
    const newOutputPath = updates.outputPath ?? outputPath;
    const newBodyTemplate = updates.bodyTemplate ?? bodyTemplate;

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
      bodyTemplate: newBodyTemplate,
    });
  };

  const updateBodyField = (index: number, field: Partial<BodyField>) => {
    const newTemplate = [...bodyTemplate];
    newTemplate[index] = { ...newTemplate[index], ...field };
    update({ bodyTemplate: newTemplate });
  };

  const addBodyField = () => {
    update({ bodyTemplate: [...bodyTemplate, { key: "", variable: "" }] });
  };

  const removeBodyField = (index: number) => {
    update({ bodyTemplate: bodyTemplate.filter((_, i) => i !== index) });
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

      {/* Body Template Section */}
      <div style={{ marginTop: 16, marginBottom: 8 }}>
        <label style={{ fontSize: 12, fontWeight: 500, color: "var(--color-text-secondary)" }}>
          Request Body Fields
        </label>
        <p style={{ fontSize: 11, color: "var(--color-text-muted)", margin: "4px 0 8px" }}>
          Define the JSON fields sent in the login request. Variables come from User Pool.
        </p>
      </div>

      {bodyTemplate.map((field, index) => (
        <div key={index} style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}>
          <TextInput
            value={field.key}
            onChange={(v) => updateBodyField(index, { key: v })}
            placeholder="JSON key (e.g., username)"
          />
          <span style={{ color: "var(--color-text-muted)" }}>→</span>
          <TextInput
            value={field.variable}
            onChange={(v) => updateBodyField(index, { variable: v })}
            placeholder="Variable (e.g., user)"
          />
          <button
            onClick={() => removeBodyField(index)}
            style={{
              background: "transparent",
              border: "none",
              color: "var(--color-danger)",
              cursor: "pointer",
              padding: 4,
              fontSize: 16,
            }}
            title="Remove field"
          >
            ×
          </button>
        </div>
      ))}

      <button
        onClick={addBodyField}
        style={{
          background: "var(--color-surface-elevated)",
          border: "1px solid var(--color-border)",
          borderRadius: 6,
          padding: "6px 12px",
          fontSize: 12,
          color: "var(--color-primary)",
          cursor: "pointer",
          width: "100%",
          marginBottom: 12,
        }}
      >
        + Add Field
      </button>

      {/* Body Preview */}
      <div style={{ marginBottom: 16 }}>
        <label style={{ fontSize: 12, fontWeight: 500, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>
          Body Preview
        </label>
        <pre
          style={{
            background: "var(--color-surface)",
            border: "1px solid var(--color-border)",
            borderRadius: 6,
            padding: 12,
            fontSize: 11,
            fontFamily: "monospace",
            color: "var(--color-text)",
            margin: 0,
            overflow: "auto",
          }}
        >
          {bodyPreview}
        </pre>
        <p style={{ fontSize: 10, color: "var(--color-text-muted)", marginTop: 4 }}>
          Variables like {"{{user}}"} will be replaced with values from User Pool
        </p>
      </div>

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
