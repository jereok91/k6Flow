"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  decodeFrameHeader,
  FRAME_HEADER_SIZE,
  streamingServerMessageSchema,
  type StreamingServerMessage,
  type StreamingState,
  type StreamingClientMessage,
} from "@k6flow/shared";

export interface StreamingStats {
  fps: number;
  quality: number;
  rttMs: number;
  droppedFrames: number;
  recordedRequests: number;
}

export interface NavigationState {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
}

export interface UseStreamingOptions {
  wsUrl: string;
  onStateChange?: (state: StreamingState) => void;
  onNavigation?: (nav: NavigationState) => void;
  onStats?: (stats: StreamingStats) => void;
  onError?: (error: string) => void;
}

export interface UseStreamingResult {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  state: StreamingState | null;
  connected: boolean;
  navigation: NavigationState | null;
  stats: StreamingStats | null;
  cursorStyle: string;
  sendMessage: (msg: StreamingClientMessage) => void;
  sendMouseEvent: (type: string, x: number, y: number, options?: Partial<StreamingClientMessage>) => void;
  sendKeyEvent: (type: "down" | "up", key: string, code: string, options?: Partial<StreamingClientMessage>) => void;
}

export function useStreaming(options: UseStreamingOptions): UseStreamingResult {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);

  const [state, setState] = useState<StreamingState | null>(null);
  const [connected, setConnected] = useState(false);
  const [navigation, setNavigation] = useState<NavigationState | null>(null);
  const [stats, setStats] = useState<StreamingStats | null>(null);
  const [cursorStyle, setCursorStyle] = useState("default");

  // Frame tracking
  const lastFrameSeq = useRef(0);
  const frameImageRef = useRef<HTMLImageElement | null>(null);

  const handleBinaryMessage = useCallback((data: ArrayBuffer) => {
    const header = decodeFrameHeader(data);
    if (!header) return;

    // Skip old frames
    if (header.seq <= lastFrameSeq.current) return;
    lastFrameSeq.current = header.seq;

    // Extract JPEG payload
    const jpegData = new Uint8Array(data, FRAME_HEADER_SIZE);
    const blob = new Blob([jpegData], { type: "image/jpeg" });
    const url = URL.createObjectURL(blob);

    // Create image and draw to canvas
    const img = new Image();
    img.onload = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      // Resize canvas if needed
      if (canvas.width !== header.width || canvas.height !== header.height) {
        canvas.width = header.width;
        canvas.height = header.height;
      }

      // Get or create context
      if (!ctxRef.current) {
        ctxRef.current = canvas.getContext("2d");
      }

      ctxRef.current?.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
    };
    img.src = url;
    frameImageRef.current = img;
  }, []);

  const handleJsonMessage = useCallback((data: string) => {
    try {
      const json = JSON.parse(data);
      const result = streamingServerMessageSchema.safeParse(json);
      if (!result.success) {
        console.warn("Invalid server message:", result.error);
        return;
      }

      const msg = result.data;

      switch (msg.t) {
        case "state":
          setState(msg.state);
          options.onStateChange?.(msg.state);
          break;
        case "nav":
          const nav: NavigationState = {
            url: msg.url,
            title: msg.title,
            canGoBack: msg.canGoBack,
            canGoForward: msg.canGoForward,
            loading: msg.loading,
          };
          setNavigation(nav);
          options.onNavigation?.(nav);
          break;
        case "stats":
          const s: StreamingStats = {
            fps: msg.fps,
            quality: msg.quality,
            rttMs: msg.rttMs,
            droppedFrames: msg.droppedFrames,
            recordedRequests: msg.recordedRequests,
          };
          setStats(s);
          options.onStats?.(s);
          break;
        case "cursor":
          setCursorStyle(msg.style);
          break;
        case "error":
          console.error("Streaming error:", msg.code, msg.message);
          options.onError?.(msg.message);
          break;
        case "pong":
          // RTT measurement handled by stats
          break;
      }
    } catch (e) {
      console.warn("Failed to parse message:", e);
    }
  }, [options]);

  // Connect WebSocket
  useEffect(() => {
    if (!options.wsUrl) return;

    const ws = new WebSocket(options.wsUrl);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
    };

    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;
    };

    ws.onerror = (e) => {
      console.error("WebSocket error:", e);
      options.onError?.("WebSocket connection failed");
    };

    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        handleBinaryMessage(event.data);
      } else if (typeof event.data === "string") {
        handleJsonMessage(event.data);
      }
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [options.wsUrl, handleBinaryMessage, handleJsonMessage]);

  // Send message helper
  const sendMessage = useCallback((msg: StreamingClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  // Helper for mouse events
  const sendMouseEvent = useCallback((
    type: string,
    x: number,
    y: number,
    opts: Partial<StreamingClientMessage> = {}
  ) => {
    sendMessage({
      t: "mouse",
      type: type as "move" | "down" | "up" | "wheel",
      x,
      y,
      ...opts,
    } as StreamingClientMessage);
  }, [sendMessage]);

  // Helper for key events
  const sendKeyEvent = useCallback((
    type: "down" | "up",
    key: string,
    code: string,
    opts: Partial<StreamingClientMessage> = {}
  ) => {
    sendMessage({
      t: "key",
      type,
      key,
      code,
      ...opts,
    } as StreamingClientMessage);
  }, [sendMessage]);

  return {
    canvasRef,
    state,
    connected,
    navigation,
    stats,
    cursorStyle,
    sendMessage,
    sendMouseEvent,
    sendKeyEvent,
  };
}
