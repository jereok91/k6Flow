"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { BrowserCanvas } from "../../lib/browser-canvas";
import { MainLayout } from "../../lib/layout";

type RecordingState = "setup" | "recording" | "completed" | "error";

export default function RecorderPage() {
  const router = useRouter();
  const [state, setState] = useState<RecordingState>("setup");
  const [recordingId, setRecordingId] = useState("");
  const [wsUrl, setWsUrl] = useState("");
  const [startUrl, setStartUrl] = useState("https://example.com");
  const [recordingName, setRecordingName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);

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

    try {
      const newRecordingId = `rec-${Date.now()}`;
      const res = await fetch("/api/recorder/start", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          recordingId: newRecordingId,
          startUrl: startUrl.trim(),
          viewportWidth: 1280,
          viewportHeight: 720,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Error iniciando grabación: ${res.status}`);
      }

      setRecordingId(newRecordingId);
      setWsUrl(getWsUrl(newRecordingId));
      setState("recording");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error iniciando grabación");
    } finally {
      setIsStarting(false);
    }
  };

  const stopRecording = async () => {
    try {
      await fetch("/api/recorder/stop", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ recordingId }),
      });
      setState("completed");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error deteniendo grabación");
    }
  };

  const handleSessionEnd = useCallback(() => {
    setState("completed");
  }, []);

  const goToReview = () => {
    router.push(`/recorder/review?id=${recordingId}&name=${encodeURIComponent(recordingName || "Grabación sin título")}&url=${encodeURIComponent(startUrl)}`);
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
            className="flex items-center gap-space-xs px-space-md py-space-sm bg-surface-container hover:bg-surface-container-high rounded-xl text-on-surface transition-colors"
          >
            <span className="material-symbols-outlined text-[18px]">stop</span>
            <span className="text-body-md font-medium">Detener Grabación</span>
          </button>
        </header>

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
              Tu sesión de navegador ha sido capturada. Revisa las peticiones y guarda como escenario.
            </p>

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
