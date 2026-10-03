import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { StreamingState, StreamingClientMessage } from "@k6flow/shared";
import { Screencast, type ScreencastFrame, type ScreencastConfig } from "./screencast.ts";

export interface RecordingSessionConfig {
  startUrl: string;
  viewport: { width: number; height: number };
  userAgent?: string;
  locale?: string;
  timezone?: string;
  screencast: Partial<ScreencastConfig>;
}

export interface RecordingSessionCallbacks {
  onFrame: (frame: ScreencastFrame) => void;
  onStateChange: (state: StreamingState) => void;
  onNavigation: (url: string, title: string, canGoBack: boolean, canGoForward: boolean, loading: boolean) => void;
  onError: (error: Error) => void;
}

const DEFAULT_CONFIG: RecordingSessionConfig = {
  startUrl: "about:blank",
  viewport: { width: 1280, height: 720 },
  screencast: {},
};

/**
 * A recording session manages a browser instance and its screencast.
 */
export class RecordingSession {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private screencast: Screencast | null = null;
  private state: StreamingState = "CREATED";
  private config: RecordingSessionConfig;
  private callbacks: RecordingSessionCallbacks;
  private startTime = 0;

  constructor(config: Partial<RecordingSessionConfig>, callbacks: RecordingSessionCallbacks) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.callbacks = callbacks;
  }

  async start(): Promise<void> {
    if (this.state !== "CREATED") {
      throw new Error(`Cannot start from state ${this.state}`);
    }

    this.setState("PROVISIONING");

    try {
      // Launch browser
      this.browser = await chromium.launch({
        headless: true,
        args: [
          "--disable-gpu",
          "--disable-dev-shm-usage",
          "--disable-setuid-sandbox",
          "--no-sandbox",
        ],
      });

      // Create context with viewport
      this.context = await this.browser.newContext({
        viewport: this.config.viewport,
        userAgent: this.config.userAgent,
        locale: this.config.locale,
        timezoneId: this.config.timezone,
      });

      // Create page
      this.page = await this.context.newPage();

      // Setup navigation listener
      this.page.on("framenavigated", (frame) => {
        if (frame === this.page?.mainFrame()) {
          this.emitNavigation();
        }
      });

      this.page.on("load", () => {
        this.emitNavigation();
      });

      // Start screencast
      this.screencast = new Screencast(
        {
          ...this.config.screencast,
          maxWidth: this.config.viewport.width,
          maxHeight: this.config.viewport.height,
        },
        {
          onFrame: (frame) => this.callbacks.onFrame(frame),
          onError: (error) => this.callbacks.onError(error),
        }
      );

      await this.screencast.start(this.page);

      // Navigate to start URL
      if (this.config.startUrl && this.config.startUrl !== "about:blank") {
        await this.page.goto(this.config.startUrl, { waitUntil: "domcontentloaded" });
      }

      this.startTime = Date.now();
      this.setState("READY");
    } catch (error) {
      this.setState("FAILED");
      throw error;
    }
  }

  async startRecording(): Promise<void> {
    if (this.state !== "READY" && this.state !== "PAUSED") {
      throw new Error(`Cannot start recording from state ${this.state}`);
    }
    this.setState("RECORDING");
  }

  async pauseRecording(): Promise<void> {
    if (this.state !== "RECORDING") {
      throw new Error(`Cannot pause from state ${this.state}`);
    }
    this.setState("PAUSED");
  }

  async resumeRecording(): Promise<void> {
    if (this.state !== "PAUSED") {
      throw new Error(`Cannot resume from state ${this.state}`);
    }
    this.setState("RECORDING");
  }

  async stop(): Promise<void> {
    if (this.state === "STOPPING" || this.state === "SAVED" || this.state === "FAILED") {
      return;
    }

    this.setState("STOPPING");

    try {
      if (this.screencast) {
        await this.screencast.stop();
        this.screencast = null;
      }

      if (this.context) {
        await this.context.close();
        this.context = null;
        this.page = null;
      }

      if (this.browser) {
        await this.browser.close();
        this.browser = null;
      }
    } catch {
      // Ignore cleanup errors
    }
  }

  /**
   * Handle input messages from the client.
   */
  async handleInput(message: StreamingClientMessage): Promise<void> {
    if (!this.page) return;

    switch (message.t) {
      case "mouse":
        await this.handleMouse(message);
        break;
      case "key":
        await this.handleKey(message);
        break;
      case "text":
        await this.page.keyboard.insertText(message.text);
        break;
      case "nav":
        await this.handleNavigation(message);
        break;
      case "pause":
        await this.pauseRecording();
        break;
      case "resume":
        await this.resumeRecording();
        break;
      case "stop":
        await this.stop();
        break;
      case "resize":
        await this.page.setViewportSize({ width: message.width, height: message.height });
        break;
      // Other message types handled elsewhere
    }
  }

  private async handleMouse(msg: { type: string; x: number; y: number; button?: string; clickCount?: number; deltaX?: number; deltaY?: number }): Promise<void> {
    if (!this.page) return;

    const button = (msg.button || "left") as "left" | "middle" | "right";

    switch (msg.type) {
      case "move":
        await this.page.mouse.move(msg.x, msg.y);
        break;
      case "down":
        await this.page.mouse.down({ button, clickCount: msg.clickCount || 1 });
        break;
      case "up":
        await this.page.mouse.up({ button, clickCount: msg.clickCount || 1 });
        break;
      case "wheel":
        await this.page.mouse.wheel(msg.deltaX || 0, msg.deltaY || 0);
        break;
    }
  }

  private async handleKey(msg: { type: string; key: string; text?: string }): Promise<void> {
    if (!this.page) return;

    if (msg.type === "down") {
      await this.page.keyboard.down(msg.key);
    } else if (msg.type === "up") {
      await this.page.keyboard.up(msg.key);
    }
  }

  private async handleNavigation(msg: { action: string; url?: string }): Promise<void> {
    if (!this.page) return;

    switch (msg.action) {
      case "goto":
        if (msg.url) {
          await this.page.goto(msg.url, { waitUntil: "domcontentloaded" });
        }
        break;
      case "back":
        await this.page.goBack();
        break;
      case "forward":
        await this.page.goForward();
        break;
      case "reload":
        await this.page.reload();
        break;
      case "stop":
        // No direct stop in Playwright, but we can abort
        break;
    }
  }

  /**
   * Acknowledge a frame to allow more frames to be sent.
   */
  ackFrame(seq: number): void {
    this.screencast?.ack(seq);
  }

  /**
   * Set screencast quality dynamically.
   */
  async setQuality(quality: number): Promise<void> {
    await this.screencast?.setQuality(quality);
  }

  get currentState(): StreamingState {
    return this.state;
  }

  get currentQuality(): number {
    return this.screencast?.currentQuality ?? 60;
  }

  get durationMs(): number {
    return this.startTime > 0 ? Date.now() - this.startTime : 0;
  }

  private setState(state: StreamingState): void {
    this.state = state;
    this.callbacks.onStateChange(state);
  }

  private async emitNavigation(): Promise<void> {
    if (!this.page) return;

    try {
      const url = this.page.url();
      const title = await this.page.title();
      // Playwright doesn't expose canGoBack/canGoForward directly
      // We'd need to track navigation history ourselves
      this.callbacks.onNavigation(url, title, false, false, false);
    } catch {
      // Page may have been closed
    }
  }
}
