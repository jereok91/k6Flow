import { chromium, type Browser, type BrowserContext, type Page, type Dialog, type FileChooser } from "playwright";
import type { StreamingState, StreamingClientMessage } from "@k6flow/shared";
import { Screencast, type ScreencastFrame, type ScreencastConfig } from "./screencast";
import { NetworkCapture, type CapturedRequest, type CapturedEntry } from "./network-capture";
import { UIEventCapture, type CapturedUIEvent } from "./ui-event-capture";
import { StepManager, type Step } from "./step-manager";

export interface RecordingSessionConfig {
  startUrl: string;
  viewport: { width: number; height: number };
  userAgent?: string;
  locale?: string;
  timezone?: string;
  screencast: Partial<ScreencastConfig>;
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

export interface RecordingSessionCallbacks {
  onFrame: (frame: ScreencastFrame) => void;
  onStateChange: (state: StreamingState) => void;
  onNavigation: (url: string, title: string, canGoBack: boolean, canGoForward: boolean, loading: boolean) => void;
  onTabs: (tabs: TabInfo[]) => void;
  onDialog: (dialog: DialogInfo) => void;
  onFileChooser: (info: FileChooserInfo) => void;
  onCursor: (style: string) => void;
  onNetworkRequest: (request: CapturedRequest) => void;
  onNetworkEntry: (entry: CapturedEntry) => void;
  onUIEvent: (event: CapturedUIEvent) => void;
  onStep: (step: Step) => void;
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
  private networkCapture: NetworkCapture | null = null;
  private uiEventCapture: UIEventCapture | null = null;
  private stepManager: StepManager | null = null;
  private state: StreamingState = "CREATED";
  private config: RecordingSessionConfig;
  private callbacks: RecordingSessionCallbacks;
  private startTime = 0;

  // Navigation history tracking
  private navigationHistory: string[] = [];
  private historyIndex = -1;
  private isNavigatingHistory = false;
  private isLoading = false;

  // Multi-tab tracking
  private pages: Page[] = [];
  private activePageIndex = 0;
  private tabIdCounter = 0;

  // Dialog tracking
  private pendingDialogs = new Map<string, Dialog>();
  private dialogIdCounter = 0;

  // File chooser tracking
  private pendingFileChoosers = new Map<string, FileChooser>();
  private fileChooserIdCounter = 0;

  // Cursor tracking
  private lastCursorStyle = "default";
  private lastMouseX = 0;
  private lastMouseY = 0;

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

      // Create initial page
      this.page = await this.context.newPage();
      this.pages.push(this.page);
      this.activePageIndex = 0;
      this.setupPageListeners(this.page);

      // Listen for new pages (popups, target=_blank)
      this.context.on("page", async (newPage) => {
        await this.handleNewPage(newPage);
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

      // Start network capture
      this.networkCapture = new NetworkCapture({
        onRequest: (req) => this.callbacks.onNetworkRequest(req),
        onResponse: (entry) => this.callbacks.onNetworkEntry(entry),
        onError: (error) => this.callbacks.onError(error),
      });
      await this.networkCapture.start(this.page);

      // Start UI event capture
      this.uiEventCapture = new UIEventCapture({
        onEvent: (event) => this.callbacks.onUIEvent(event),
      });
      await this.uiEventCapture.start(this.page);

      // Initialize step manager
      this.stepManager = new StepManager({
        onStep: (step) => this.callbacks.onStep(step),
      });

      // Navigate to start URL
      if (this.config.startUrl && this.config.startUrl !== "about:blank") {
        await this.page.goto(this.config.startUrl, { waitUntil: "domcontentloaded" });
        // Initialize history with start URL
        this.navigationHistory = [this.config.startUrl];
        this.historyIndex = 0;
      }

      this.startTime = Date.now();
      this.setState("RECORDING");  // Start recording immediately
      this.emitNavigation();
    } catch (error) {
      this.setState("FAILED");
      // stop() is a no-op once FAILED, so release the browser here.
      await this.browser?.close().catch(() => {});
      this.browser = null;
      this.context = null;
      this.page = null;
      throw error;
    }
  }

  async startRecording(): Promise<void> {
    // Already recording, ignore
    if (this.state === "RECORDING") {
      return;
    }
    if (this.state !== "READY" && this.state !== "PAUSED") {
      throw new Error(`Cannot start recording from state ${this.state}`);
    }
    this.setState("RECORDING");
  }

