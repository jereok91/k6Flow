import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { StreamingState, StreamingClientMessage } from "@k6flow/shared";
import { Screencast, type ScreencastFrame, type ScreencastConfig } from "./screencast";

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

  // Navigation history tracking
  private navigationHistory: string[] = [];
  private historyIndex = -1;
  private isNavigatingHistory = false;
  private isLoading = false;

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

      // Setup navigation listeners
      this.page.on("framenavigated", (frame) => {
        if (frame === this.page?.mainFrame()) {
          this.handleNavigationEvent();
        }
      });

      this.page.on("load", () => {
        this.isLoading = false;
        this.emitNavigation();
      });

      this.page.on("domcontentloaded", () => {
        this.isLoading = false;
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
        // Initialize history with start URL
        this.navigationHistory = [this.config.startUrl];
        this.historyIndex = 0;
      }

      this.startTime = Date.now();
      this.setState("READY");
      this.emitNavigation();
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
    if (!this.page) {
      console.log(`[Session] No page, cannot handle input`);
      return;
    }

    console.log(`[Session] Handling input: ${message.t}`);

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
    console.log(`[Mouse] ${msg.type} at (${msg.x}, ${msg.y}) button=${button}`);

    try {
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
    } catch (error) {
      console.error(`[Mouse] Error:`, error);
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

    this.isLoading = true;
    this.emitNavigation();

    try {
      switch (msg.action) {
        case "goto":
          if (msg.url) {
            await this.page.goto(msg.url, { waitUntil: "domcontentloaded" });
          }
          break;
        case "back":
          if (this.historyIndex > 0) {
            this.isNavigatingHistory = true;
            this.historyIndex--;
            await this.page.goBack();
          }
          break;
        case "forward":
          if (this.historyIndex < this.navigationHistory.length - 1) {
            this.isNavigatingHistory = true;
            this.historyIndex++;
            await this.page.goForward();
          }
          break;
        case "reload":
          await this.page.reload();
          break;
        case "stop":
          // No direct stop in Playwright, but we can abort
          break;
      }
    } finally {
      this.isLoading = false;
      this.emitNavigation();
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

  /**
   * Handle navigation event from framenavigated.
   * Track history for canGoBack/canGoForward.
   */
  private handleNavigationEvent(): void {
    if (!this.page) return;

    const url = this.page.url();
    
    // Skip about:blank
    if (url === "about:blank") return;

    // If we're navigating via back/forward, don't add to history
    if (this.isNavigatingHistory) {
      this.isNavigatingHistory = false;
    } else {
      // Truncate forward history if we navigate to new page
      if (this.historyIndex < this.navigationHistory.length - 1) {
        this.navigationHistory = this.navigationHistory.slice(0, this.historyIndex + 1);
      }
      // Add new URL to history
      if (this.navigationHistory[this.historyIndex] !== url) {
        this.navigationHistory.push(url);
        this.historyIndex = this.navigationHistory.length - 1;
      }
    }

    this.emitNavigation();
  }

  private async emitNavigation(): Promise<void> {
    if (!this.page) return;

    try {
      const url = this.page.url();
      const title = await this.page.title();
      const canGoBack = this.historyIndex > 0;
      const canGoForward = this.historyIndex < this.navigationHistory.length - 1;
      this.callbacks.onNavigation(url, title, canGoBack, canGoForward, this.isLoading);
    } catch {
      // Page may have been closed
    }
  }
}
