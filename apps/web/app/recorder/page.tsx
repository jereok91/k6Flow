"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { BrowserCanvas } from "../../lib/browser-canvas";
import { MainLayout } from "../../lib/layout";

type RecordingState = "setup" | "recording" | "completed" | "error";

/** What the web tier persisted when the recording was stopped. */
interface SavedRecording {
  id: string;
  name: string;
  startUrl: string;
  requestCount: number;
  stepCount: number;
  durationMs: number;
}

export default function RecorderPage() {
  const router = useRouter();
  const [state, setState] = useState<RecordingState>("setup");
  const [recordingId, setRecordingId] = useState("");
  const [wsUrl, setWsUrl] = useState("");
  const [startUrl, setStartUrl] = useState("https://example.com");
  const [recordingName, setRecordingName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [saved, setSaved] = useState<SavedRecording | null>(null);
  const [stopWarning, setStopWarning] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const stoppingRef = useRef(false);
  // Set once a stop cannot succeed by retrying (the recorder owns another session).
  const stopPollingRef = useRef(false);

  const authToken = process.env.NEXT_PUBLIC_RECORDER_TOKEN || "dev-token";

  const getWsUrl = (recId: string) => {
    if (process.env.NEXT_PUBLIC_RECORDER_WS) {
      return `${process.env.NEXT_PUBLIC_RECORDER_WS}/ws/recordings/${recId}?token=${authToken}`;
    }
    const protocol = typeof window !== "undefined" && window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = typeof window !== "undefined" ? window.location.host : "localhost:3000";
    return `${protocol}//${host}/ws/recordings/${recId}?token=${authToken}`;
  };

  const startRecording = async () => {
    if (!startUrl.trim()) {
      setError("Ingresa una URL para comenzar");
      return;
    }

    setIsStarting(true);
    setError(null);
    setSaved(null);
    setStopWarning(null);

    try {
      const res = await fetch("/api/recorder/start", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          name: recordingName,
          startUrl: startUrl.trim(),
          viewportWidth: 1280,
          viewportHeight: 720,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Error iniciando grabación: ${res.status}`);
      }

      const data = await res.json().catch(() => ({}));
      // The recorder owns the id: the WebSocket, the stop and the capture lookup
      // all use the one it minted. A response without it is a contract failure,
      // never something to paper over with a client-made id.
      if (typeof data.recordingId !== "string" || data.recordingId === "") {
        throw new Error("El grabador no devolvió un identificador de grabación");
      }

      setRecordingId(data.recordingId);
      setWsUrl(getWsUrl(data.recordingId));
      setState("recording");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error iniciando grabación");
    } finally {
      setIsStarting(false);
    }
  };

  /**
   * Stop through the recorder and let the web tier persist the capture. Any
   * failure keeps the session on screen instead of claiming it completed.
   */
  const finishRecording = useCallback(async (idToStop: string): Promise<void> => {
    if (idToStop === "" || stoppingRef.current) return;
    stoppingRef.current = true;
    setStopping(true);
    setError(null);

    try {
      // Bounded: a hung request must not leave the stop button disabled and the
      // health poll short-circuited forever.
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      const res = await fetch("/api/recorder/stop", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          recordingId: idToStop,
          name: recordingName,
          startUrl,
          viewport: { width: 1280, height: 720 },
        }),
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout));

      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const message = data && typeof data.error === "string"
          ? data.error
          : `No se pudo detener la grabación (HTTP ${res.status})`;
        // 409 means this recording is not the live session: retrying it cannot help.
        stopPollingRef.current = res.status === 409;
        throw new Error(message);
      }

      if (data && data.recording) {
        setSaved(data.recording as SavedRecording);
        setStopWarning(null);
      } else {
        setSaved(null);
        setStopWarning(
          data && typeof data.warning === "string"
            ? data.warning
            : "La grabación se detuvo, pero no llegó ninguna captura para guardar",
        );
      }
      setState("completed");
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo detener la grabación");
    } finally {
      stoppingRef.current = false;
      setStopping(false);
    }
  }, [authToken, recordingName, startUrl]);

  const stopRecording = () => void finishRecording(recordingId);

  // The recorder can end a session on its own (inactivity, max duration). Polling
  // its state keeps the page from showing "Grabando" forever, and the stop path
  // is idempotent, so it still collects the capture.
  useEffect(() => {
    if (state !== "recording" || recordingId === "") return;

    const timer = setInterval(async () => {
      if (stoppingRef.current || stopPollingRef.current) return;
      try {
        const res = await fetch("/api/recorder/healthz", { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        const active = typeof data.recordingId === "string" ? data.recordingId : null;
        if (active !== recordingId) {
          await finishRecording(recordingId);
        }
      } catch {
        // Advisory only: a failed poll must not interrupt an ongoing recording.
      }
    }, 4000);

    return () => clearInterval(timer);
  }, [state, recordingId, finishRecording]);

  const goToReview = () => {
    const id = saved?.id ?? recordingId;
    router.push(`/recorder/review?id=${encodeURIComponent(id)}`);
  };

  // Setup state - without MainLayout for cleaner look
  if (state === "setup") {
    return (
      <MainLayout>
        <div className="px-gutter-desktop py-space-xl">
          <div className="mx-auto max-w-2xl">
            {/* Header */}
            <div className="flex flex-col gap-space-xs mb-space-xl">
              <div className="flex items-center gap-space-sm text-label-code-sm text-on-surface-variant uppercase tracking-wider">
                <span className="material-symbols-outlined text-secondary text-[16px]">fiber_manual_record</span>
                <span>Grabador de sesiones</span>
              </div>
              <h1 className="text-headline-lg text-on-surface font-semibold tracking-tight">
                Nueva Grabación
              </h1>
              <p className="text-body-md text-on-surface-variant">
                Navega un sitio web y captura las peticiones HTTP para crear escenarios de carga.
              </p>
            </div>

            {/* Form */}
            <div className="card">
              <div className="mb-space-lg">
                <label className="block text-body-sm text-on-surface-variant mb-space-sm">
                  Nombre de la grabación
                </label>
                <input
                  type="text"
                  value={recordingName}
                  onChange={(e) => setRecordingName(e.target.value)}
                  placeholder="ej: Flujo de Login, Proceso de Checkout"
                  className="input"
                />
              </div>

              <div className="mb-space-lg">
                <label className="block text-body-sm text-on-surface-variant mb-space-sm">
                  URL de inicio
                </label>
                <input
                  type="url"
                  value={startUrl}
                  onChange={(e) => setStartUrl(e.target.value)}
                  placeholder="https://example.com"
                  className="input"
                />
              </div>

              {error && (
                <div className="mb-space-lg p-space-md rounded-lg bg-error/10 border border-error/30 text-error text-body-sm">
                  <span className="material-symbols-outlined text-[16px] mr-space-xs align-middle">error</span>
                  {error}
                </div>
              )}

              <button
                onClick={startRecording}
                disabled={isStarting}
                className="btn-primary w-full justify-center py-space-md"
              >
                {isStarting ? (
                  <>
                    <div className="animate-spin w-4 h-4 border-2 border-on-primary-container border-t-transparent rounded-full" />
                    <span>Iniciando...</span>
                  </>
                ) : (
                  <>
                    <span className="material-symbols-outlined text-[18px]">fiber_manual_record</span>
                    <span>Iniciar Grabación</span>
                  </>
                )}
              </button>
            </div>

            {/* Instructions */}
            <div className="card mt-space-lg bg-surface-container-lowest border-surface-container">
              <h3 className="text-headline-sm text-on-surface font-medium mb-space-md">
                ¿Cómo funciona?
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-space-md">
                {[
                  { step: 1, icon: "link", text: "Ingresa la URL donde quieres comenzar" },
                  { step: 2, icon: "web", text: "Se abrirá un navegador - interactúa normalmente" },
                  { step: 3, icon: "radar", text: "Todas las peticiones HTTP se capturan automáticamente" },
                  { step: 4, icon: "save", text: "Detén la grabación y revisa las peticiones capturadas" },
                ].map((item) => (
                  <div key={item.step} className="flex items-start gap-space-md">
                    <span className="w-6 h-6 rounded-lg bg-surface-container-high flex items-center justify-center text-label-code-sm text-secondary font-mono shrink-0">
                      {item.step}
                    </span>
                    <div className="flex items-center gap-space-sm text-body-sm text-on-surface-variant">
                      <span className="material-symbols-outlined text-[16px] text-on-surface-variant">{item.icon}</span>
                      <span>{item.text}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </MainLayout>
    );
  }

  // Recording state - full width for browser
  if (state === "recording") {
    return (
      <div className="min-h-screen bg-background text-on-surface">
        {/* Compact header */}
        <header className="h-14 bg-surface-container-lowest border-b border-surface-container flex items-center justify-between px-space-lg">
          <div className="flex items-center gap-space-md">
            <Link href="/" className="flex items-center gap-space-sm">
              <div className="w-7 h-7 rounded-lg bg-primary-container flex items-center justify-center">
                <span className="text-on-primary-container font-bold text-xs">k6</span>
              </div>
              <span className="text-headline-sm font-semibold text-on-surface">K6Flow</span>
            </Link>
            <span className="text-outline-variant">/</span>
            <div className="flex items-center gap-space-sm">
              <span className="relative flex h-2.5 w-2.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-error opacity-75" />
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-error" />
              </span>
              <span className="text-body-md text-error font-medium">Grabando</span>
            </div>
            <span className="text-body-sm text-on-surface-variant">{recordingName || "Sin título"}</span>
          </div>

          <button
            onClick={stopRecording}
            disabled={stopping}
            className="flex items-center gap-space-xs px-space-md py-space-sm bg-surface-container hover:bg-surface-container-high rounded-xl text-on-surface transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {stopping ? (
              <>
                <div className="animate-spin w-4 h-4 border-2 border-on-surface border-t-transparent rounded-full" />
                <span className="text-body-md font-medium">Deteniendo...</span>
              </>
            ) : (
              <>
                <span className="material-symbols-outlined text-[18px]">stop</span>
                <span className="text-body-md font-medium">Detener Grabación</span>
              </>
            )}
          </button>
        </header>

        {/* A stop that did not happen is reported here, next to the live session */}
        {error && (
          <div className="mx-space-md mt-space-md p-space-md rounded-lg bg-error/10 border border-error/30 text-error text-body-sm flex items-center gap-space-sm">
            <span className="material-symbols-outlined text-[16px]">error</span>
            <span className="flex-1">{error}</span>
            <button onClick={stopRecording} className="btn-secondary py-space-xs">
              Reintentar
            </button>
          </div>
        )}

        {/* Browser canvas */}
        <div className="p-space-md">
          <div className="rounded-xl border border-surface-container overflow-hidden shadow-modal">
            <BrowserCanvas
              wsUrl={wsUrl}
              viewportWidth={1280}
              viewportHeight={720}
            />
          </div>
          <p className="text-center text-body-sm text-on-surface-variant mt-space-md">
            Navega el sitio web arriba. Todas las peticiones HTTP se están capturando.
          </p>
        </div>
      </div>
    );
  }

  // Completed state
  if (state === "completed") {
    return (
      <MainLayout>
        <div className="px-gutter-desktop py-space-xl">
          <div className="mx-auto max-w-2xl text-center">
            <div className="w-20 h-20 rounded-full bg-secondary/10 flex items-center justify-center mx-auto mb-space-lg">
              <span className="material-symbols-outlined text-secondary text-[40px]">check_circle</span>
            </div>
            <h1 className="text-headline-lg text-on-surface font-semibold mb-space-sm">
              Grabación Completada
            </h1>
            <p className="text-body-md text-on-surface-variant mb-space-xl">
              {saved
                ? `${saved.name} · ${saved.requestCount} peticiones · ${saved.stepCount} pasos · ${Math.round(saved.durationMs / 1000)}s`
                : "Tu sesión de navegador ha sido capturada. Revisa las peticiones y guarda como escenario."}
            </p>

            {stopWarning && (
              <div className="mb-space-lg p-space-md rounded-lg bg-error/10 border border-error/30 text-error text-body-sm text-left">
                <span className="material-symbols-outlined text-[16px] mr-space-xs align-middle">warning</span>
                {stopWarning}. Podés subir el archivo .ndjson a mano desde la pantalla de revisión.
              </div>
            )}

            <div className="flex justify-center gap-space-md">
              <button onClick={goToReview} className="btn-primary">
                <span className="material-symbols-outlined text-[18px]">visibility</span>
                <span>Revisar y Guardar</span>
              </button>
              <button
                onClick={() => {
                  setState("setup");
                  setRecordingId("");
                  setWsUrl("");
                  setError(null);
                  setSaved(null);
                  setStopWarning(null);
                }}
                className="btn-secondary"
              >
                <span className="material-symbols-outlined text-[18px]">add</span>
                <span>Nueva Grabación</span>
              </button>
            </div>
          </div>
        </div>
      </MainLayout>
    );
  }

  // Error state
  return (
    <MainLayout>
      <div className="px-gutter-desktop py-space-xl">
        <div className="mx-auto max-w-2xl text-center">
          <div className="w-20 h-20 rounded-full bg-error/10 flex items-center justify-center mx-auto mb-space-lg">
            <span className="material-symbols-outlined text-error text-[40px]">error</span>
          </div>
          <h1 className="text-headline-lg text-on-surface font-semibold mb-space-sm">
            Error en la Grabación
          </h1>
          <p className="text-body-md text-error mb-space-xl">{error}</p>

          <button
            onClick={() => {
              setState("setup");
              setError(null);
            }}
            className="btn-primary"
          >
            <span className="material-symbols-outlined text-[18px]">refresh</span>
            <span>Intentar de Nuevo</span>
          </button>
        </div>
      </div>
    </MainLayout>
  );
}
