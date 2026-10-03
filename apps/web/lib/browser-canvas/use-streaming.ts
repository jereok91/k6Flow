"use client";

import { useCallback, useEffect, useRef, useState, useMemo } from "react";
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

export interface TabInfo {
  id: number;
  url: string;
  title: string;
  active: boolean;
}

export interface DialogInfo {
  id: string;
  kind: "alert" | "confirm" | "prompt" | "beforeunload";
  message: string;
  defaultValue?: string;
}

export interface FileChooserInfo {
  id: string;
  multiple: boolean;
}

export interface UseStreamingOptions {
  wsUrl: string;
  onStateChange?: (state: StreamingState) => void;
  onNavigation?: (nav: NavigationState) => void;
  onTabs?: (tabs: TabInfo[]) => void;
  onDialog?: (dialog: DialogInfo) => void;
  onFileChooser?: (info: FileChooserInfo) => void;
  onStats?: (stats: StreamingStats) => void;
  onError?: (error: string) => void;
}

export interface UseStreamingResult {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  state: StreamingState | null;
  connected: boolean;
  navigation: NavigationState | null;
  tabs: TabInfo[];
  dialog: DialogInfo | null;
  fileChooser: FileChooserInfo | null;
  stats: StreamingStats | null;
  cursorStyle: string;
  sendMessage: (msg: StreamingClientMessage) => void;
  sendMouseEvent: (type: string, x: number, y: number, options?: Partial<StreamingClientMessage>) => void;
  sendKeyEvent: (type: "down" | "up", key: string, code: string, options?: Partial<StreamingClientMessage>) => void;
  replyDialog: (accept: boolean, promptText?: string) => void;
  uploadFiles: (files: File[]) => Promise<void>;
}

export function useStreaming(options: UseStreamingOptions): UseStreamingResult {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);

  const [state, setState] = useState<StreamingState | null>(null);
  const [connected, setConnected] = useState(false);
  const [navigation, setNavigation] = useState<NavigationState | null>(null);
  const [tabs, setTabs] = useState<TabInfo[]>([]);
  const [dialog, setDialog] = useState<DialogInfo | null>(null);
  const [fileChooser, setFileChooser] = useState<FileChooserInfo | null>(null);
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
        case "tabs":
          setTabs(msg.tabs);
          options.onTabs?.(msg.tabs);
          break;
        case "dialog":
          const d: DialogInfo = {
            id: msg.id,
            kind: msg.kind,
            message: msg.message,
            defaultValue: "defaultValue" in msg ? msg.defaultValue : undefined,
          };
          setDialog(d);
          options.onDialog?.(d);
          break;
        case "filechooser":
          const fc: FileChooserInfo = {
            id: msg.id,
            multiple: msg.multiple,
          };
          setFileChooser(fc);
          options.onFileChooser?.(fc);
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

  // Store callbacks in refs to avoid recreating WebSocket on callback changes
  const handleBinaryRef = useRef(handleBinaryMessage);
  const handleJsonRef = useRef(handleJsonMessage);
  const onErrorRef = useRef(options.onError);
  
  useEffect(() => {
    handleBinaryRef.current = handleBinaryMessage;
    handleJsonRef.current = handleJsonMessage;
    onErrorRef.current = options.onError;
  });

  // Connect WebSocket - only depends on wsUrl
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
    };

    ws.onerror = (e) => {
      console.error("WebSocket error:", e);
      onErrorRef.current?.("WebSocket connection failed");
    };

    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        handleBinaryRef.current(event.data);
      } else if (typeof event.data === "string") {
        handleJsonRef.current(event.data);
      }
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [options.wsUrl]);

  // Send message helper
  const sendMessage = useCallback((msg: StreamingClientMessage) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }, []);

  // Helper for mouse events
  const sendMouseEvent = useCallback((
    type: string,
    x: number,
    y: number,
    opts: Partial<StreamingClientMessage> = {}
  ) => {
    const msg = {
      t: "mouse",
      type: type as "move" | "down" | "up" | "wheel",
      x,
      y,
      ...opts,
    } as StreamingClientMessage;
    
    if (type !== "move") {
      console.log(`[useStreaming] Sending mouse event:`, msg);
    }
    sendMessage(msg);
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

  // Helper for dialog replies
  const replyDialog = useCallback((accept: boolean, promptText?: string) => {
    if (!dialog) return;
    sendMessage({
      t: "dialog_reply",
      id: dialog.id,
      accept,
      promptText,
    } as StreamingClientMessage);
    setDialog(null);
  }, [dialog, sendMessage]);

  // Helper for file upload
  const uploadFiles = useCallback(async (files: File[]) => {
    if (!fileChooser) return;

    // Upload each file and collect asset IDs
    const uploadedFiles: Array<{ name: string; assetId: string }> = [];
    
    for (const file of files) {
      try {
        // Get the recorder URL from wsUrl (ws://host/ws/... -> http://host/upload)
        const wsUrlObj = new URL(options.wsUrl, window.location.href);
        const uploadUrl = `${wsUrlObj.protocol === "wss:" ? "https:" : "http:"}//${wsUrlObj.host}/upload`;
        
        const response = await fetch(uploadUrl, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${new URLSearchParams(wsUrlObj.search).get("token") || ""}`
          },
          body: file,
        });
        
        if (response.ok) {
          const { assetId } = await response.json();
          uploadedFiles.push({ name: file.name, assetId });
        }
      } catch (error) {
        console.error("File upload failed:", error);
      }
    }

    // Send file_upload message
    if (uploadedFiles.length > 0) {
      sendMessage({
        t: "file_upload",
        id: fileChooser.id,
        files: uploadedFiles,
      } as StreamingClientMessage);
    }

    setFileChooser(null);
  }, [fileChooser, options.wsUrl, sendMessage]);

  return {
    canvasRef,
    state,
    connected,
    navigation,
    tabs,
    dialog,
    fileChooser,
    stats,
    cursorStyle,
    sendMessage,
    sendMouseEvent,
    sendKeyEvent,
    replyDialog,
    uploadFiles,
  };
}
