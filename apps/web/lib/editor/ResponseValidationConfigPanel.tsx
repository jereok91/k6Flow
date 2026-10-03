"use client";

// K6F4-05c: Response Validation node configuration panel.
// Simplified UI for adding status and body checks.

import { useState } from "react";
import { ConfigPanel, FormField, TextInput, SelectInput } from "./ConfigPanel";

const CHECK_TYPES = [
  { value: "status", label: "Status Code" },
  { value: "body-text", label: "Body Contains" },
];

const OPERATORS = [
  { value: "eq", label: "equals" },
  { value: "ne", label: "not equals" },
  { value: "lt", label: "less than" },
  { value: "gt", label: "greater than" },
];

interface ResponseCheck {
  kind: string;
  name: string;
  operator?: string;
  expected?: number | string;
  predicate?: { operator: string; expected?: string };
}

interface ValidationParams {
  version: "1.0";
  response: { node: string; output: string };
  checks: ResponseCheck[];
  onCheckFailure: "record-failure-and-continue";
}

interface ResponseValidationConfigPanelProps {
  parameters?: ValidationParams;
  availableNodes?: { id: string; label: string }[];
  onChange: (params: ValidationParams) => void;
  onClose: () => void;
}

export function ResponseValidationConfigPanel({
  parameters,
  availableNodes = [],
  onChange,
  onClose,
}: ResponseValidationConfigPanelProps) {
  const [checkType, setCheckType] = useState("status");
  const [checkName, setCheckName] = useState("status-ok");
  const [operator, setOperator] = useState("eq");
  const [expected, setExpected] = useState("200");

  const responseNode = parameters?.response?.node ?? "";
  const checks = parameters?.checks ?? [];

  const updateResponseNode = (nodeId: string) => {
    onChange({
      version: "1.0",
      response: { node: nodeId, output: "response" },
      checks,
      onCheckFailure: "record-failure-and-continue",
    });
  };

  const addCheck = () => {
    if (!checkName.trim()) return;

    const newCheck: ResponseCheck =
      checkType === "status"
        ? { kind: "status", name: checkName, operator, expected: parseInt(expected, 10) }
        : { kind: "body-text", name: checkName, predicate: { operator: "contains-literal", expected } };

    onChange({
      version: "1.0",
      response: parameters?.response ?? { node: "", output: "response" },
      checks: [...checks, newCheck],
      onCheckFailure: "record-failure-and-continue",
    });

    setCheckName(`check-${checks.length + 2}`);
    setExpected(checkType === "status" ? "200" : "");
  };

  const removeCheck = (index: number) => {
    onChange({
      ...parameters!,
      checks: checks.filter((_, i) => i !== index),
    });
  };

  return (
    <ConfigPanel kind="response-validation" title="Response Validation" onClose={onClose}>
      <FormField label="Response Source" hint="Select the HTTP request node to validate">
        <SelectInput
          value={responseNode}
          onChange={updateResponseNode}
          options={[
            { value: "", label: "Select a node..." },
            ...availableNodes.map((n) => ({ value: n.id, label: n.label })),
          ]}
        />
      </FormField>

      <hr style={{ margin: "16px 0", border: "none", borderTop: "1px solid #e5e7eb" }} />

      <FormField label="Check Type">
        <SelectInput value={checkType} onChange={setCheckType} options={CHECK_TYPES} />
      </FormField>

      <FormField label="Check Name">
        <TextInput value={checkName} onChange={setCheckName} placeholder="status-ok" />
      </FormField>

      {checkType === "status" && (
        <>
          <FormField label="Operator">
            <SelectInput value={operator} onChange={setOperator} options={OPERATORS} />
          </FormField>
          <FormField label="Expected Status">
            <TextInput value={expected} onChange={setExpected} placeholder="200" />
          </FormField>
        </>
      )}

      {checkType === "body-text" && (
        <FormField label="Contains Text">
          <TextInput value={expected} onChange={setExpected} placeholder="success" />
        </FormField>
      )}

      <button onClick={addCheck} style={addButtonStyle}>
        + Add Check
      </button>

      {checks.length > 0 && (
        <div style={{ marginTop: "16px" }}>
          <p style={{ fontSize: "12px", fontWeight: 500, color: "#374151", marginBottom: "8px" }}>
            Checks ({checks.length})
          </p>
          {checks.map((check, i) => (
            <div key={i} style={checkItemStyle}>
              <span style={{ flex: 1, fontSize: "13px" }}>{check.name}</span>
              <button onClick={() => removeCheck(i)} style={removeButtonStyle}>
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </ConfigPanel>
  );
}

const addButtonStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px",
  fontSize: "13px",
  fontWeight: 500,
  color: "#f59e0b",
  background: "#fef3c7",
  border: "1px solid #fcd34d",
  borderRadius: "4px",
  cursor: "pointer",
};

const checkItemStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  padding: "8px 10px",
  background: "#f9fafb",
  borderRadius: "4px",
  marginBottom: "4px",
};

const removeButtonStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "#9ca3af",
  cursor: "pointer",
  padding: "4px",
};
