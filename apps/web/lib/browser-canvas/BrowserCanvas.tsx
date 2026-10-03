"use client";

import { useCallback, useRef, useState } from "react";
import { useStreaming, type UseStreamingOptions } from "./use-streaming";

export interface BrowserCanvasProps {
  wsUrl: string;
  viewportWidth?: number;
  viewportHeight?: number;
  onStateChange?: UseStreamingOptions["onStateChange"];
  onNavigation?: UseStreamingOptions["onNavigation"];
  onTabs?: UseStreamingOptions["onTabs"];
  onStats?: UseStreamingOptions["onStats"];
  onError?: UseStreamingOptions["onError"];
}

/**
 * BrowserCanvas renders a streaming browser viewport with mouse/keyboard input.
 */
export function BrowserCanvas({
  wsUrl,
  viewportWidth = 1280,
  viewportHeight = 720,
  onStateChange,
  onNavigation,
  onTabs,
  onStats,
  onError,
}: BrowserCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hasFocus, setHasFocus] = useState(false);

  const {
    canvasRef,
    state,
    connected,
    navigation,
    tabs,
    stats,
    cursorStyle,
    sendMessage,
    sendMouseEvent,
    sendKeyEvent,
  } = useStreaming({
    wsUrl,
    onStateChange,
    onNavigation,
    onTabs,
    onStats,
    onError,
  });

  // Calculate scale factor for coordinate mapping
  const getScaledCoordinates = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };

    const rect = canvas.getBoundingClientRect();
    const scaleX = viewportWidth / rect.width;
    const scaleY = viewportHeight / rect.height;

    return {
      x: Math.round((clientX - rect.left) * scaleX),
      y: Math.round((clientY - rect.top) * scaleY),
    };
  }, [viewportWidth, viewportHeight, canvasRef]);

  // Mouse handlers
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const { x, y } = getScaledCoordinates(e.clientX, e.clientY);
    // Throttle move events - only log occasionally
    sendMouseEvent("move", x, y);
  }, [getScaledCoordinates, sendMouseEvent]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setHasFocus(true);
    containerRef.current?.focus();

    const { x, y } = getScaledCoordinates(e.clientX, e.clientY);
    const button = e.button === 0 ? "left" : e.button === 1 ? "middle" : "right";
    console.log(`[BrowserCanvas] Mouse down at (${x}, ${y}) button=${button}`);
    sendMouseEvent("down", x, y, { button, clickCount: 1 });
  }, [getScaledCoordinates, sendMouseEvent]);

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    const { x, y } = getScaledCoordinates(e.clientX, e.clientY);
    const button = e.button === 0 ? "left" : e.button === 1 ? "middle" : "right";
    console.log(`[BrowserCanvas] Mouse up at (${x}, ${y}) button=${button}`);
    sendMouseEvent("up", x, y, { button, clickCount: 1 });
  }, [getScaledCoordinates, sendMouseEvent]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const { x, y } = getScaledCoordinates(e.clientX, e.clientY);
    sendMouseEvent("wheel", x, y, { deltaX: e.deltaX, deltaY: e.deltaY });
  }, [getScaledCoordinates, sendMouseEvent]);

  // Keyboard handlers
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!hasFocus) return;
    e.preventDefault();

    sendKeyEvent("down", e.key, e.code, {
      text: e.key.length === 1 ? e.key : undefined,
      mods: (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0),
    });
  }, [hasFocus, sendKeyEvent]);

  const handleKeyUp = useCallback((e: React.KeyboardEvent) => {
    if (!hasFocus) return;
    e.preventDefault();

    sendKeyEvent("up", e.key, e.code, {
      mods: (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0),
    });
  }, [hasFocus, sendKeyEvent]);

  // Handle paste
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    if (!hasFocus) return;
    e.preventDefault();

    const text = e.clipboardData.getData("text");
    if (text) {
      sendMessage({ t: "text", text });
    }
  }, [hasFocus, sendMessage]);

  const handleBlur = useCallback(() => {
    setHasFocus(false);
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault(); // Prevent browser context menu
  }, []);

  return (
    <div className="browser-canvas-container flex flex-col">
      {/* Status bar */}
      <div className="flex items-center justify-between bg-gray-800 px-3 py-1 text-sm text-gray-300">
        <div className="flex items-center gap-2">
          <span
            className={`h-2 w-2 rounded-full ${connected ? "bg-green-500" : "bg-red-500"}`}
          />
          <span>{connected ? "Connected" : "Disconnected"}</span>
          {state && <span className="text-gray-500">• {state}</span>}
        </div>
        {stats && (
          <div className="flex items-center gap-3 text-xs text-gray-500">
            <span>{stats.fps} FPS</span>
            <span>Q{stats.quality}</span>
            <span>{stats.rttMs}ms</span>
            {stats.droppedFrames > 0 && (
              <span className="text-yellow-500">⚠ {stats.droppedFrames} dropped</span>
            )}
          </div>
        )}
      </div>

      {/* Tab bar */}
      {tabs.length > 1 && (
        <div className="flex items-center gap-1 overflow-x-auto bg-gray-900 px-2 py-1">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              className={`flex max-w-[200px] items-center gap-1 rounded px-2 py-1 text-xs ${
                tab.active
                  ? "bg-gray-700 text-white"
                  : "bg-gray-800 text-gray-400 hover:bg-gray-700"
              }`}
              onClick={() => sendMessage({ t: "tab", action: "switch", index: tab.id })}
            >
              <span className="truncate">{tab.title || "New Tab"}</span>
              <button
                className="ml-1 rounded hover:bg-gray-600"
                onClick={(e) => {
                  e.stopPropagation();
                  sendMessage({ t: "tab", action: "close", index: tab.id });
                }}
              >
                ×
              </button>
            </button>
          ))}
          <button
            className="rounded p-1 text-xs text-gray-400 hover:bg-gray-700"
            onClick={() => sendMessage({ t: "tab", action: "new" })}
          >
            +
          </button>
        </div>
      )}

      {/* Navigation bar */}
      {navigation && (
        <div className="flex items-center gap-2 bg-gray-700 px-2 py-1">
          <button
            className="rounded p-1 hover:bg-gray-600 disabled:opacity-50"
            disabled={!navigation.canGoBack}
            onClick={() => sendMessage({ t: "nav", action: "back" })}
          >
            ←
          </button>
          <button
            className="rounded p-1 hover:bg-gray-600 disabled:opacity-50"
            disabled={!navigation.canGoForward}
            onClick={() => sendMessage({ t: "nav", action: "forward" })}
          >
            →
          </button>
          <button
            className="rounded p-1 hover:bg-gray-600"
            onClick={() => sendMessage({ t: "nav", action: "reload" })}
          >
            ↻
          </button>
          <div className="flex-1 rounded bg-gray-800 px-2 py-0.5 text-sm text-gray-300">
            {navigation.loading ? "Loading..." : navigation.url}
          </div>
        </div>
      )}

      {/* Canvas viewport */}
      <div
        ref={containerRef}
        className={`relative outline-none ${hasFocus ? "ring-2 ring-blue-500" : ""}`}
        tabIndex={0}
        onMouseMove={handleMouseMove}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onWheel={handleWheel}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
        onPaste={handlePaste}
        onBlur={handleBlur}
        onContextMenu={handleContextMenu}
        style={{ cursor: cursorStyle }}
      >
        <canvas
          ref={canvasRef}
          width={viewportWidth}
          height={viewportHeight}
          className="max-w-full bg-gray-900"
          style={{ aspectRatio: `${viewportWidth} / ${viewportHeight}` }}
        />

        {!connected && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-900/80">
            <span className="text-gray-400">Connecting...</span>
          </div>
        )}

        {hasFocus && (
          <div className="absolute bottom-2 left-2 rounded bg-gray-800/80 px-2 py-1 text-xs text-gray-400">
            Press Esc to release keyboard
          </div>
        )}
      </div>

      {/* Recording controls */}
      <div className="flex items-center justify-between bg-gray-800 px-3 py-2">
        <div className="flex items-center gap-2">
          {state === "READY" && (
            <button
              className="rounded bg-red-600 px-3 py-1 text-sm text-white hover:bg-red-700"
              onClick={() => sendMessage({ t: "resume" })}
            >
              ● Start Recording
            </button>
          )}
          {state === "RECORDING" && (
            <>
              <span className="flex items-center gap-1 text-red-500">
                <span className="animate-pulse">●</span> Recording
              </span>
              <button
                className="rounded bg-gray-600 px-3 py-1 text-sm text-white hover:bg-gray-500"
                onClick={() => sendMessage({ t: "pause" })}
              >
                ⏸ Pause
              </button>
            </>
          )}
          {state === "PAUSED" && (
            <>
              <span className="text-yellow-500">⏸ Paused</span>
              <button
                className="rounded bg-green-600 px-3 py-1 text-sm text-white hover:bg-green-700"
                onClick={() => sendMessage({ t: "resume" })}
              >
                ▶ Resume
              </button>
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            className="rounded bg-blue-600 px-3 py-1 text-sm text-white hover:bg-blue-700"
            onClick={() => {
              const name = prompt("Step name:");
              if (name) {
                sendMessage({ t: "mark", name, kind: "step" });
              }
            }}
          >
            + Mark Step
          </button>
          <button
            className="rounded bg-gray-600 px-3 py-1 text-sm text-white hover:bg-gray-500"
            onClick={() => sendMessage({ t: "stop" })}
          >
            ■ Stop
          </button>
        </div>
      </div>
    </div>
  );
}
