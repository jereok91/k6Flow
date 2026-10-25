"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import Link from "next/link";
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
import { MainLayout } from "../../../lib/layout";

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

const CLASSIFICATION_LABEL: Record<ReviewEntry["classification"], string> = {
  core: "núcleo",
  static: "estático",
  third_party: "tercero",
  analytics: "analytics",
  noise: "ruido",
};

function classificationClass(classification: ReviewEntry["classification"]): string {
  if (classification === "core") return "bg-secondary/10 text-secondary";
  if (classification === "third_party" || classification === "analytics") return "bg-tertiary/10 text-tertiary";
  return "bg-surface-container-high text-on-surface-variant";
}

function statusClass(status: number | undefined): string {
  if (status === undefined || status === 0) return "badge-error";
  if (status >= 500) return "badge-error";
  if (status >= 400) return "badge-warning";
  return "badge-success";
}

function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

export default function RecorderReviewPage() {
  const [captureData, setCaptureData] = useState<NDJSONCaptureEvent[] | null>(null);
  const [reviewSteps, setReviewSteps] = useState<ReviewStep[]>([]);
  const [metadata, setMetadata] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [savedRecordingName, setSavedRecordingName] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [scenarioName, setScenarioName] = useState("");

  const applyCapture = useCallback((content: string, fallbackStepName: string) => {
    const events = parseNDJSONCapture(content);
    const meta = extractMetadata(events);
    const groups = groupBySteps(events);

    // A capture can end before any step is marked (blank start page, or a stop right
    // after the first navigation). Its requests are still what the user recorded, so
    // they are reviewed as one implicit step instead of vanishing.
    const reviewGroups: StepGroup[] = groups.length === 0
      ? (() => {
          const entries = extractNetworkEntries(events);
          return entries.length === 0
            ? []
            : [{
                step: { id: "step-capture", name: fallbackStepName, kind: "auto" as const, timestamp: meta?.startedAt ?? 0 },
                entries,
                uiEvents: [],
              }];
        })()
      : groups;
    const thinkTimes = calculateThinkTimes(reviewGroups);

    setCaptureData(events);
    setMetadata(meta);
    setReviewSteps(
      reviewGroups.map((group, index) => ({
        step: group.step,
        entries: group.entries.map((entry) => ({
          entry,
          classification: classifyNetworkEntry(entry, meta?.startUrl || ""),
          included: classifyNetworkEntry(entry, meta?.startUrl || "") === "core",
        })),
        thinkTime: thinkTimes[index] ?? 0,
      })),
    );
  }, []);

  const handleFileUpload = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setLoading(true);
    setError(null);
    // The uploaded file replaces any library recording this screen was opened for:
    // keeping its id would link the saved scenario to the wrong provenance.
    setRecordingId(null);
    setSavedRecordingName(null);

    try {
      applyCapture(await file.text(), file.name.replace(/\.ndjson$/i, ""));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo leer el archivo");
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
            ? "Esta grabación no está guardada. Podés subir el archivo .ndjson a mano."
            : data?.error || `No se pudo cargar la grabación (HTTP ${res.status})`,
        );
      }
      if (typeof data?.capture !== "string" || data.capture === "") {
        throw new Error("La grabación no tiene captura guardada. Podés subir el archivo .ndjson a mano.");
      }

      const recording = data.recording as SavedRecordingInfo | null;
      setRecordingId(id);
      setSavedRecordingName(recording?.name ?? null);
      if (recording?.name) setScenarioName(recording.name);
      applyCapture(data.capture, recording?.name ?? "Sesión completa");
    } catch (err) {
      setRecordingId(null);
      setSavedRecordingName(null);
      setError(err instanceof Error ? err.message : "No se pudo cargar la grabación");
    } finally {
      setLoading(false);
    }
  }, [applyCapture]);

  useEffect(() => {
    const requestedId = new URLSearchParams(window.location.search).get("id");
    if (requestedId === null || requestedId === "") return;
    void loadRecording(requestedId);
  }, [loadRecording]);

  const toggleEntry = useCallback((stepIndex: number, entryIndex: number) => {
    setReviewSteps((steps) =>
      steps.map((step, si) =>
        si === stepIndex
          ? { ...step, entries: step.entries.map((entry, ei) => (ei === entryIndex ? { ...entry, included: !entry.included } : entry)) }
          : step,
      ),
    );
  }, []);

  const setStepIncluded = useCallback((stepIndex: number, included: boolean) => {
    setReviewSteps((steps) =>
      steps.map((step, si) =>
        si === stepIndex ? { ...step, entries: step.entries.map((entry) => ({ ...entry, included })) } : step,
      ),
    );
  }, []);

  const includedCount = useMemo(
    () => reviewSteps.reduce((total, step) => total + step.entries.filter((entry) => entry.included).length, 0),
    [reviewSteps],
  );
  const totalCount = useMemo(
    () => reviewSteps.reduce((total, step) => total + step.entries.length, 0),
    [reviewSteps],
  );

  const handleSave = useCallback(async () => {
    if (scenarioName.trim() === "" || metadata === null) return;

    setSaving(true);
    setError(null);
    try {
      const entries = reviewSteps.flatMap((step) =>
        step.entries
          .filter((entry) => entry.included)
          .map((entry) => ({
            entry: entry.entry,
            stepId: step.step.id,
            stepName: step.step.name,
            thinkTime: step.thinkTime,
          })),
      );

      const response = await fetch("/api/recordings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: scenarioName.trim(),
          startUrl: metadata.startUrl,
          viewport: metadata.viewport,
          // Provenance is only the library entry this screen really loaded: an
          // uploaded file carries a recorder id in its metadata that no row backs.
          recordingId,
          entries,
        }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error || `No se pudo guardar el escenario (HTTP ${response.status})`);
      }

      const result = await response.json();
      window.location.href = `/editor?scenario=${result.id}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar el escenario");
    } finally {
      setSaving(false);
    }
  }, [metadata, recordingId, reviewSteps, scenarioName]);

  return (
    <MainLayout>
      <div className="px-gutter-desktop py-space-xl flex flex-col gap-space-xl">
        {/* Header */}
        <section className="flex flex-col md:flex-row md:items-end justify-between gap-space-lg">
          <div className="flex flex-col gap-space-xs">
            <div className="flex items-center gap-space-sm text-label-code-sm text-on-surface-variant uppercase tracking-wider">
              <span className="material-symbols-outlined text-secondary text-[16px]">fact_check</span>
              <span>Revisión de grabación</span>
            </div>
            <h1 className="text-headline-lg text-on-surface font-semibold tracking-tight">
              {savedRecordingName ?? (metadata?.startUrl ? pathOf(metadata.startUrl) : "Revisar peticiones")}
            </h1>
            <p className="text-body-md text-on-surface-variant">
              {metadata
                ? `${reviewSteps.length} pasos · ${includedCount} de ${totalCount} peticiones seleccionadas`
                : "Elegí qué peticiones de la sesión formarán parte del escenario."}
            </p>
          </div>

          <div className="flex items-center gap-space-sm">
            <Link href="/recordings" className="btn-secondary">
              <span className="material-symbols-outlined text-[18px]">video_library</span>
              <span>Grabaciones</span>
            </Link>
            {captureData && (
              <button
                type="button"
                onClick={handleSave}
                disabled={saving || scenarioName.trim() === "" || includedCount === 0}
                className="btn-primary"
              >
                {saving ? (
                  <>
                    <div className="animate-spin w-4 h-4 border-2 border-on-primary-container border-t-transparent rounded-full" />
                    <span>Guardando…</span>
                  </>
                ) : (
                  <>
                    <span className="material-symbols-outlined text-[18px]">save</span>
                    <span>Guardar escenario</span>
                  </>
                )}
              </button>
            )}
          </div>
        </section>

        {error && (
          <div className="p-space-md rounded-lg bg-error/10 border border-error/30 text-error text-body-sm flex items-center gap-space-sm">
            <span className="material-symbols-outlined text-[16px]">error</span>
            <span>{error}</span>
          </div>
        )}

        {/* Metadata / scenario bar */}
        {metadata && (
          <section className="card flex flex-col lg:flex-row lg:items-center justify-between gap-space-lg">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-space-md flex-1">
              {[
                { icon: "link", label: "URL", value: metadata.startUrl },
                { icon: "aspect_ratio", label: "Viewport", value: `${metadata.viewport?.width}×${metadata.viewport?.height}` },
                { icon: "route", label: "Pasos", value: String(reviewSteps.length) },
                { icon: "http", label: "Peticiones", value: `${includedCount}/${totalCount}` },
              ].map((item) => (
                <div key={item.label} className="flex items-start gap-space-sm">
                  <span className="material-symbols-outlined text-[18px] text-on-surface-variant">{item.icon}</span>
                  <div className="min-w-0">
                    <p className="text-label-code-sm text-on-surface-variant uppercase tracking-wider">{item.label}</p>
                    <p className="text-body-sm text-on-surface font-mono truncate">{item.value}</p>
                  </div>
                </div>
              ))}
            </div>

            <div className="lg:w-72">
              <label className="block text-body-sm text-on-surface-variant mb-space-sm">Nombre del escenario</label>
              <input
                type="text"
                value={scenarioName}
                onChange={(event) => setScenarioName(event.target.value)}
                placeholder="ej: Flujo de login"
                className="input"
              />
            </div>
          </section>
        )}

        {/* Empty / loading */}
        {!captureData && (
          <section className="card text-center py-space-xl">
            {loading ? (
              <>
                <div className="animate-spin w-8 h-8 border-2 border-secondary border-t-transparent rounded-full mx-auto" />
                <p className="text-body-md text-on-surface-variant mt-space-md">Cargando la captura…</p>
              </>
            ) : (
              <>
                <span className="material-symbols-outlined text-on-surface-variant text-[48px] mb-space-md">upload_file</span>
                <h3 className="text-headline-sm text-on-surface font-medium mb-space-xs">Sin captura cargada</h3>
                <p className="text-body-md text-on-surface-variant mb-space-lg">
                  Abrí esta pantalla desde una grabación, o subí el archivo <span className="font-mono">.ndjson</span> a mano.
                </p>
                <label className="btn-secondary mx-auto cursor-pointer">
                  <span className="material-symbols-outlined text-[18px]">folder_open</span>
                  <span>Elegir archivo</span>
                  <input type="file" accept=".ndjson" onChange={handleFileUpload} className="hidden" disabled={loading} />
                </label>
              </>
            )}
          </section>
        )}

        {/* Steps */}
        {reviewSteps.map((reviewStep, stepIndex) => {
          const stepIncluded = reviewStep.entries.filter((entry) => entry.included).length;
          return (
            <section key={`${reviewStep.step.id}-${stepIndex}`} className="card flex flex-col gap-space-md">
              <header className="flex flex-col md:flex-row md:items-center justify-between gap-space-md">
                <div className="flex items-start gap-space-md min-w-0">
                  <span className="w-8 h-8 rounded-lg bg-surface-container-high flex items-center justify-center text-label-code-sm text-secondary font-mono shrink-0">
                    {stepIndex + 1}
                  </span>
                  <div className="min-w-0">
                    <h2 className="text-headline-sm text-on-surface font-medium truncate">{reviewStep.step.name}</h2>
                    <p className="text-body-sm text-on-surface-variant">
                      <span className="font-mono">{reviewStep.step.kind}</span> ·{" "}
                      {reviewStep.entries.length} peticiones · {stepIncluded} seleccionadas
                      {reviewStep.thinkTime > 0 && ` · ${reviewStep.thinkTime.toFixed(1)}s de espera`}
                    </p>
                  </div>
                </div>

                {reviewStep.entries.length > 0 && (
                  <div className="flex items-center gap-space-xs shrink-0">
                    <button type="button" onClick={() => setStepIncluded(stepIndex, true)} className="btn-secondary py-space-xs">
                      <span className="material-symbols-outlined text-[16px]">done_all</span>
                      <span>Todo</span>
                    </button>
                    <button type="button" onClick={() => setStepIncluded(stepIndex, false)} className="btn-secondary py-space-xs">
                      <span className="material-symbols-outlined text-[16px]">remove_done</span>
                      <span>Nada</span>
                    </button>
                  </div>
                )}
              </header>

              {reviewStep.entries.length === 0 ? (
                <p className="text-body-sm text-on-surface-variant">
                  Este paso no capturó tráfico (navegación o cambio de vista sin peticiones nuevas).
                </p>
              ) : (
                <div className="flex flex-col divide-y divide-surface-container">
                  {reviewStep.entries.map((reviewEntry, entryIndex) => (
                    <div
                      key={`${reviewEntry.entry.request.id}-${entryIndex}`}
                      className={`flex items-center justify-between gap-space-md py-space-sm ${
                        reviewEntry.included ? "" : "opacity-50"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => toggleEntry(stepIndex, entryIndex)}
                        className="flex items-center gap-space-md min-w-0 text-left flex-1"
                        aria-pressed={reviewEntry.included}
                      >
                        <span
                          className={`w-4 h-4 rounded border shrink-0 flex items-center justify-center ${
                            reviewEntry.included ? "border-secondary bg-secondary" : "border-outline-variant"
                          }`}
                        >
                          {reviewEntry.included && (
                            <span className="material-symbols-outlined text-[12px] text-on-secondary">check</span>
                          )}
                        </span>
                        <span className="font-mono text-label-code-sm px-space-xs py-0.5 rounded bg-surface-container-high text-on-surface-variant shrink-0">
                          {reviewEntry.entry.request.method}
                        </span>
                        <span className="text-body-sm text-on-surface font-mono truncate">
                          {pathOf(reviewEntry.entry.request.url)}
                        </span>
                      </button>

                      <div className="flex items-center gap-space-xs shrink-0">
                        <span className={`px-space-xs py-0.5 rounded text-label-code-sm ${classificationClass(reviewEntry.classification)}`}>
                          {CLASSIFICATION_LABEL[reviewEntry.classification]}
                        </span>
                        <span className={`${statusClass(reviewEntry.entry.response?.status)} font-mono`}>
                          {reviewEntry.entry.response?.status ?? "—"}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </MainLayout>
  );
}
