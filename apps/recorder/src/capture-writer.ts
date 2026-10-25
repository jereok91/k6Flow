import { createWriteStream, mkdirSync, existsSync } from "node:fs";
import type { WriteStream } from "node:fs";
import type { CapturedRequest, CapturedEntry } from "./network-capture";
import type { CapturedUIEvent } from "./ui-event-capture";
import type { Step } from "./step-manager";

export interface CaptureMetadata {
  recordingId: string;
  startUrl: string;
  viewport: { width: number; height: number };
  startedAt: number;
  userAgent?: string;
}

export type CaptureEvent =
  | { type: "metadata"; data: CaptureMetadata }
  | { type: "network_request"; data: CapturedRequest }
  | { type: "network_entry"; data: CapturedEntry }
  | { type: "ui_event"; data: CapturedUIEvent }
  | { type: "step"; data: Step }
  | { type: "state_change"; data: { state: string; timestamp: number } }
  | { type: "navigation"; data: { url: string; title: string; timestamp: number } }
  | { type: "end"; data: { endedAt: number; reason: string; incomplete?: boolean } };

/**
 * CaptureWriter writes recording events to an NDJSON file.
 */
export class CaptureWriter {
  private stream: WriteStream | null = null;
  private filePath: string;
  private eventCount = 0;

  constructor(outputDir: string, recordingId: string) {
    // Ensure output directory exists
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    this.filePath = `${outputDir}/${recordingId}.ndjson`;
  }

  start(metadata: CaptureMetadata): void {
    this.stream = createWriteStream(this.filePath, { flags: "w" });
    this.write({ type: "metadata", data: metadata });
  }

  writeNetworkRequest(request: CapturedRequest): void {
    this.write({ type: "network_request", data: request });
  }

  writeNetworkEntry(entry: CapturedEntry): void {
    this.write({ type: "network_entry", data: entry });
  }

  writeUIEvent(event: CapturedUIEvent): void {
    this.write({ type: "ui_event", data: event });
  }

  writeStep(step: Step): void {
    this.write({ type: "step", data: step });
  }

  writeStateChange(state: string): void {
    this.write({ 
      type: "state_change", 
      data: { state, timestamp: Date.now() } 
    });
  }

  writeNavigation(url: string, title: string): void {
    this.write({ 
      type: "navigation", 
      data: { url, title, timestamp: Date.now() } 
    });
  }

  /**
   * Write the end marker and resolve once the file is fully flushed to disk, so
   * a caller that answers a stop request never exposes a truncated capture.
   */
  end(reason: string, options: { incomplete?: boolean } = {}): Promise<void> {
    this.write({ 
      type: "end", 
      data: { endedAt: Date.now(), reason, ...(options.incomplete === true && { incomplete: true }) } 
    });

    const stream = this.stream;
    this.stream = null;
    if (!stream) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      stream.once("finish", () => resolve());
      // A failed flush must not look like a closed capture: the stop has to be able
      // to report that the end marker never reached the disk.
      stream.once("error", (error) => {
        console.error("[CaptureWriter] Close error:", error);
        reject(error);
      });
      stream.end();
    });
  }

  private write(event: CaptureEvent): void {
    if (!this.stream) return;
    
    try {
      this.stream.write(JSON.stringify(event) + "\n");
      this.eventCount++;
    } catch (error) {
      console.error("[CaptureWriter] Write error:", error);
    }
  }

  get path(): string {
    return this.filePath;
  }

  get count(): number {
    return this.eventCount;
  }
}
