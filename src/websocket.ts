/**
 * WebSocket Streaming Connection
 *
 * Persistent WebSocket connection to the TTS streaming endpoint.
 * Multiplexes concurrent synthesis requests over a single connection,
 * eliminating per-request HTTP overhead (CORS preflight, TCP/TLS setup).
 *
 * Returns the same AsyncGenerator<StreamChunk> interface as HTTP
 * synthesizeStream(), so consumers (e.g. MediaSourcePlayer) don't
 * need to change.
 */

import type { ProsodyKnob, StreamChunk, SynthesizeRequest } from '@responsivevoice/types';

// Binary frame header layout (must match server ws-protocol.ts)
const BINARY_HEADER_SIZE = 41;
const BINARY_FRAME_TYPE_AUDIO = 0x01;

/**
 * Generate a v4 UUID using crypto.getRandomValues() for broad compatibility.
 * Available in all target browsers (Chrome 11+) and Node.js 14+, unlike
 * crypto.randomUUID() which requires Chrome 92+ / Node.js 19+.
 */
function generateUUID(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Configuration for constructing a {@link WebSocketConnection}. Only
 * `baseUrl` is required; the rest control reconnect behaviour and
 * authentication. Pass a `WebSocket` constructor to use the client outside
 * browsers where the global `WebSocket` is unavailable.
 */
export interface WebSocketConnectionConfig {
  /** Base URL of the TTS API (https://...) — will be converted to wss:// */
  baseUrl: string;
  /** API key for authentication */
  apiKey?: string;
  /**
   * Resolves the bearer JWT to send as the `token` upgrade query param.
   * Awaited on every `connect()` so reconnects carry a fresh, unexpired
   * token. Returns `undefined` when no bearer is held (key-only upgrade).
   */
  getAuthToken?: () => Promise<string | undefined>;
  /** Ping interval in ms to keep the connection alive. @defaultValue 25000 */
  pingInterval?: number;
  /** Auto-reconnect on unexpected close. @defaultValue true */
  autoReconnect?: boolean;
  /** Max reconnect attempts before giving up. @defaultValue 5 */
  maxReconnectAttempts?: number;
  /** Base delay between reconnect attempts in ms (exponential backoff). @defaultValue 1000 */
  reconnectDelay?: number;
  /**
   * Custom WebSocket constructor for environments where the global `WebSocket`
   * is not available (e.g. Node.js below v22). Pass `ws` or any W3C-compatible implementation.
   *
   * @example
   * ```typescript
   * import WebSocket from 'ws';
   * new WebSocketConnection({ baseUrl: '...', WebSocket });
   * ```
   */
  WebSocket?: { new (url: string | URL): WebSocket };
}

type RequestCallback = (chunk: StreamChunk) => void;

interface PendingRequest {
  callback: RequestCallback;
  done: () => void;
  error: (err: Error) => void;
}

/**
 * Convert an HTTP(S) base URL to a WebSocket URL.
 * https://host/v2 → wss://host/v2/text/stream?key=...
 */
function buildWsUrl(baseUrl: string, apiKey?: string, token?: string): string {
  const url = new URL('/v2/text/stream', baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  if (apiKey) url.searchParams.set('key', apiKey);
  if (token) url.searchParams.set('token', token);
  return url.toString();
}

/**
 * Parse a binary audio frame from the WebSocket.
 *
 * Layout: 1-byte type | 36-byte ASCII UUID | 4-byte BE chunkIndex | audio bytes
 */
function parseBinaryFrame(
  data: ArrayBuffer
): { requestId: string; chunkIndex: number; audio: Uint8Array } | null {
  if (data.byteLength < BINARY_HEADER_SIZE) return null;

  const view = new DataView(data);
  const frameType = view.getUint8(0);
  if (frameType !== BINARY_FRAME_TYPE_AUDIO) return null;

  const requestId = new TextDecoder().decode(new Uint8Array(data, 1, 36));
  const chunkIndex = view.getUint32(37, false); // big-endian
  const audio = new Uint8Array(data, BINARY_HEADER_SIZE);

  return { requestId, chunkIndex, audio };
}

/**
 * Persistent WebSocket client for the TTS streaming endpoint
 * (`/v2/text/stream`). Maintains a single connection, demultiplexes audio
 * frames by request ID, handles pings and exponential-backoff reconnection,
 * and exposes the same {@link StreamChunk} iterator shape as the HTTP
 * `synthesizeStream()` fallback so consumers can swap transports without
 * reshaping their audio pipeline.
 *
 * Instantiate via {@link ResponsiveVoiceAPIClient}'s WebSocket transport
 * mode; direct construction is supported for custom clients. The connection
 * opens on first `connect()` or `synthesizeStream()` call — there is no
 * eager handshake.
 */
export class WebSocketConnection {
  private ws: WebSocket | null = null;
  private readonly config: Omit<Required<WebSocketConnectionConfig>, 'WebSocket' | 'getAuthToken'>;
  private readonly WebSocketImpl: { new (url: string | URL): WebSocket };
  private readonly getAuthToken: (() => Promise<string | undefined>) | undefined;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempts = 0;
  private intentionalClose = false;
  private connectPromise: Promise<void> | null = null;

  constructor(config: WebSocketConnectionConfig) {
    const WS = config.WebSocket ?? globalThis.WebSocket;
    if (!WS) {
      throw new Error(
        'WebSocket is not available in this environment. ' +
          'Pass a WebSocket implementation via the WebSocket config option ' +
          "(e.g. the 'ws' package on Node.js < 22)."
      );
    }
    this.WebSocketImpl = WS;
    this.getAuthToken = config.getAuthToken;
    this.config = {
      baseUrl: config.baseUrl,
      apiKey: config.apiKey ?? '',
      pingInterval: config.pingInterval ?? 25_000,
      autoReconnect: config.autoReconnect ?? true,
      maxReconnectAttempts: config.maxReconnectAttempts ?? 5,
      reconnectDelay: config.reconnectDelay ?? 1000,
    };
  }

  /** Whether the WebSocket is currently open and ready */
  get connected(): boolean {
    return this.ws?.readyState === 1 /* WebSocket.OPEN */;
  }

  /**
   * Open the WebSocket connection. Resolves when the connection is open.
   * If already connected, returns immediately.
   */
  connect(): Promise<void> {
    if (this.connected) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;

    this.intentionalClose = false;
    this.connectPromise = this.openConnection();
    return this.connectPromise;
  }

  /**
   * Resolve a fresh bearer token (if a provider is configured) and open the
   * underlying socket. Token resolution happens per call so reconnects carry
   * an unexpired credential.
   */
  private async openConnection(): Promise<void> {
    const token = this.getAuthToken ? await this.getAuthToken() : undefined;
    return new Promise<void>((resolve, reject) => {
      const url = buildWsUrl(this.config.baseUrl, this.config.apiKey || undefined, token);
      const ws = new this.WebSocketImpl(url);
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        this.ws = ws;
        this.reconnectAttempts = 0;
        this.connectPromise = null;
        this.startPing();
        resolve();
      };

      ws.onerror = () => {
        this.connectPromise = null;
        reject(new Error('WebSocket connection failed'));
      };

      ws.onclose = (evt) => {
        this.cleanup();
        this.connectPromise = null;

        if (!this.intentionalClose) {
          // Reject all pending requests
          for (const [id, req] of this.pendingRequests) {
            req.error(new Error(`WebSocket closed: ${evt.code} ${evt.reason}`));
            this.pendingRequests.delete(id);
          }

          // Auto-reconnect if enabled
          if (
            this.config.autoReconnect &&
            this.reconnectAttempts < this.config.maxReconnectAttempts
          ) {
            this.scheduleReconnect();
          }
        }
      };

      ws.onmessage = (evt) => this.handleMessage(evt);
    });
  }

  /**
   * Close the connection gracefully.
   */
  close(): void {
    this.intentionalClose = true;
    this.cleanup();
    if (this.ws) {
      this.ws.close(1000, 'Client closing');
      this.ws = null;
    }

    // Reject all pending requests
    for (const [id, req] of this.pendingRequests) {
      req.error(new Error('WebSocket connection closed by client'));
      this.pendingRequests.delete(id);
    }
  }

  /**
   * Send a synthesis request and return a streaming chunk generator.
   * The returned AsyncGenerator yields the same StreamChunk types as
   * the HTTP synthesizeStream() method.
   */
  async *synthesizeStream(request: SynthesizeRequest): AsyncGenerator<StreamChunk> {
    if (!this.connected) {
      await this.connect();
    }

    const requestId = generateUUID();

    // Create a queue-based async iterator
    const queue: StreamChunk[] = [];
    let resolve: (() => void) | null = null;
    let done = false;
    let streamError: Error | null = null;

    this.pendingRequests.set(requestId, {
      callback: (chunk: StreamChunk) => {
        queue.push(chunk);
        resolve?.();
      },
      done: () => {
        done = true;
        resolve?.();
      },
      error: (err: Error) => {
        streamError = err;
        done = true;
        resolve?.();
      },
    });

    // Send the synthesize message
    this.send({
      type: 'synthesize',
      id: requestId,
      request: {
        text: request.text,
        lang: request.lang,
        engine: request.engine,
        name: request.name,
        gender: request.gender,
        pitch: request.pitch,
        rate: request.rate,
        volume: request.volume,
      },
    });

    try {
      while (true) {
        // Drain the queue
        while (queue.length > 0) {
          yield queue.shift()!;
        }

        if (done) {
          if (streamError) throw streamError;
          return;
        }

        // Wait for new data
        await new Promise<void>((r) => {
          resolve = r;
        });
        resolve = null;
      }
    } finally {
      this.pendingRequests.delete(requestId);
    }
  }

  /**
   * Cancel an in-flight synthesis request.
   */
  cancel(requestId: string): void {
    if (!this.connected) return;
    this.send({ type: 'cancel', id: requestId });
    const pending = this.pendingRequests.get(requestId);
    if (pending) {
      pending.error(new Error('Synthesis cancelled'));
      this.pendingRequests.delete(requestId);
    }
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private send(msg: Record<string, unknown>): void {
    if (this.ws?.readyState !== 1 /* WebSocket.OPEN */) return;
    this.ws.send(JSON.stringify(msg));
  }

  private handleBinaryMessage(data: ArrayBuffer): void {
    const frame = parseBinaryFrame(data);
    if (!frame) return;

    const pending = this.pendingRequests.get(frame.requestId);
    if (!pending) return;

    pending.callback({
      type: 'audio',
      data: frame.audio as Uint8Array<ArrayBuffer>,
      chunkIndex: frame.chunkIndex,
    });
  }

  private handleControlMessage(msg: { type: string; id?: string; [key: string]: unknown }): void {
    if (msg.type === 'pong') return;

    if (msg.type === 'stream_start' && msg.id) {
      this.pendingRequests.get(msg.id)?.callback({
        type: 'metadata',
        contentType: msg.contentType as string,
        prosodyApplied: (msg.prosodyApplied as ProsodyKnob[] | undefined) ?? [],
      });
      return;
    }

    if (msg.type === 'stream_end' && msg.id) {
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        pending.callback({
          type: 'end',
          totalBytes: msg.totalBytes as number,
          totalChunks: msg.totalChunks as number,
        });
        pending.done();
        this.pendingRequests.delete(msg.id);
      }
      return;
    }

    if (msg.type === 'error') {
      this.handleErrorMessage(msg);
    }
  }

  private handleErrorMessage(msg: { id?: string; [key: string]: unknown }): void {
    const message = (msg.message as string) || 'Unknown WebSocket error';
    const retryable = (msg.retryable as boolean) ?? false;

    if (msg.id) {
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        pending.callback({ type: 'error', message, retryable });
        pending.error(new Error(message));
        this.pendingRequests.delete(msg.id);
      }
    } else {
      for (const [id, req] of this.pendingRequests) {
        req.error(new Error(message));
        this.pendingRequests.delete(id);
      }
    }
  }

  private handleMessage(evt: MessageEvent): void {
    if (evt.data instanceof ArrayBuffer) {
      this.handleBinaryMessage(evt.data);
      return;
    }

    let msg: { type: string; id?: string; [key: string]: unknown };
    try {
      msg = JSON.parse(String(evt.data));
    } catch {
      return;
    }

    this.handleControlMessage(msg);
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      this.send({ type: 'ping' });
    }, this.config.pingInterval);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private cleanup(): void {
    this.stopPing();
  }

  private scheduleReconnect(): void {
    this.reconnectAttempts++;
    const delay = this.config.reconnectDelay * 2 ** (this.reconnectAttempts - 1);
    setTimeout(() => {
      if (!this.intentionalClose && !this.connected) {
        this.connect().catch(() => {
          // Reconnect failed — will retry via onclose handler
        });
      }
    }, delay);
  }
}