  async pauseRecording(): Promise<void> {
    if (this.state !== "RECORDING") {
      throw new Error(`Cannot pause from state ${this.state}`);
    }
    this.networkCapture?.pause();
    this.uiEventCapture?.pause();
    this.stepManager?.pause();
    this.setState("PAUSED");
  }

  async resumeRecording(): Promise<void> {
    // Ignore if already recording or ready (no-op)
    if (this.state === "RECORDING" || this.state === "READY") {
      console.log(`[Session] Ignoring resume in state ${this.state}`);
      return;
    }
    if (this.state !== "PAUSED") {
      throw new Error(`Cannot resume from state ${this.state}`);
    }
    this.networkCapture?.resume();
    this.uiEventCapture?.resume();
    this.stepManager?.resume();
    this.setState("RECORDING");
  }

  async stop(): Promise<void> {
    if (this.state === "STOPPING" || this.state === "SAVED" || this.state === "FAILED") {
      return;
    }

    this.setState("STOPPING");

    try {
      if (this.uiEventCapture) {
        await this.uiEventCapture.stop();
        this.uiEventCapture = null;
      }

      if (this.networkCapture) {
        await this.networkCapture.stop();
        this.networkCapture = null;
      }

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
      case "tab":
        await this.handleTab(message);
        break;
      case "dialog_reply":
        await this.handleDialogReply(message);
        break;
      case "file_upload":
        await this.handleFileUpload(message);
        break;
      case "resize":
        await this.page.setViewportSize({ width: message.width, height: message.height });
        break;
      case "mark":
        if ("name" in message && "kind" in message) {
          this.addStep(
            message.name as string,
            message.kind as "step" | "assert" | "note",
            "note" in message ? (message.note as string) : undefined
          );
        }
        break;
      // Other message types handled elsewhere
    }
  }

