/**
 * Shared assertion helpers for streaming tests.
 *
 * Both the HTTP streaming and WebSocket test suites verify the same
 * `StreamChunk` sequence contract — these helpers centralize the shape
 * assertions so the two suites can't drift.
 */
import type { StreamChunk } from '@responsivevoice/types';
import { expect } from 'vitest';

/**
 * Assert that `chunks` contains the canonical
 * `metadata → audio[] → end` sequence for two fixed audio chunks
 * `[1, 2, 3]` and `[4, 5, 6]` totalling 6 bytes.
 */
export function expectCanonicalAudioStream(chunks: StreamChunk[]): void {
  expect(chunks).toHaveLength(4);
  expect(chunks[0]).toEqual({ type: 'metadata', contentType: 'audio/mpeg', prosodyApplied: [] });
  expect(chunks[1]).toEqual({ type: 'audio', data: new Uint8Array([1, 2, 3]), chunkIndex: 0 });
  expect(chunks[2]).toEqual({ type: 'audio', data: new Uint8Array([4, 5, 6]), chunkIndex: 1 });
  expect(chunks[3]).toEqual({ type: 'end', totalBytes: 6, totalChunks: 2 });
}

/**
 * Assert that `chunk` is an error chunk with the expected retryable flag and
 * optional message constraints. Narrows the chunk type so callers don't need
 * to repeat the `if (chunk.type === 'error')` guard.
 */
export function expectErrorChunk(
  chunk: StreamChunk,
  expected: { retryable?: boolean; message?: string; messageContains?: string } = {}
): void {
  expect(chunk.type).toBe('error');
  if (chunk.type !== 'error') return;
  if (expected.retryable !== undefined) {
    expect(chunk.retryable).toBe(expected.retryable);
  }
  if (expected.message !== undefined) {
    expect(chunk.message).toBe(expected.message);
  }
  if (expected.messageContains !== undefined) {
    expect(chunk.message).toContain(expected.messageContains);
  }
}
