import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResponsiveVoiceAPIClient } from '../client';

/**
 * Create a mock fetch that returns a response with optional X-Server-URL header
 */
function createMockFetch(
  body: unknown,
  headers?: Record<string, string>,
  status = 200
): typeof fetch {
  return vi.fn(async () => {
    return new Response(JSON.stringify(body), {
      status,
      statusText: 'OK',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
    });
  }) as unknown as typeof fetch;
}

describe('X-Server-URL header handling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should not change baseUrl when no X-Server-URL header is present', async () => {
    const mockFetch = createMockFetch({ voices: [], count: 0 });
    const client = new ResponsiveVoiceAPIClient({
      apiKey: 'test-key',
      baseUrl: 'https://texttospeech.responsivevoice.org/v2',
      fetch: mockFetch,
      voiceCache: { enabled: false },
    });

    await client.getVoices();
    expect(client.baseUrl).toBe('https://texttospeech.responsivevoice.org/v2');
  });

  it('should update baseUrl when X-Server-URL header is present and different', async () => {
    const mockFetch = createMockFetch(
      { voices: [], count: 0 },
      { 'X-Server-URL': 'tts-pro1.responsivevoice.org' }
    );
    const client = new ResponsiveVoiceAPIClient({
      apiKey: 'test-key',
      baseUrl: 'https://texttospeech.responsivevoice.org/v2',
      fetch: mockFetch,
      voiceCache: { enabled: false },
    });

    await client.getVoices();
    expect(client.baseUrl).toBe('https://tts-pro1.responsivevoice.org/v2');
  });

  it('should invoke onServerUrlChange callback when baseUrl changes', async () => {
    const onServerUrlChange = vi.fn();
    const mockFetch = createMockFetch(
      { voices: [], count: 0 },
      { 'X-Server-URL': 'tts-pro1.responsivevoice.org' }
    );
    const client = new ResponsiveVoiceAPIClient({
      apiKey: 'test-key',
      baseUrl: 'https://texttospeech.responsivevoice.org/v2',
      fetch: mockFetch,
      onServerUrlChange,
      voiceCache: { enabled: false },
    });

    await client.getVoices();
    expect(onServerUrlChange).toHaveBeenCalledWith('https://tts-pro1.responsivevoice.org/v2');
  });

  it('should NOT invoke callback when header matches current baseUrl', async () => {
    const onServerUrlChange = vi.fn();
    const mockFetch = createMockFetch(
      { voices: [], count: 0 },
      { 'X-Server-URL': 'texttospeech.responsivevoice.org' }
    );
    const client = new ResponsiveVoiceAPIClient({
      apiKey: 'test-key',
      baseUrl: 'https://texttospeech.responsivevoice.org/v2',
      fetch: mockFetch,
      onServerUrlChange,
      voiceCache: { enabled: false },
    });

    await client.getVoices();
    expect(onServerUrlChange).not.toHaveBeenCalled();
  });

  it('should use updated baseUrl for subsequent requests', async () => {
    let callCount = 0;
    const mockFetch = vi.fn(async (_url: string | URL | Request) => {
      callCount++;
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      // First call: return a redirect header
      if (callCount === 1) {
        headers['X-Server-URL'] = 'tts-pro1.responsivevoice.org';
      }
      return new Response(JSON.stringify({ voices: [], count: 0 }), {
        status: 200,
        statusText: 'OK',
        headers,
      });
    }) as unknown as typeof fetch;

    const client = new ResponsiveVoiceAPIClient({
      apiKey: 'test-key',
      baseUrl: 'https://texttospeech.responsivevoice.org/v2',
      fetch: mockFetch,
      voiceCache: { enabled: false },
    });

    // First request updates the baseUrl
    await client.getVoices();
    expect(client.baseUrl).toBe('https://tts-pro1.responsivevoice.org/v2');

    // Second request should use the new baseUrl
    await client.getVoices();
    const secondCallUrl = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[1][0] as string;
    expect(secondCallUrl).toContain('tts-pro1.responsivevoice.org');
  });

  it('should preserve protocol from original baseUrl', async () => {
    const mockFetch = createMockFetch(
      { voices: [], count: 0 },
      { 'X-Server-URL': 'tts-pro1.responsivevoice.org' }
    );
    const client = new ResponsiveVoiceAPIClient({
      apiKey: 'test-key',
      baseUrl: 'http://localhost:3000/v2',
      fetch: mockFetch,
      voiceCache: { enabled: false },
    });

    await client.getVoices();
    expect(client.baseUrl).toBe('http://tts-pro1.responsivevoice.org/v2');
  });

  describe('updateBaseUrl()', () => {
    it('should update the baseUrl when called directly', () => {
      const mockFetch = vi.fn() as unknown as typeof fetch;
      const client = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        baseUrl: 'https://texttospeech.responsivevoice.org/v2',
        fetch: mockFetch,
        voiceCache: { enabled: false },
      });

      client.updateBaseUrl('https://tts-pro1.responsivevoice.org/v2');
      expect(client.baseUrl).toBe('https://tts-pro1.responsivevoice.org/v2');
    });
  });

  describe('baseUrl getter', () => {
    it('should return current base URL', () => {
      const mockFetch = vi.fn() as unknown as typeof fetch;
      const client = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        baseUrl: 'https://custom.example.com/v2',
        fetch: mockFetch,
        voiceCache: { enabled: false },
      });

      expect(client.baseUrl).toBe('https://custom.example.com/v2');
    });
  });
});
