/**
 * Tests for WebSocketConnection
 */
import type { StreamChunk } from '@responsivevoice/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketConnection } from '../websocket';
import { expectCanonicalAudioStream } from './assertions';

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

type WSHandler = ((evt: MessageEvent) => void) | null;

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  binaryType = 'blob';
  url: string;

  onopen: ((evt: Event) => void) | null = null;
  onclose: ((evt: CloseEvent) => void) | null = null;
  onerror: ((evt: Event) => void) | null = null;
  onmessage: WSHandler = null;

  private _sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    // Auto-open after microtask (simulates real WebSocket)
    queueMicrotask(() => {
      if (this.readyState === MockWebSocket.CONNECTING) {
        this.readyState = MockWebSocket.OPEN;
        this.onopen?.(new Event('open'));
      }
    });
  }

  send(data: string): void {
    this._sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close', { code: code ?? 1000, reason }));
  }

  // Test helpers
  get sentMessages(): Array<Record<string, unknown>> {
    return this._sent.map((s) => JSON.parse(s));
  }

  simulateMessage(data: string | ArrayBuffer): void {
    this.onmessage?.(new MessageEvent('message', { data }));
  }

  simulateClose(code = 1006, reason = ''): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close', { code, reason }));
  }

  simulateError(): void {
    this.onerror?.(new Event('error'));
  }
}

/**
 * A MockWebSocket subclass that fires `onerror` instead of `onopen` on connect.
 * Used by tests that verify connection-failure handling.
 */
class ErroringMockWebSocket extends MockWebSocket {
  constructor(url: string) {
    super(url);
    // Prevent the parent's queued onopen microtask from firing by leaving
    // readyState at CONNECTING and emitting onerror first.
    this.readyState = MockWebSocket.CLOSED;
    queueMicrotask(() => {
      this.onerror?.(new Event('error'));
    });
  }
}

/**
 * Simulates how a browser surfaces a REJECTED upgrade handshake (e.g. an edge
 * HTTP 429): an `error` event followed by an abnormal close (code 1006). The
 * W3C WebSocket API never exposes the HTTP status, so the client cannot tell a
 * 429 from a network failure.
 */
class HandshakeRejectMockWebSocket extends MockWebSocket {
  constructor(url: string) {
    super(url);
    this.readyState = MockWebSocket.CLOSED;
    queueMicrotask(() => {
      this.onerror?.(new Event('error'));
      this.onclose?.(new CloseEvent('close', { code: 1006, reason: '' }));
    });
  }
}

/**
 * Stub the global WebSocket with a handshake-rejecting mock and return the
 * array that captures every constructed instance (one per upgrade attempt).
 */
function stubHandshakeRejectWebSocket(): HandshakeRejectMockWebSocket[] {
  const instances: HandshakeRejectMockWebSocket[] = [];
  vi.stubGlobal(
    'WebSocket',
    class extends HandshakeRejectMockWebSocket {
      constructor(url: string) {
        super(url);
        instances.push(this);
      }
    }
  );
  return instances;
}

// Build a binary audio frame matching server protocol
function buildTestBinaryFrame(
  requestId: string,
  chunkIndex: number,
  audio: Uint8Array
): ArrayBuffer {
  const header = new ArrayBuffer(41);
  const view = new DataView(header);
  view.setUint8(0, 0x01); // BINARY_FRAME_TYPE_AUDIO
  const encoder = new TextEncoder();
  const idBytes = encoder.encode(requestId.slice(0, 36));
  new Uint8Array(header, 1, 36).set(idBytes);
  view.setUint32(37, chunkIndex, false); // big-endian

  const frame = new Uint8Array(41 + audio.byteLength);
  frame.set(new Uint8Array(header), 0);
  frame.set(audio, 41);
  return frame.buffer;
}

// Patch global WebSocket
let mockWsInstances: MockWebSocket[] = [];

