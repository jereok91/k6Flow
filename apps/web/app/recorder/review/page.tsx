"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import {
  parseNDJSONCapture,
  extractMetadata,
  extractNetworkEntries,
  groupBySteps,
  classifyNetworkEntry,
  calculateThinkTimes,
  type NDJSONCaptureEvent,
  type StepGroup,
  type NDJSONNetworkEntry,
} from "@k6flow/shared";

interface ReviewEntry {
  entry: NDJSONNetworkEntry["data"];
  classification: "core" | "static" | "third_party" | "analytics" | "noise";
  included: boolean;
}

interface ReviewStep {
  step: StepGroup["step"];
  entries: ReviewEntry[];
  thinkTime: number;
}

interface SavedRecordingInfo {
  id: string;
  name: string;
  startUrl: string;
  state: string;
  requestCount: number;
  stepCount: number;
  scenarioId: string | null;
}

export default function RecorderReviewPage() {
  const [captureData, setCaptureData] = useState<NDJSONCaptureEvent[] | null>(null);
  const [reviewSteps, setReviewSteps] = useState<ReviewStep[]>([]);
  const [metadata, setMetadata] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Id of the recording this review was opened for, either from ?id= or from the
  // capture metadata, so saving can link the scenario to its provenance.
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [savedRecordingName, setSavedRecordingName] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [scenarioName, setScenarioName] = useState("");

  const applyCapture = useCallback((content: string, fallbackStepName: string) => {
    const events = parseNDJSONCapture(content);
    const meta = extractMetadata(events);
    const stepGroups = groupBySteps(events);

    // A capture can end before any step is marked (blank start page, or a stop
    // right after the first navigation). Its requests are still what the user
    // recorded, so they are reviewed as one implicit step instead of vanishing.
    let groups: StepGroup[] = stepGroups;
    if (groups.length === 0) {
      const entries = extractNetworkEntries(events);
      groups = entries.length === 0
        ? []
        : [
            {
              step: {
                id: "step-capture",
                name: fallbackStepName,
                kind: "auto",
                timestamp: meta?.startedAt ?? 0,
              },
              entries,
              uiEvents: [],
            },
          ];
    }
    const thinkTimes = calculateThinkTimes(groups);

    // Convert to review format
    const steps: ReviewStep[] = groups.map((group, index) => ({
      step: group.step,
      entries: group.entries.map((entry) => ({
        entry,
        classification: classifyNetworkEntry(entry, meta?.startUrl || ""),
        // Include core by default, exclude others
        included: classifyNetworkEntry(entry, meta?.startUrl || "") === "core",
      })),
      thinkTime: thinkTimes[index] ?? 0,
    }));

    setCaptureData(events);
    setMetadata(meta);
    setReviewSteps(steps);
  }, []);

  // Load capture file
  const handleFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setLoading(true);
    setError(null);
    // The uploaded file replaces any library recording this screen was opened for:
    // keeping its id would link the saved scenario to the wrong provenance.
    setRecordingId(null);
    setSavedRecordingName(null);

    try {
      const content = await file.text();
      applyCapture(content, file.name.replace(/\.ndjson$/i, ""));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to parse capture file");
    } finally {
      setLoading(false);
    }
  }, [applyCapture]);

  /** Load the capture of the recording named in ?id=, straight from the library. */
  const loadRecording = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(`/api/recordings/${encodeURIComponent(id)}`, { cache: "no-store" });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(
          res.status === 404
            ? "Esta grabación no está guardada. Subí el archivo .ndjson a mano."
            : data?.error || `No se pudo cargar la grabación (HTTP ${res.status})`,
        );
      }
      if (typeof data?.capture !== "string" || data.capture === "") {
        throw new Error("La grabación no tiene captura guardada. Subí el archivo .ndjson a mano.");
      }

      const recording = data.recording as SavedRecordingInfo | null;
      // Provenance is recorded only once the library answered for real.
      setRecordingId(id);
      setSavedRecordingName(recording?.name ?? null);
      if (recording?.name) setScenarioName(recording.name);
      applyCapture(data.capture, recording?.name ?? "Sesión completa");
    } catch (err) {
      setRecordingId(null);
      setSavedRecordingName(null);
      setError(err instanceof Error ? err.message : "Failed to load recording");
    } finally {
      setLoading(false);
    }
  }, [applyCapture]);

  useEffect(() => {
    const requestedId = new URLSearchParams(window.location.search).get("id");
    if (requestedId === null || requestedId === "") return;
    void loadRecording(requestedId);
  }, [loadRecording]);

  // Toggle entry inclusion
  const toggleEntry = useCallback((stepIndex: number, entryIndex: number) => {
    setReviewSteps((steps) =>
      steps.map((step, si) =>
        si === stepIndex
          ? {
              ...step,
              entries: step.entries.map((entry, ei) =>
                ei === entryIndex ? { ...entry, included: !entry.included } : entry
              ),
            }
          : step
      )
    );
  }, []);

  // Toggle all entries in a step
  const toggleStepEntries = useCallback((stepIndex: number, included: boolean) => {
    setReviewSteps((steps) =>
      steps.map((step, si) =>
        si === stepIndex
          ? {
              ...step,
              entries: step.entries.map((entry) => ({ ...entry, included })),
            }
          : step
      )
    );
  }, []);

  // Count included entries
  const includedCount = useMemo(() => {
    return reviewSteps.reduce(
      (acc, step) => acc + step.entries.filter((e) => e.included).length,
      0
    );
  }, [reviewSteps]);

  const totalCount = useMemo(() => {
    return reviewSteps.reduce((acc, step) => acc + step.entries.length, 0);
  }, [reviewSteps]);

  // Generate scenario
  const handleSave = useCallback(async () => {
    if (!scenarioName.trim()) {
      alert("Please enter a scenario name");
      return;
    }

    setSaving(true);
    try {
      const includedEntries = reviewSteps.flatMap((step) =>
        step.entries.filter((e) => e.included).map((e) => ({
          entry: e.entry,
          stepId: step.step.id,
          stepName: step.step.name,
          thinkTime: step.thinkTime,
        }))
      );

      const response = await fetch("/api/recordings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: scenarioName,
          startUrl: metadata.startUrl,
          viewport: metadata.viewport,
          // Provenance is only the library entry this screen really loaded: an
          // uploaded file carries a recorder id in its metadata that no row backs.
          recordingId,
          entries: includedEntries,
        }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error || `Failed to save scenario (HTTP ${response.status})`);
      }

      const result = await response.json();
      // Redirect to editor
      window.location.href = `/editor?scenario=${result.id}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }, [reviewSteps, scenarioName, metadata, recordingId]);

  return (
    <div className="min-h-screen bg-gray-900 p-6 text-white">
      <h1 className="mb-6 text-2xl font-bold">Review Recording</h1>

      {savedRecordingName && (
        <p className="mb-4 text-sm text-gray-400">
          Recording: <span className="text-white">{savedRecordingName}</span>
          {recordingId && <span className="ml-2 font-mono text-gray-500">{recordingId}</span>}
        </p>
      )}

      {/* File upload — fallback when the capture is not in the library */}
      {!captureData && (
        <div className="rounded-lg border-2 border-dashed border-gray-700 p-8 text-center">
          <label className="cursor-pointer">
            <span className="text-gray-400">
              {loading ? "Loading..." : "Drop a capture file or click to upload"}
            </span>
            <input
              type="file"
              accept=".ndjson"
              onChange={handleFileUpload}
              className="hidden"
              disabled={loading}
            />
          </label>
        </div>
      )}

      {error && (
        <div className="mb-4 rounded bg-red-900/50 p-3 text-red-300">{error}</div>
      )}

      {/* Metadata */}
      {metadata && (
        <div className="mb-6 rounded bg-gray-800 p-4">
          <h2 className="mb-2 font-semibold">Recording Info</h2>
          <div className="grid grid-cols-2 gap-4 text-sm text-gray-400">
            <div>
              <span className="text-gray-500">URL:</span> {metadata.startUrl}
            </div>
            <div>
              <span className="text-gray-500">Viewport:</span>{" "}
              {metadata.viewport?.width}x{metadata.viewport?.height}
            </div>
            <div>
              <span className="text-gray-500">Steps:</span> {reviewSteps.length}
            </div>
            <div>
              <span className="text-gray-500">Requests:</span> {includedCount}/{totalCount}
            </div>
          </div>
        </div>
      )}

      {/* Steps */}
      {reviewSteps.length > 0 && (
        <div className="space-y-4">
          {reviewSteps.map((reviewStep, stepIndex) => (
            <div key={reviewStep.step.id} className="rounded bg-gray-800 p-4">
              <div className="mb-3 flex items-center justify-between">
                <div>
                  <h3 className="font-semibold">{reviewStep.step.name}</h3>
                  <span className="text-xs text-gray-500">
                    {reviewStep.step.kind} • {reviewStep.entries.length} requests
                    {reviewStep.thinkTime > 0 && ` • ${reviewStep.thinkTime.toFixed(1)}s think time`}
                  </span>
                </div>
                <div className="flex gap-2">
                  <button
                    className="rounded bg-green-700 px-2 py-1 text-xs hover:bg-green-600"
                    onClick={() => toggleStepEntries(stepIndex, true)}
                  >
                    Include All
                  </button>
                  <button
                    className="rounded bg-gray-700 px-2 py-1 text-xs hover:bg-gray-600"
                    onClick={() => toggleStepEntries(stepIndex, false)}
                  >
                    Exclude All
                  </button>
                </div>
              </div>

              {/* Entries */}
              <div className="space-y-1">
                {reviewStep.entries.map((reviewEntry, entryIndex) => (
                  <div
                    key={reviewEntry.entry.request.id}
                    className={`flex items-center justify-between rounded px-3 py-2 text-sm ${
                      reviewEntry.included
                        ? "bg-gray-700"
                        : "bg-gray-800/50 text-gray-500 line-through"
                    }`}
                  >
                    <div className="flex items-center gap-3 truncate">
                      <button
                        className={`h-4 w-4 rounded border ${
                          reviewEntry.included
                            ? "border-green-500 bg-green-500"
                            : "border-gray-500"
                        }`}
                        onClick={() => toggleEntry(stepIndex, entryIndex)}
                      />
                      <span
                        className={`rounded px-1 text-xs ${
                          reviewEntry.entry.request.method === "GET"
                            ? "bg-blue-900 text-blue-300"
                            : "bg-orange-900 text-orange-300"
                        }`}
                      >
                        {reviewEntry.entry.request.method}
                      </span>
                      <span className="truncate">
                        {new URL(reviewEntry.entry.request.url).pathname}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span
                        className={`rounded px-1 text-xs ${
                          reviewEntry.classification === "core"
                            ? "bg-green-900 text-green-300"
                            : reviewEntry.classification === "static"
                              ? "bg-gray-700 text-gray-400"
                              : reviewEntry.classification === "analytics"
                                ? "bg-purple-900 text-purple-300"
                                : "bg-gray-700 text-gray-400"
                        }`}
                      >
                        {reviewEntry.classification}
                      </span>
                      <span className="text-xs text-gray-500">
                        {reviewEntry.entry.response?.status || "—"}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Actions */}
      {reviewSteps.length > 0 && (
        <div className="mt-6 flex items-center justify-between">
          <input
            type="text"
            placeholder="Scenario name..."
            value={scenarioName}
            onChange={(e) => setScenarioName(e.target.value)}
            className="w-64 rounded bg-gray-800 px-3 py-2 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <div className="flex gap-3">
            <button
              className="rounded bg-gray-700 px-4 py-2 hover:bg-gray-600"
              onClick={() => {
                setCaptureData(null);
                setReviewSteps([]);
                setMetadata(null);
                setScenarioName("");
                // Dropping the loaded recording keeps a later upload from being
                // linked to the provenance of the one just cleared.
                setRecordingId(null);
                setSavedRecordingName(null);
              }}
            >
              Clear
            </button>
            <button
              className="rounded bg-blue-600 px-4 py-2 hover:bg-blue-500 disabled:opacity-50"
              onClick={handleSave}
              disabled={saving || !scenarioName.trim()}
            >
              {saving ? "Saving..." : `Save as Scenario (${includedCount} requests)`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
