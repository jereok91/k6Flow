"use client";

// K6F4-05c + K6F6-03: User Pool (CSV) node configuration panel with file upload.

import { useState, useRef, useCallback } from "react";
import { ConfigPanel, FormField, TextInput } from "./ConfigPanel";

interface CsvOutput {
  header: string;
  name: string;
  expectedType: "string";
  required: true;
}

interface ManualUser {
  username: string;
  password: string;
}

interface UserPoolParams {
  version: "1.0";
  attachment?: { id: string };
  allocation: "csv-order-distinct-row-per-vu";
  onInsufficientCapacity: "reject-before-execution";
  outputs: CsvOutput[];
  manualUsers?: ManualUser[];
  mode?: "csv" | "manual";
}

interface AttachmentInfo {
  id: string;
  name: string;
  contentType: string;
  size: number;
  createdAt: string;
}

interface UserPoolConfigPanelProps {
  parameters?: UserPoolParams;
  scenarioId?: string | number | null;
  attachments?: AttachmentInfo[];
  onChange: (params: UserPoolParams) => void;
  onClose: () => void;
  onUploadFile?: (file: File) => Promise<AttachmentInfo | null>;
  onDeleteAttachment?: (attachmentId: string) => Promise<boolean>;
}

export function UserPoolConfigPanel({
  parameters,
  scenarioId,
  attachments = [],
  onChange,
  onClose,
  onUploadFile,
  onDeleteAttachment,
}: UserPoolConfigPanelProps) {
  const [header, setHeader] = useState("");
  const [outputName, setOutputName] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const mode = parameters?.mode ?? "csv";
  const attachmentId = parameters?.attachment?.id ?? "";
  const outputs = parameters?.outputs ?? [];
  const manualUsers = parameters?.manualUsers ?? [];
  const selectedAttachment = attachments.find((a) => a.id === attachmentId);

  const updateMode = (newMode: "csv" | "manual") => {
    onChange({
      ...parameters,
      version: "1.0",
      allocation: "csv-order-distinct-row-per-vu",
      onInsufficientCapacity: "reject-before-execution",
      outputs,
      manualUsers,
      mode: newMode,
    });
  };

  const updateAttachment = (id: string) => {
    onChange({
      version: "1.0",
      attachment: { id },
      allocation: "csv-order-distinct-row-per-vu",
      onInsufficientCapacity: "reject-before-execution",
      outputs,
      manualUsers,
      mode,
    });
  };

  const addManualUser = () => {
    if (!newUsername.trim() || !newPassword.trim()) return;
    const newUser: ManualUser = {
      username: newUsername.trim(),
      password: newPassword.trim(),
    };
    onChange({
      version: "1.0",
      attachment: parameters?.attachment,
      allocation: "csv-order-distinct-row-per-vu",
      onInsufficientCapacity: "reject-before-execution",
      outputs,
      manualUsers: [...manualUsers, newUser],
      mode,
    });
    setNewUsername("");
    setNewPassword("");
  };

  const removeManualUser = (index: number) => {
    onChange({
      ...parameters!,
      manualUsers: manualUsers.filter((_, i) => i !== index),
    });
  };

  const handleFileSelect = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file || !onUploadFile) return;

      setUploading(true);
      setUploadError(null);

      try {
        const result = await onUploadFile(file);
        if (result) {
          updateAttachment(result.id);
        }
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : "Upload failed");
      } finally {
        setUploading(false);
        if (fileInputRef.current) {
          fileInputRef.current.value = "";
        }
      }
    },
    [onUploadFile], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const handleDeleteAttachment = useCallback(async () => {
    if (!selectedAttachment || !onDeleteAttachment) return;
    const success = await onDeleteAttachment(selectedAttachment.id);
    if (success) {
      updateAttachment("");
    }
  }, [selectedAttachment, onDeleteAttachment]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const canUpload = scenarioId !== null && scenarioId !== undefined && onUploadFile;

  return (
    <ConfigPanel kind="user-pool" title="User Pool" onClose={onClose}>
      {/* Mode Selector */}
      <div style={{ marginBottom: 16 }}>
        <label style={{ fontSize: 12, fontWeight: 500, color: "var(--color-text-secondary)", display: "block", marginBottom: 8 }}>
          Data Source
        </label>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={() => updateMode("csv")}
            style={{
              flex: 1,
              padding: "8px 12px",
              fontSize: 13,
              fontWeight: 500,
              border: "1px solid",
              borderColor: mode === "csv" ? "var(--color-primary)" : "var(--color-border)",
              borderRadius: 6,
              background: mode === "csv" ? "var(--color-primary-light, #ede9fe)" : "var(--color-surface)",
              color: mode === "csv" ? "var(--color-primary)" : "var(--color-text-secondary)",
              cursor: "pointer",
            }}
          >
            📄 CSV File
          </button>
          <button
            onClick={() => updateMode("manual")}
            style={{
              flex: 1,
              padding: "8px 12px",
              fontSize: 13,
              fontWeight: 500,
              border: "1px solid",
              borderColor: mode === "manual" ? "var(--color-primary)" : "var(--color-border)",
              borderRadius: 6,
              background: mode === "manual" ? "var(--color-primary-light, #ede9fe)" : "var(--color-surface)",
              color: mode === "manual" ? "var(--color-primary)" : "var(--color-text-secondary)",
              cursor: "pointer",
            }}
          >
            ✏️ Manual
          </button>
        </div>
      </div>

      {mode === "manual" && (
        <>
          {/* Manual Users Section */}
          <div style={{ marginBottom: 16 }}>
            <label style={{ fontSize: 12, fontWeight: 500, color: "var(--color-text-secondary)", display: "block", marginBottom: 8 }}>
              Add User
            </label>
            <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
              <TextInput
                value={newUsername}
                onChange={setNewUsername}
                placeholder="Username"
              />
              <TextInput
                value={newPassword}
                onChange={setNewPassword}
                placeholder="Password"
              />
              <button
                onClick={addManualUser}
                disabled={!newUsername.trim() || !newPassword.trim()}
                style={{
                  padding: "8px 16px",
                  fontSize: 13,
                  fontWeight: 500,
                  border: "none",
                  borderRadius: 6,
                  background: "var(--color-primary)",
                  color: "white",
                  cursor: newUsername.trim() && newPassword.trim() ? "pointer" : "not-allowed",
                  opacity: newUsername.trim() && newPassword.trim() ? 1 : 0.5,
                }}
              >
                +
              </button>
            </div>
          </div>

          {/* Manual Users List */}
          {manualUsers.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 12, fontWeight: 500, color: "var(--color-text-secondary)", display: "block", marginBottom: 8 }}>
                Users ({manualUsers.length})
              </label>
              {manualUsers.map((user, i) => (
                <div key={i} style={outputItemStyle}>
                  <div style={{ flex: 1 }}>
                    <span style={{ fontSize: 13, fontWeight: 500 }}>{user.username}</span>
                    <span style={{ fontSize: 12, color: "var(--color-text-muted)", marginLeft: 8 }}>
                      •••••
                    </span>
                  </div>
                  <button onClick={() => removeManualUser(i)} style={removeButtonStyle}>
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}

          {manualUsers.length === 0 && (
            <p style={{ fontSize: 12, color: "var(--color-text-muted)", textAlign: "center", padding: "16px 0" }}>
              No users added yet. Add users above to use in the test.
            </p>
          )}
        </>
      )}

      {mode === "csv" && (
        <>
      {/* File Upload Section */}
      <FormField label="CSV File" hint="Upload a CSV file with user data">
        {canUpload ? (
          <div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv,text/plain"
              onChange={handleFileSelect}
              disabled={uploading}
              style={{ display: "none" }}
            />

            {selectedAttachment ? (
              <div style={fileSelectedStyle}>
                <div style={{ flex: 1 }}>
                  <span style={{ fontSize: "13px", fontWeight: 500 }}>
                    {selectedAttachment.name}
                  </span>
                  <span style={{ fontSize: "12px", color: "#6b7280", marginLeft: "8px" }}>
                    ({Math.round(selectedAttachment.size / 1024)} KB)
                  </span>
                </div>
                <button onClick={handleDeleteAttachment} style={removeButtonStyle} title="Remove file">
                  ✕
                </button>
              </div>
            ) : (
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                style={uploadButtonStyle}
              >
                {uploading ? "Uploading..." : "📁 Choose CSV File"}
              </button>
            )}

            {uploadError && (
              <p style={{ fontSize: "12px", color: "#dc2626", marginTop: "8px" }}>{uploadError}</p>
            )}

            {attachments.length > 0 && !selectedAttachment && (
              <div style={{ marginTop: "12px" }}>
                <p style={{ fontSize: "12px", color: "#6b7280", marginBottom: "8px" }}>
                  Or select existing file:
                </p>
                <select
                  value={attachmentId}
                  onChange={(e) => updateAttachment(e.target.value)}
                  style={selectStyle}
                >
                  <option value="">-- Select --</option>
                  {attachments.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        ) : (
          <div>
            <p style={{ fontSize: "12px", color: "#6b7280", marginBottom: "8px" }}>
              Save the scenario first to upload CSV files.
            </p>
            <TextInput
              value={attachmentId}
              onChange={updateAttachment}
              placeholder="attachment-id"
            />
          </div>
        )}
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
        </>
      )}
    </ConfigPanel>
  );
}

const uploadButtonStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px",
  fontSize: "13px",
  fontWeight: 500,
  color: "#374151",
  background: "#f9fafb",
  border: "1px dashed #d1d5db",
  borderRadius: "6px",
  cursor: "pointer",
};

const fileSelectedStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  padding: "10px 12px",
  background: "#ecfdf5",
  border: "1px solid #a7f3d0",
  borderRadius: "6px",
};

const selectStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  fontSize: "13px",
  border: "1px solid #d1d5db",
  borderRadius: "4px",
  background: "#fff",
};

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
  fontSize: "14px",
  padding: "4px",
};
