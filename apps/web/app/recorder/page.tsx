"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { BrowserCanvas } from "../../lib/browser-canvas";

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
      setError("Please enter a start URL");
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
        throw new Error(data.error || `Failed to start recording: ${res.status}`);
      }

      setRecordingId(newRecordingId);
      setWsUrl(getWsUrl(newRecordingId));
      setState("recording");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start recording");
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
      setError(e instanceof Error ? e.message : "Failed to stop recording");
    }
  };

  const handleSessionEnd = useCallback(() => {
    setState("completed");
  }, []);

  const goToReview = () => {
    // Navigate to review page with recording ID
    router.push(`/recorder/review?id=${recordingId}&name=${encodeURIComponent(recordingName || "Untitled Recording")}&url=${encodeURIComponent(startUrl)}`);
  };

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      {/* Header */}
      <header className="border-b border-gray-800 bg-gray-900/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-4">
            <Link href="/" className="text-xl font-bold text-white">
              K6Flow
            </Link>
            <span className="text-gray-500">/</span>
            <span className="text-gray-300">Recorder</span>
          </div>
          <nav className="flex items-center gap-4">
            <Link href="/scenarios" className="text-gray-400 hover:text-white">
              Scenarios
            </Link>
            <Link href="/recordings" className="text-gray-400 hover:text-white">
              Recordings
            </Link>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-8">
        {state === "setup" && (
          <div className="mx-auto max-w-2xl">
            <h1 className="mb-2 text-3xl font-bold">Record Browser Session</h1>
            <p className="mb-8 text-gray-400">
              Navigate a website and capture HTTP requests to create a load test scenario.
            </p>

            <div className="rounded-xl border border-gray-700 bg-gray-800 p-6">
              <div className="mb-6">
                <label className="mb-2 block text-sm font-medium text-gray-300">
                  Recording Name
                </label>
                <input
                  type="text"
                  value={recordingName}
                  onChange={(e) => setRecordingName(e.target.value)}
                  placeholder="e.g., Login Flow, Checkout Process"
                  className="w-full rounded-lg border border-gray-600 bg-gray-700 px-4 py-3 text-white placeholder-gray-500 focus:border-blue-500 focus:outline-none"
                />
              </div>

              <div className="mb-6">
                <label className="mb-2 block text-sm font-medium text-gray-300">
                  Start URL
                </label>
                <input
                  type="url"
                  value={startUrl}
                  onChange={(e) => setStartUrl(e.target.value)}
                  placeholder="https://example.com"
                  className="w-full rounded-lg border border-gray-600 bg-gray-700 px-4 py-3 text-white placeholder-gray-500 focus:border-blue-500 focus:outline-none"
                />
              </div>

              {error && (
                <div className="mb-6 rounded-lg bg-red-900/50 p-4 text-red-300">
                  {error}
                </div>
              )}

              <button
                onClick={startRecording}
                disabled={isStarting}
                className="w-full rounded-lg bg-red-600 py-3 font-medium hover:bg-red-500 disabled:opacity-50"
              >
                {isStarting ? "Starting..." : "🎬 Start Recording"}
              </button>
            </div>

            <div className="mt-8 rounded-xl border border-gray-700 bg-gray-800/50 p-6">
              <h3 className="mb-3 font-semibold">How it works:</h3>
              <ol className="list-inside list-decimal space-y-2 text-sm text-gray-400">
                <li>Enter the URL where you want to start recording</li>
                <li>A browser window will open - interact with the site normally</li>
                <li>All HTTP requests will be captured automatically</li>
                <li>Stop recording and review the captured requests</li>
                <li>Save as a scenario and generate K6 scripts</li>
              </ol>
            </div>
          </div>
        )}

        {state === "recording" && (
          <div>
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2">
                  <span className="h-3 w-3 animate-pulse rounded-full bg-red-500"></span>
                  <span className="font-medium text-red-400">Recording</span>
                </div>
                <span className="text-gray-500">|</span>
                <span className="text-gray-400">{recordingName || "Untitled"}</span>
              </div>
              <button
                onClick={stopRecording}
                className="rounded-lg bg-gray-700 px-6 py-2 font-medium hover:bg-gray-600"
              >
                ⏹ Stop Recording
              </button>
            </div>

            <div className="overflow-hidden rounded-xl border border-gray-700">
              <BrowserCanvas
                wsUrl={wsUrl}
                viewportWidth={1280}
                viewportHeight={720}
              />
            </div>

            <div className="mt-4 text-center text-sm text-gray-500">
              Navigate the browser above. All HTTP requests are being captured.
            </div>
          </div>
        )}

        {state === "completed" && (
          <div className="mx-auto max-w-2xl text-center">
            <div className="mb-6 text-6xl">✅</div>
            <h1 className="mb-2 text-3xl font-bold">Recording Complete</h1>
            <p className="mb-8 text-gray-400">
              Your browser session has been captured. Review the requests and save as a scenario.
            </p>

            <div className="flex justify-center gap-4">
              <button
                onClick={goToReview}
                className="rounded-lg bg-blue-600 px-8 py-3 font-medium hover:bg-blue-500"
              >
                Review & Save
              </button>
              <button
                onClick={() => {
                  setState("setup");
                  setRecordingId("");
                  setWsUrl("");
                  setError(null);
                }}
                className="rounded-lg border border-gray-600 px-8 py-3 font-medium hover:bg-gray-800"
              >
                New Recording
              </button>
            </div>
          </div>
        )}

        {state === "error" && (
          <div className="mx-auto max-w-2xl text-center">
            <div className="mb-6 text-6xl">❌</div>
            <h1 className="mb-2 text-3xl font-bold">Recording Failed</h1>
            <p className="mb-8 text-red-400">{error}</p>

            <button
              onClick={() => {
                setState("setup");
                setError(null);
              }}
              className="rounded-lg bg-blue-600 px-8 py-3 font-medium hover:bg-blue-500"
            >
              Try Again
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
