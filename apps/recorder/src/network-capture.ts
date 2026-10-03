import type { Page, CDPSession } from "playwright";

export interface CapturedRequest {
  id: string;
  timestamp: number;
  method: string;
  url: string;
  headers: Record<string, string>;
  postData?: string;
  resourceType: string;
}

export interface CapturedResponse {
  id: string;
  timestamp: number;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  mimeType: string;
  bodySize: number;
  body?: string; // Base64 for binary, text for text
  bodyTruncated: boolean;
}

export interface CapturedEntry {
  request: CapturedRequest;
  response?: CapturedResponse;
  timing?: {
    startTime: number;
    endTime: number;
    durationMs: number;
  };
}

export interface NetworkCaptureCallbacks {
  onRequest: (request: CapturedRequest) => void;
  onResponse: (entry: CapturedEntry) => void;
  onError: (error: Error) => void;
}

const MAX_BODY_SIZE = 1024 * 1024; // 1MB max body capture

/**
 * NetworkCapture uses CDP to capture all network traffic.
 */
export class NetworkCapture {
  private cdp: CDPSession | null = null;
  private callbacks: NetworkCaptureCallbacks;
  private pendingRequests = new Map<string, CapturedRequest>();
  private enabled = false;
  private paused = false;

  constructor(callbacks: NetworkCaptureCallbacks) {
    this.callbacks = callbacks;
  }

  async start(page: Page): Promise<void> {
    if (this.cdp) {
      await this.stop();
    }

    this.cdp = await page.context().newCDPSession(page);
    
    // Enable network tracking
    await this.cdp.send("Network.enable", {
      maxPostDataSize: MAX_BODY_SIZE,
      maxResourceBufferSize: MAX_BODY_SIZE,
      maxTotalBufferSize: MAX_BODY_SIZE * 10,
    });

    // Request will be sent
    this.cdp.on("Network.requestWillBeSent", (params) => {
      if (this.paused) return;
      this.handleRequestWillBeSent(params);
    });

    // Response received
    this.cdp.on("Network.responseReceived", (params) => {
      if (this.paused) return;
      this.handleResponseReceived(params);
    });

    // Loading finished - get body
    this.cdp.on("Network.loadingFinished", (params) => {
      if (this.paused) return;
      this.handleLoadingFinished(params);
    });

    // Loading failed
    this.cdp.on("Network.loadingFailed", (params) => {
      if (this.paused) return;
      this.handleLoadingFailed(params);
    });

    this.enabled = true;
  }

  async stop(): Promise<void> {
    if (this.cdp) {
      try {
        await this.cdp.send("Network.disable");
        await this.cdp.detach();
      } catch {
        // Ignore errors during cleanup
      }
      this.cdp = null;
    }
    this.enabled = false;
    this.pendingRequests.clear();
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  private handleRequestWillBeSent(params: any): void {
    const { requestId, request, timestamp, type } = params;

    const captured: CapturedRequest = {
      id: requestId,
      timestamp: timestamp * 1000, // Convert to ms
      method: request.method,
      url: request.url,
      headers: this.normalizeHeaders(request.headers),
      postData: request.postData,
      resourceType: type || "Other",
    };

    this.pendingRequests.set(requestId, captured);
    this.callbacks.onRequest(captured);
  }

  private handleResponseReceived(params: any): void {
    const { requestId, response, timestamp } = params;
    const request = this.pendingRequests.get(requestId);
    
    if (!request) return;

    // Store response info for later (body comes in loadingFinished)
    (request as any)._response = {
      status: response.status,
      statusText: response.statusText,
      headers: this.normalizeHeaders(response.headers),
      mimeType: response.mimeType || "",
      timestamp: timestamp * 1000,
    };
  }

  private async handleLoadingFinished(params: any): Promise<void> {
    const { requestId, timestamp, encodedDataLength } = params;
    const request = this.pendingRequests.get(requestId);
    
    if (!request) return;
    this.pendingRequests.delete(requestId);

    const responseInfo = (request as any)._response;
    if (!responseInfo) return;

    // Try to get response body
    let body: string | undefined;
    let bodyTruncated = false;

    if (this.cdp && encodedDataLength > 0 && encodedDataLength <= MAX_BODY_SIZE) {
      try {
        const result = await this.cdp.send("Network.getResponseBody", { requestId });
        body = result.base64Encoded ? result.body : result.body;
        // If base64, keep as-is; if text, store as-is
        if (result.base64Encoded) {
          body = `base64:${result.body}`;
        }
      } catch {
        // Body not available (e.g., redirects)
      }
    } else if (encodedDataLength > MAX_BODY_SIZE) {
      bodyTruncated = true;
    }

    const entry: CapturedEntry = {
      request,
      response: {
        id: requestId,
        timestamp: responseInfo.timestamp,
        status: responseInfo.status,
        statusText: responseInfo.statusText,
        headers: responseInfo.headers,
        mimeType: responseInfo.mimeType,
        bodySize: encodedDataLength,
        body,
        bodyTruncated,
      },
      timing: {
        startTime: request.timestamp,
        endTime: timestamp * 1000,
        durationMs: (timestamp * 1000) - request.timestamp,
      },
    };

    this.callbacks.onResponse(entry);
  }

  private handleLoadingFailed(params: any): void {
    const { requestId, errorText, timestamp } = params;
    const request = this.pendingRequests.get(requestId);
    
    if (!request) return;
    this.pendingRequests.delete(requestId);

    // Emit as entry with error
    const entry: CapturedEntry = {
      request,
      response: {
        id: requestId,
        timestamp: timestamp * 1000,
        status: 0,
        statusText: errorText || "Failed",
        headers: {},
        mimeType: "",
        bodySize: 0,
        bodyTruncated: false,
      },
      timing: {
        startTime: request.timestamp,
        endTime: timestamp * 1000,
        durationMs: (timestamp * 1000) - request.timestamp,
      },
    };

    this.callbacks.onResponse(entry);
  }

  private normalizeHeaders(headers: Record<string, string>): Record<string, string> {
    const normalized: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers || {})) {
      normalized[key.toLowerCase()] = value;
    }
    return normalized;
  }
}
