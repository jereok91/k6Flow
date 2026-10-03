"use client";

import { useState } from "react";
import { BrowserCanvas } from "../../lib/browser-canvas";

/**
 * Test page for the visual recorder streaming.
 * Use with a running recorder container.
 */
export default function RecorderTestPage() {
  const [recordingId, setRecordingId] = useState("");
  const [wsUrl, setWsUrl] = useState("");
  const [startUrl, setStartUrl] = useState("https://example.com");
  const [error, setError] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);

  // In development, connect directly to recorder to avoid Next.js rewrite issues
  const isLocalDev = typeof window !== 'undefined' && window.location.hostname === 'localhost';
  const recorderBaseUrl = isLocalDev ? 'http://localhost:8081' : '';
  const recorderWsUrl = isLocalDev ? 'ws://localhost:8081' : `ws://${typeof window !== 'undefined' ? window.location.host : ''}`;
  const authToken = process.env.NEXT_PUBLIC_RECORDER_TOKEN || 'dev-token';

  const startRecording = async () => {
    setIsStarting(true);
    setError(null);

    try {
      const apiUrl = recorderBaseUrl ? `${recorderBaseUrl}/start` : '/api/recorder/start';
      
      const res = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          recordingId: `test-${Date.now()}`,
          startUrl,
          viewportWidth: 1280,
          viewportHeight: 720,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to start recording");
      }

      const data = await res.json();
      setRecordingId(data.recordingId);
      setWsUrl(`${recorderWsUrl}/ws/recordings/${data.recordingId}?token=${authToken}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setIsStarting(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-900 p-4">
      <div className="mx-auto max-w-6xl">
        <h1 className="mb-4 text-2xl font-bold text-white">Visual Recorder Test</h1>

        {!wsUrl ? (
          <div className="rounded-lg bg-gray-800 p-6">
            <div className="mb-4">
              <label className="mb-2 block text-sm text-gray-400">Start URL</label>
              <input
                type="url"
                value={startUrl}
                onChange={(e) => setStartUrl(e.target.value)}
                className="w-full rounded bg-gray-700 px-3 py-2 text-white"
                placeholder="https://example.com"
              />
            </div>

            <button
              onClick={startRecording}
              disabled={isStarting}
              className="rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {isStarting ? "Starting..." : "Start Recording"}
            </button>

            {error && (
              <div className="mt-4 rounded bg-red-900/50 p-3 text-red-300">{error}</div>
            )}

            <div className="mt-4 rounded bg-gray-700/50 p-3 text-sm text-gray-400">
              <p className="mb-2">
                <strong>Requirements:</strong>
              </p>
              <ul className="list-inside list-disc space-y-1">
                <li>Recorder container must be running</li>
                <li>Next.js proxy configured for /ws/recordings/*</li>
                <li>AUTH_TOKEN environment variable set</li>
              </ul>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between rounded bg-gray-800 p-3">
              <span className="text-gray-400">Recording: {recordingId}</span>
              <button
                onClick={() => {
                  setWsUrl("");
                  setRecordingId("");
                }}
                className="text-sm text-red-400 hover:text-red-300"
              >
                Disconnect
              </button>
            </div>

            <div className="overflow-hidden rounded-lg border border-gray-700">
              <BrowserCanvas
                wsUrl={wsUrl}
                viewportWidth={1280}
                viewportHeight={720}
                onStateChange={(state) => console.log("State:", state)}
                onNavigation={(nav) => console.log("Nav:", nav)}
                onStats={(stats) => console.log("Stats:", stats)}
                onError={(err) => setError(err)}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