beforeEach(() => {
  mockWsInstances = [];
  vi.stubGlobal(
    'WebSocket',
    Object.assign(
      class extends MockWebSocket {
        constructor(url: string) {
          super(url);
          mockWsInstances.push(this);
        }
      },
      { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 }
    )
  );
  // crypto.getRandomValues is natively available in the test environment
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('WebSocketConnection', () => {
  describe('connect', () => {
    it('should open a WebSocket connection', async () => {
      const conn = new WebSocketConnection({
        baseUrl: 'https://tts.example.com',
        apiKey: 'test-key',
      });

      await conn.connect();

      expect(conn.connected).toBe(true);
      expect(mockWsInstances[0].url).toContain('wss://tts.example.com');
      expect(mockWsInstances[0].url).toContain('key=test-key');
    });

    it('should append token query param when getAuthToken resolves a bearer', async () => {
      const conn = new WebSocketConnection({
        baseUrl: 'https://tts.example.com',
        apiKey: 'test-key',
        getAuthToken: () => Promise.resolve('jwt.header.sig'),
      });

      await conn.connect();

      expect(mockWsInstances[0].url).toContain('key=test-key');
      expect(mockWsInstances[0].url).toContain('token=jwt.header.sig');
    });

    it('should omit token query param when getAuthToken resolves undefined', async () => {
      const conn = new WebSocketConnection({
        baseUrl: 'https://tts.example.com',
        apiKey: 'test-key',
        getAuthToken: () => Promise.resolve(undefined),
      });

      await conn.connect();

      expect(mockWsInstances[0].url).toContain('key=test-key');
      expect(mockWsInstances[0].url).not.toContain('token=');
    });

    it('should re-resolve the token on each connect (fresh per upgrade)', async () => {
      const tokens = ['first.jwt.sig', 'second.jwt.sig'];
      const conn = new WebSocketConnection({
        baseUrl: 'https://tts.example.com',
        apiKey: 'test-key',
        getAuthToken: () => Promise.resolve(tokens.shift()),
      });

      await conn.connect();
      conn.close();
      await conn.connect();

      expect(mockWsInstances[0].url).toContain('token=first.jwt.sig');
      expect(mockWsInstances[1].url).toContain('token=second.jwt.sig');
    });

    it('should convert http to ws protocol', async () => {
      const conn = new WebSocketConnection({
        baseUrl: 'http://localhost:3000',
      });

      await conn.connect();

      expect(mockWsInstances[0].url).toContain('ws://localhost:3000');
    });

    it('should reject on connection error', async () => {
      vi.stubGlobal('WebSocket', ErroringMockWebSocket);

      const conn = new WebSocketConnection({
        baseUrl: 'https://tts.example.com',
        autoReconnect: false,
      });

      await expect(conn.connect()).rejects.toThrow('WebSocket connection failed');
    });

    it('should not create duplicate connections', async () => {
      const conn = new WebSocketConnection({
        baseUrl: 'https://tts.example.com',
      });

      await conn.connect();
      await conn.connect(); // Second call should be a no-op

      expect(mockWsInstances).toHaveLength(1);
    });
  });

  describe('synthesizeStream', () => {
    it('should send a synthesize message and yield chunks', async () => {
      const conn = new WebSocketConnection({
        baseUrl: 'https://tts.example.com',
        apiKey: 'key',
      });
      await conn.connect();

      const ws = mockWsInstances[0];
      const chunks: StreamChunk[] = [];

      // Start consuming the stream
      const streamPromise = (async () => {
        for await (const chunk of conn.synthesizeStream({ text: 'Hello', lang: 'en-US' })) {
          chunks.push(chunk);
        }
      })();

      // Wait for the synthesize message to be sent
      await new Promise((r) => setTimeout(r, 10));

      // Extract the request ID from the sent message
      const sentMsg = ws.sentMessages.find((m) => m.type === 'synthesize');
      expect(sentMsg).toBeDefined();
      const requestId = sentMsg!.id as string;

      // Simulate server responses
      ws.simulateMessage(
        JSON.stringify({
          type: 'stream_start',
          id: requestId,
          contentType: 'audio/mpeg',
          provider: 'oai',
          voice: 'alloy',
        })
      );
      ws.simulateMessage(buildTestBinaryFrame(requestId, 0, new Uint8Array([1, 2, 3])));
      ws.simulateMessage(buildTestBinaryFrame(requestId, 1, new Uint8Array([4, 5, 6])));
      ws.simulateMessage(
        JSON.stringify({
          type: 'stream_end',
          id: requestId,
          totalBytes: 6,
          totalChunks: 2,
          durationMs: 100,
        })
      );

      await streamPromise;

      expectCanonicalAudioStream(chunks);
    });

    it('should yield error chunk on server error', async () => {
      const conn = new WebSocketConnection({
        baseUrl: 'https://tts.example.com',
        autoReconnect: false,
      });
      await conn.connect();

      const ws = mockWsInstances[0];

      const streamPromise = (async () => {
        const chunks: StreamChunk[] = [];
        try {
          for await (const chunk of conn.synthesizeStream({ text: 'Hello', lang: 'en-US' })) {
            chunks.push(chunk);
          }
        } catch {
          // Expected
        }
        return chunks;
      })();

      await new Promise((r) => setTimeout(r, 10));
      const sentMsg = ws.sentMessages.find((m) => m.type === 'synthesize');
      const requestId = sentMsg!.id as string;

      ws.simulateMessage(
        JSON.stringify({
          type: 'error',
          id: requestId,
          code: 'RATE_LIMIT',
          message: 'Too many requests',
          retryable: true,
        })
      );

      const chunks = await streamPromise;

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual({ type: 'error', message: 'Too many requests', retryable: true });
    });

    it('should auto-connect if not connected', async () => {
      const conn = new WebSocketConnection({
        baseUrl: 'https://tts.example.com',
      });

      // Don't call connect() explicitly — start consuming the generator
      const chunks: StreamChunk[] = [];
      const streamPromise = (async () => {
        for await (const chunk of conn.synthesizeStream({ text: 'Hello', lang: 'en-US' })) {
          chunks.push(chunk);
        }
      })();

      // Wait for auto-connect + synthesize message
      await new Promise((r) => setTimeout(r, 20));

      expect(conn.connected).toBe(true);

      // Clean up — send stream_end so the generator finishes
      const ws = mockWsInstances[0];
      const sentMsg = ws.sentMessages.find((m) => m.type === 'synthesize');
      ws.simulateMessage(
        JSON.stringify({
          type: 'stream_end',
          id: sentMsg!.id,
          totalBytes: 0,
          totalChunks: 0,
          durationMs: 0,
        })
      );

      await streamPromise;
    });
  });

  describe('close', () => {
    it('should close the WebSocket and reject pending requests', async () => {
      const conn = new WebSocketConnection({
        baseUrl: 'https://tts.example.com',
        autoReconnect: false,
      });
      await conn.connect();

      let streamError: Error | null = null;
      const streamPromise = (async () => {
        try {
          for await (const _ of conn.synthesizeStream({ text: 'Hello', lang: 'en-US' })) {
            // consume
          }
        } catch (err) {
          streamError = err as Error;
        }
      })();

      await new Promise((r) => setTimeout(r, 10));

      conn.close();
      await streamPromise;

      expect(conn.connected).toBe(false);
      expect(streamError?.message).toContain('closed by client');
    });
  });

  describe('reconnect', () => {
    it('resolves a fresh token on auto-reconnect after an unexpected close', async () => {
      const tokens = ['first.jwt.sig', 'second.jwt.sig'];
      const conn = new WebSocketConnection({
        baseUrl: 'https://tts.example.com',
        apiKey: 'test-key',
        getAuthToken: () => Promise.resolve(tokens.shift()),
        reconnectDelay: 5,
      });

      await conn.connect();
      expect(mockWsInstances[0].url).toContain('token=first.jwt.sig');

      // Unexpected close (not via conn.close()) triggers auto-reconnect.
      mockWsInstances[0].simulateClose(1006);

      await vi.waitFor(() => {
        expect(mockWsInstances.length).toBe(2);
      });
      expect(mockWsInstances[1].url).toContain('token=second.jwt.sig');

      conn.close();
    });

    it('blind-reconnects a rejected handshake up to maxReconnectAttempts (edge 429 is status-invisible)', async () => {
      const instances = stubHandshakeRejectWebSocket();

      const conn = new WebSocketConnection({
        baseUrl: 'https://tts.example.com',
        apiKey: 'k',
        autoReconnect: true,
        maxReconnectAttempts: 3,
        reconnectDelay: 1,
      });

      // The upgrade is rejected; connect() rejects with a generic failure — the
      // 429 status is never surfaced (status-invisible at the handshake layer).
      await expect(conn.connect()).rejects.toThrow('WebSocket connection failed');

      // Initial attempt + exactly maxReconnectAttempts blind retries, then it stops.
      await vi.waitFor(() => expect(instances.length).toBe(4));
      await new Promise((r) => setTimeout(r, 20));
      expect(instances.length).toBe(4);

      conn.close();
    });

    it('does not reconnect a rejected handshake when autoReconnect is off (reconnect is the sole retry lever)', async () => {
      const instances = stubHandshakeRejectWebSocket();

      const conn = new WebSocketConnection({
        baseUrl: 'https://tts.example.com',
        autoReconnect: false,
      });

      await expect(conn.connect()).rejects.toThrow('WebSocket connection failed');
      await new Promise((r) => setTimeout(r, 20));

      // No rate-limit-driven retry exists on the WS path; autoReconnect is the
      // only lever, and it is off — so exactly one upgrade attempt was made.
      expect(instances.length).toBe(1);
    });
  });

  describe('ping/pong', () => {
    it('should send periodic pings', async () => {
      vi.useFakeTimers();

      const conn = new WebSocketConnection({
        baseUrl: 'https://tts.example.com',
        pingInterval: 1000,
      });

      await conn.connect();
      const ws = mockWsInstances[0];

      vi.advanceTimersByTime(3500);

      const pings = ws.sentMessages.filter((m) => m.type === 'ping');
      expect(pings.length).toBe(3);

      conn.close();
      vi.useRealTimers();
    });
  });
});
