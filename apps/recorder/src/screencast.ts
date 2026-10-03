import type { CDPSession, Page } from "playwright";
import { encodeFrameHeader, FRAME_TYPE } from "@k6flow/shared";

export interface ScreencastConfig {
  format: "jpeg" | "png";
  quality: number; // 0-100, for JPEG
  maxWidth: number;
  maxHeight: number;
  everyNthFrame: number;
}

export interface ScreencastFrame {
  seq: number;
  width: number;
  height: number;
  timestamp: number;
  data: Buffer; // JPEG bytes
}

export interface ScreencastCallbacks {
  onFrame: (frame: ScreencastFrame) => void;
  onError: (error: Error) => void;
}

const DEFAULT_CONFIG: ScreencastConfig = {
  format: "jpeg",
  quality: 60,
  maxWidth: 1280,
  maxHeight: 720,
  everyNthFrame: 1,
};

/**
 * CDP Screencast manager that wraps Page.startScreencast/stopScreencast.
 * Implements backpressure via explicit ack control.
 */
export class Screencast {
  private cdp: CDPSession | null = null;
  private running = false;
  private seq = 0;
  private pendingAcks = new Map<number, number>(); // seq → sessionId
  private config: ScreencastConfig;
  private callbacks: ScreencastCallbacks;

  constructor(config: Partial<ScreencastConfig> = {}, callbacks: ScreencastCallbacks) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.callbacks = callbacks;
  }

  async start(page: Page): Promise<void> {
    if (this.running) return;

    console.log("[Screencast] Creating CDP session...");
    this.cdp = await page.context().newCDPSession(page);
    this.running = true;
    this.seq = 0;
    this.pendingAcks.clear();

    // Listen for frames
    this.cdp.on("Page.screencastFrame", (params) => {
      console.log(`[Screencast] Frame received: seq=${this.seq + 1}, size=${params.data.length}`);
      this.handleFrame(params);
    });

    // Start screencast
    console.log("[Screencast] Starting screencast...", this.config);
    await this.cdp.send("Page.startScreencast", {
      format: this.config.format,
      quality: this.config.quality,
      maxWidth: this.config.maxWidth,
      maxHeight: this.config.maxHeight,
      everyNthFrame: this.config.everyNthFrame,
    });
    console.log("[Screencast] Screencast started");
  }

  async stop(): Promise<void> {
    if (!this.running || !this.cdp) return;

    this.running = false;
    try {
      await this.cdp.send("Page.stopScreencast");
      await this.cdp.detach();
    } catch {
      // Ignore errors on stop
    }
    this.cdp = null;
    this.pendingAcks.clear();
  }

  /**
   * Acknowledge a frame. MUST be called for each frame to receive more.
   * Call this only after the frame has been sent (or consciously dropped).
   */
  ack(seq: number): void {
    const sessionId = this.pendingAcks.get(seq);
    if (!sessionId || !this.cdp || !this.running) return;

    this.pendingAcks.delete(seq);
    this.cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {
      // Ignore ack errors
    });
  }

  /**
   * Update quality dynamically (for adaptive streaming).
   */
  async setQuality(quality: number): Promise<void> {
    if (!this.running || !this.cdp) return;
    this.config.quality = Math.max(40, Math.min(80, quality));
    
    // Restart screencast with new quality
    await this.cdp.send("Page.stopScreencast");
    await this.cdp.send("Page.startScreencast", {
      format: this.config.format,
      quality: this.config.quality,
      maxWidth: this.config.maxWidth,
      maxHeight: this.config.maxHeight,
      everyNthFrame: this.config.everyNthFrame,
    });
  }

  get currentQuality(): number {
    return this.config.quality;
  }

  get isRunning(): boolean {
    return this.running;
  }

  // CDP screencastFrame event params - sessionId is actually a number in the CDP protocol
  private handleFrame(params: {
    data: string;
    sessionId: number;
    metadata: {
      offsetTop: number;
      pageScaleFactor: number;
      deviceWidth: number;
      deviceHeight: number;
      scrollOffsetX: number;
      scrollOffsetY: number;
      timestamp?: number;
    };
  }): void {
    const seq = ++this.seq;
    this.pendingAcks.set(seq, params.sessionId);

    const jpegData = Buffer.from(params.data, "base64");
    const frame: ScreencastFrame = {
      seq,
      width: params.metadata.deviceWidth,
      height: params.metadata.deviceHeight,
      timestamp: params.metadata.timestamp ?? Date.now(),
      data: jpegData,
    };

    try {
      this.callbacks.onFrame(frame);
    } catch (error) {
      this.callbacks.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

/**
 * Encode a frame into the binary wire format.
 */
export function encodeFrame(frame: ScreencastFrame): Buffer {
  const header = encodeFrameHeader({
    type: FRAME_TYPE,
    seq: frame.seq,
    width: frame.width,
    height: frame.height,
    timestamp: BigInt(Math.floor(frame.timestamp)),
  });
  return Buffer.concat([Buffer.from(header), frame.data]);
}
