"use client";

// K6F4-05c: User Pool (CSV) node configuration panel.
// Simplified UI for CSV column mapping.

import { useState } from "react";
import { ConfigPanel, FormField, TextInput } from "./ConfigPanel";

interface CsvOutput {
  header: string;
  name: string;
  expectedType: "string";
  required: true;
}

interface UserPoolParams {
  version: "1.0";
  attachment: { id: string };
  allocation: "csv-order-distinct-row-per-vu";
  onInsufficientCapacity: "reject-before-execution";
  outputs: CsvOutput[];
}

interface UserPoolConfigPanelProps {
  parameters?: UserPoolParams;
  onChange: (params: UserPoolParams) => void;
  onClose: () => void;
}

export function UserPoolConfigPanel({
  parameters,
  onChange,
  onClose,
}: UserPoolConfigPanelProps) {
  const [header, setHeader] = useState("");
  const [outputName, setOutputName] = useState("");

  const attachmentId = parameters?.attachment?.id ?? "";
  const outputs = parameters?.outputs ?? [];

  const updateAttachment = (id: string) => {
    onChange({
      version: "1.0",
      attachment: { id },
      allocation: "csv-order-distinct-row-per-vu",
      onInsufficientCapacity: "reject-before-execution",
      outputs,
    });
  };

  const addOutput = () => {
    if (!header.trim() || !outputName.trim()) return;

    const newOutput: CsvOutput = {
      header: header.trim(),
      name: outputName.trim(),
      expectedType: "string",
      required: true,
    };

    onChange({
      version: "1.0",
      attachment: { id: attachmentId },
      allocation: "csv-order-distinct-row-per-vu",
      onInsufficientCapacity: "reject-before-execution",
      outputs: [...outputs, newOutput],
    });

    setHeader("");
    setOutputName("");
  };

  const removeOutput = (index: number) => {
    onChange({
      ...parameters!,
      outputs: outputs.filter((_, i) => i !== index),
    });
  };

  return (
    <ConfigPanel kind="user-pool" title="User Pool" onClose={onClose}>
      <FormField label="CSV File ID" hint="Reference to the uploaded CSV file">
        <TextInput
          value={attachmentId}
          onChange={updateAttachment}
          placeholder="users-csv"
        />
      </FormField>

      <hr style={{ margin: "16px 0", border: "none", borderTop: "1px solid #e5e7eb" }} />

      <p style={{ fontSize: "12px", fontWeight: 500, color: "#374151", marginBottom: "12px" }}>
        Column Mappings
      </p>

      <FormField label="CSV Header" hint="Column name in the CSV file">
        <TextInput value={header} onChange={setHeader} placeholder="username" />
      </FormField>

      <FormField label="Output Name" hint="Variable name to use in the scenario">
        <TextInput value={outputName} onChange={setOutputName} placeholder="user" />
      </FormField>

      <button onClick={addOutput} style={addButtonStyle}>
        + Add Column
      </button>

      {outputs.length > 0 && (
        <div style={{ marginTop: "16px" }}>
          <p style={{ fontSize: "12px", fontWeight: 500, color: "#374151", marginBottom: "8px" }}>
            Mapped Columns ({outputs.length})
          </p>
          {outputs.map((output, i) => (
            <div key={i} style={outputItemStyle}>
              <div style={{ flex: 1 }}>
                <span style={{ fontSize: "13px", fontWeight: 500 }}>{output.name}</span>
                <span style={{ fontSize: "12px", color: "#6b7280", marginLeft: "8px" }}>
                  ← {output.header}
                </span>
              </div>
              <button onClick={() => removeOutput(i)} style={removeButtonStyle}>
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
  color: "#8b5cf6",
  background: "#ede9fe",
  border: "1px solid #c4b5fd",
  borderRadius: "4px",
  cursor: "pointer",
};

const outputItemStyle: React.CSSProperties = {
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
