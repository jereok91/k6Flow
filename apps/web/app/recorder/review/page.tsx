"use client";

import { useState, useCallback, useMemo } from "react";
import {
  parseNDJSONCapture,
  extractMetadata,
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

export default function RecorderReviewPage() {
  const [captureData, setCaptureData] = useState<NDJSONCaptureEvent[] | null>(null);
  const [reviewSteps, setReviewSteps] = useState<ReviewStep[]>([]);
  const [metadata, setMetadata] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load capture file
  const handleFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setLoading(true);
    setError(null);

    try {
      const content = await file.text();
      const events = parseNDJSONCapture(content);
      const meta = extractMetadata(events);
      const stepGroups = groupBySteps(events);
      const thinkTimes = calculateThinkTimes(stepGroups);

      // Convert to review format
      const steps: ReviewStep[] = stepGroups.map((group, index) => ({
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
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to parse capture file");
    } finally {
      setLoading(false);
    }
  }, []);

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

  const [saving, setSaving] = useState(false);
  const [scenarioName, setScenarioName] = useState("");

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
          recordingId: metadata.recordingId,
          entries: includedEntries,
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to save scenario");
      }

      const result = await response.json();
      // Redirect to editor
      window.location.href = `/editor?scenario=${result.id}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }, [reviewSteps, scenarioName, metadata]);

  return (
    <div className="min-h-screen bg-gray-900 p-6 text-white">
      <h1 className="mb-6 text-2xl font-bold">Review Recording</h1>

      {/* File upload */}
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
