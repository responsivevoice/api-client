/**
 * Tests for ResponsiveVoiceAPIClient.synthesizeStream()
 */
import type { StreamChunk, SynthesizeRequest } from '@responsivevoice/types';
import { describe, expect, it, vi } from 'vitest';
import { ResponsiveVoiceAPIClient } from '../client';
import { expectCanonicalAudioStream, expectErrorChunk } from './assertions';

// ============================================================================
// Test Utilities
// ============================================================================

/**
 * Create a ReadableStream from an array of Uint8Array chunks
 */
function createMockReadableStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index++]);
      } else {
        controller.close();
      }
    },
  });
}

/**
 * Create a mock streaming Response
 */
function createStreamingResponse(
  chunks: Uint8Array[],
  contentType = 'audio/mpeg',
  status = 200
): Response {
  return new Response(createMockReadableStream(chunks), {
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: {
      'Content-Type': contentType,
      'Transfer-Encoding': 'chunked',
    },
  });
}

/**
 * Collect all chunks from an async generator
 */
async function collectChunks(gen: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of gen) {
    chunks.push(chunk);
  }
  return chunks;
}

/**
 * Create a client with a mock fetch
 */
function createClient(fetchFn: typeof fetch): ResponsiveVoiceAPIClient {
  return new ResponsiveVoiceAPIClient({
    apiKey: 'test-key',
    baseUrl: 'https://tts.example.com/v2',
    fetch: fetchFn,
  });
}

/**
 * Run a streaming synthesize call against a mock fetch and return all chunks.
 * Defaults to `{ text: 'Hello', lang: 'en-US' }` — override via `request`.
 */
async function runStream(
  mockFetch: ReturnType<typeof vi.fn>,
  request: Partial<SynthesizeRequest> = {},
  options?: { timeout?: number; signal?: AbortSignal }
): Promise<StreamChunk[]> {
  const client = createClient(mockFetch as unknown as typeof fetch);
  return collectChunks(
    client.synthesizeStream({ text: 'Hello', lang: 'en-US', ...request }, options)
  );
}

// ============================================================================
// Tests
// ============================================================================

describe('ResponsiveVoiceAPIClient.synthesizeStream', () => {
  it('should yield metadata, audio chunks, and end in order', async () => {
    const audioChunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])];

    const mockFetch = vi.fn().mockResolvedValue(createStreamingResponse(audioChunks));
    const chunks = await runStream(mockFetch);

    expectCanonicalAudioStream(chunks);
  });

  it('should send Accept: text/event-stream header', async () => {
    const mockFetch = vi.fn().mockResolvedValue(createStreamingResponse([]));
    await runStream(mockFetch, { engine: 'oai' });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers.Accept).toBe('text/event-stream');
    const body = JSON.parse(init.body);
    expect(body.text).toBe('Hello');
    expect(body.lang).toBe('en-US');
    expect(body.engine).toBe('oai');
  });

  it('should extract content type from response headers', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(createStreamingResponse([new Uint8Array([1])], 'audio/ogg'));
    const chunks = await runStream(mockFetch);

    expect(chunks[0]).toEqual({ type: 'metadata', contentType: 'audio/ogg', prosodyApplied: [] });
  });

  it('should yield error on non-OK HTTP response', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'Streaming not enabled' }), {
        status: 403,
        statusText: 'Forbidden',
        headers: { 'Content-Type': 'application/json' },
      })
    );
    const chunks = await runStream(mockFetch);

    expect(chunks).toHaveLength(1);
    expectErrorChunk(chunks[0], { retryable: false });
  });

  it('should yield error on server error (retryable)', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('Internal Server Error', {
        status: 502,
        statusText: 'Bad Gateway',
        headers: { 'Content-Type': 'text/plain' },
      })
    );
    const chunks = await runStream(mockFetch);

    expect(chunks).toHaveLength(1);
    expectErrorChunk(chunks[0], { retryable: true });
  });

  it('should yield error when response body is null', async () => {
    // Simulate an environment where response.body is not available
    const mockResponse = new Response(null, {
      status: 200,
      headers: { 'Content-Type': 'audio/mpeg' },
    });
    // Override body to null
    Object.defineProperty(mockResponse, 'body', { value: null });

    const mockFetch = vi.fn().mockResolvedValue(mockResponse);
    const chunks = await runStream(mockFetch);

    // metadata then error
    expect(chunks).toHaveLength(2);
    expect(chunks[0].type).toBe('metadata');
    expectErrorChunk(chunks[1], { retryable: false, messageContains: 'not readable' });
  });

  it('should yield error on fetch network failure', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const chunks = await runStream(mockFetch);

    expect(chunks).toHaveLength(1);
    expectErrorChunk(chunks[0], { retryable: true, message: 'Failed to fetch' });
  });

  it('should yield error on abort/timeout', async () => {
    const abortError = new DOMException('The operation was aborted.', 'AbortError');
    const mockFetch = vi.fn().mockRejectedValue(abortError);
    const chunks = await runStream(mockFetch, {}, { timeout: 5000 });

    expect(chunks).toHaveLength(1);
    expectErrorChunk(chunks[0], { retryable: true, messageContains: 'timed out' });
  });

  it('should support external AbortSignal', async () => {
    const externalController = new AbortController();
    // Abort immediately
    externalController.abort();

    const abortError = new DOMException('The operation was aborted.', 'AbortError');
    const mockFetch = vi.fn().mockRejectedValue(abortError);
    const chunks = await runStream(mockFetch, {}, { signal: externalController.signal });

    expect(chunks).toHaveLength(1);
    expectErrorChunk(chunks[0]);
  });

  it('should track totalBytes and totalChunks correctly', async () => {
    const audioChunks = [new Uint8Array(1024), new Uint8Array(2048), new Uint8Array(512)];

    const mockFetch = vi.fn().mockResolvedValue(createStreamingResponse(audioChunks));
    const chunks = await runStream(mockFetch);

    const endChunk = chunks.find((c) => c.type === 'end');
    expect(endChunk).toBeDefined();
    if (endChunk?.type === 'end') {
      expect(endChunk.totalBytes).toBe(1024 + 2048 + 512);
      expect(endChunk.totalChunks).toBe(3);
    }
  });

  it('should handle empty stream (no audio chunks)', async () => {
    const mockFetch = vi.fn().mockResolvedValue(createStreamingResponse([]));
    const chunks = await runStream(mockFetch, { text: '' });

    expect(chunks).toHaveLength(2); // metadata + end
    expect(chunks[0].type).toBe('metadata');
    expect(chunks[1]).toEqual({ type: 'end', totalBytes: 0, totalChunks: 0 });
  });

  it('should default content type to audio/mpeg when header is missing', async () => {
    const response = new Response(createMockReadableStream([]), {
      status: 200,
      headers: {},
    });
    const mockFetch = vi.fn().mockResolvedValue(response);
    const chunks = await runStream(mockFetch);

    expect(chunks[0]).toEqual({ type: 'metadata', contentType: 'audio/mpeg', prosodyApplied: [] });
  });
});