  private async handleMouse(msg: { type: string; x: number; y: number; button?: string; clickCount?: number; deltaX?: number; deltaY?: number }): Promise<void> {
    if (!this.page) return;

    const button = (msg.button || "left") as "left" | "middle" | "right";

    try {
      switch (msg.type) {
        case "move":
          await this.page.mouse.move(msg.x, msg.y);
          this.lastMouseX = msg.x;
          this.lastMouseY = msg.y;
          // Detect cursor style (throttled)
          this.detectCursorStyle(msg.x, msg.y);
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

  private cursorDetectPending = false;
  private async detectCursorStyle(x: number, y: number): Promise<void> {
    if (!this.page || this.cursorDetectPending) return;
    
    this.cursorDetectPending = true;
    
    try {
      const cursor = await this.page.evaluate(([px, py]) => {
        const el = document.elementFromPoint(px, py);
        if (!el) return "default";
        return window.getComputedStyle(el).cursor || "default";
      }, [x, y] as [number, number]);
      
      if (cursor !== this.lastCursorStyle) {
        this.lastCursorStyle = cursor;
        this.callbacks.onCursor(cursor);
      }
    } catch {
      // Ignore errors (page navigating, etc)
    } finally {
      // Throttle: wait 50ms before next detection
      setTimeout(() => {
        this.cursorDetectPending = false;
      }, 50);
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

  private async handleTab(msg: { action: string; index?: number }): Promise<void> {
    switch (msg.action) {
      case "switch":
        if (typeof msg.index === "number") {
          await this.switchToPage(msg.index);
        }
        break;
      case "close":
        if (typeof msg.index === "number" && this.pages[msg.index]) {
          await this.pages[msg.index].close();
        } else if (this.page) {
          await this.page.close();
        }
        break;
      case "new":
        if (this.context) {
          const newPage = await this.context.newPage();
          // handleNewPage will be called via context.on('page')
        }
        break;
    }
  }

  /**
   * Handle incoming dialog from the page.
   */
  private handleDialog(dialog: Dialog): void {
    const id = `dialog-${++this.dialogIdCounter}`;
    this.pendingDialogs.set(id, dialog);

    const kind = dialog.type() as DialogInfo["kind"];
    const info: DialogInfo = {
      id,
      kind,
      message: dialog.message(),
      defaultValue: dialog.defaultValue() || undefined,
    };

    this.callbacks.onDialog(info);
  }

  /**
   * Handle dialog reply from client.
   */
  private async handleDialogReply(msg: { id: string; accept: boolean; promptText?: string }): Promise<void> {
    const dialog = this.pendingDialogs.get(msg.id);
    if (!dialog) {
      console.warn(`[Session] Dialog ${msg.id} not found`);
      return;
    }

    this.pendingDialogs.delete(msg.id);

    try {
      if (msg.accept) {
        await dialog.accept(msg.promptText);
      } else {
        await dialog.dismiss();
      }
    } catch (error) {
      console.error(`[Session] Failed to handle dialog:`, error);
    }
  }

  /**
   * Handle incoming file chooser from the page.
   */
  private handleFileChooser(fileChooser: FileChooser): void {
    const id = `filechooser-${++this.fileChooserIdCounter}`;
    this.pendingFileChoosers.set(id, fileChooser);

    const info: FileChooserInfo = {
      id,
      multiple: fileChooser.isMultiple(),
    };

    this.callbacks.onFileChooser(info);
  }

  /**
   * Handle file upload from client.
   * Files are uploaded via HTTP and referenced by assetId.
   */
  private async handleFileUpload(msg: { id: string; files: Array<{ name: string; assetId: string }> }): Promise<void> {
    const fileChooser = this.pendingFileChoosers.get(msg.id);
    if (!fileChooser) {
      console.warn(`[Session] FileChooser ${msg.id} not found`);
      return;
    }

    this.pendingFileChoosers.delete(msg.id);

    try {
      // Files are stored in /tmp/uploads/<assetId>
      const filePaths = msg.files.map(f => `/tmp/uploads/${f.assetId}`);
      await fileChooser.setFiles(filePaths);
    } catch (error) {
      console.error(`[Session] Failed to set files:`, error);
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
   * Setup event listeners for a page.
   */
  private setupPageListeners(page: Page): void {
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame() && page === this.page) {
        this.handleNavigationEvent();
      }
    });

    page.on("load", () => {
      if (page === this.page) {
        this.isLoading = false;
        this.emitNavigation();
      }
    });

    page.on("domcontentloaded", () => {
      if (page === this.page) {
        this.isLoading = false;
        this.emitNavigation();
      }
    });

    page.on("close", () => {
      this.handlePageClose(page);
    });

    page.on("dialog", (dialog) => {
      this.handleDialog(dialog);
    });

    page.on("filechooser", (fileChooser) => {
      this.handleFileChooser(fileChooser);
    });
  }

  /**
   * Handle a new page (popup or target=_blank).
   */
  private async handleNewPage(newPage: Page): Promise<void> {
    this.pages.push(newPage);
    this.setupPageListeners(newPage);

    // Auto-switch to the new page
    await this.switchToPage(this.pages.length - 1);
    this.emitTabs();
  }

  /**
   * Handle page close.
   */
  private handlePageClose(closedPage: Page): void {
    const index = this.pages.indexOf(closedPage);
    if (index === -1) return;

    this.pages.splice(index, 1);

    // If the active page was closed, switch to another
    if (closedPage === this.page) {
      const newIndex = Math.min(index, this.pages.length - 1);
      if (newIndex >= 0) {
        this.switchToPage(newIndex).catch(console.error);
      } else {
        // All pages closed
        this.page = null;
      }
    } else if (index < this.activePageIndex) {
      // Adjust index if a page before the active one was closed
      this.activePageIndex--;
    }

    this.emitTabs();
  }

  /**
   * Switch screencast to a different page.
   */
  async switchToPage(index: number): Promise<void> {
    if (index < 0 || index >= this.pages.length) return;
    if (index === this.activePageIndex && this.pages[index] === this.page) return;

    const newPage = this.pages[index];
    this.activePageIndex = index;
    this.page = newPage;

    // Reset navigation history for the new page
    this.navigationHistory = [newPage.url()];
    this.historyIndex = 0;
    this.isNavigatingHistory = false;

    // Switch screencast to new page
    if (this.screencast) {
      await this.screencast.stop();
      await this.screencast.start(newPage);
    }

    this.emitNavigation();
    this.emitTabs();
  }

  /**
   * Emit current tabs state.
   */
  private async emitTabs(): Promise<void> {
    const tabs: TabInfo[] = await Promise.all(
      this.pages.map(async (page, index) => ({
        id: index,
        url: page.url(),
        title: await page.title().catch(() => "Untitled"),
        active: index === this.activePageIndex,
      }))
    );
    this.callbacks.onTabs(tabs);
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

      // Auto-step on navigation when recording
      if (this.state === "RECORDING" && !this.isLoading && this.stepManager) {
        this.stepManager.addNavigationStep(url, title);
      }
    } catch {
      // Page may have been closed
    }
  }

  /**
   * Add a manual step marker.
   */
  addStep(name: string, kind: "step" | "assert" | "note", note?: string): void {
    this.stepManager?.addManualStep(name, kind, note);
  }
}
