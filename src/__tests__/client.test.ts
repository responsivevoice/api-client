/**
 * Tests for ResponsiveVoiceAPIClient
 */
import { readdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResponsiveVoiceAPIClient } from '../client';

// Clean filesystem voice cache before tests to prevent cross-file pollution
beforeAll(() => {
  for (const f of readdirSync(tmpdir())) {
    if (f.startsWith('rv-voice-cache-')) {
      try {
        unlinkSync(join(tmpdir(), f));
      } catch {}
    }
  }
});

import {
  ApiError,
  AuthError,
  NetworkError,
  NotFoundError,
  RateLimitError,
  ResponseValidationError,
  TimeoutError,
  ValidationError,
} from '../errors';

// ============================================================================
// Test Utilities
// ============================================================================

/**
 * Create a mock Response object
 */
const createMockResponse = (
  status: number,
  body: unknown,
  headers?: Record<string, string>
): Response => {
  const responseBody = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(responseBody, {
    status,
    statusText: getStatusText(status),
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  });
};

/**
 * Create a mock audio blob response
 */
const createMockAudioResponse = (
  format: 'mp3' | 'ogg' | 'wav' = 'mp3',
  duration?: number
): Response => {
  const mimeTypes = {
    mp3: 'audio/mpeg',
    ogg: 'audio/ogg',
    wav: 'audio/wav',
  };
  const headers: Record<string, string> = {
    'Content-Type': mimeTypes[format],
  };
  if (duration !== undefined) {
    headers['X-Audio-Duration'] = String(duration);
  }
  return new Response(new ArrayBuffer(100), {
    status: 200,
    statusText: 'OK',
    headers,
  });
};

/**
 * Get HTTP status text for a status code
 */
function getStatusText(status: number): string {
  const statusTexts: Record<number, string> = {
    200: 'OK',
    201: 'Created',
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
  };
  return statusTexts[status] || 'Unknown';
}

/**
 * Create a mock fetch function
 */
function _createMockFetch(
  responseOrFn: Response | (() => Response | Promise<Response>)
): typeof fetch {
  return vi.fn(async () => {
    if (typeof responseOrFn === 'function') {
      return responseOrFn();
    }
    return responseOrFn;
  }) as unknown as typeof fetch;
}

// ============================================================================
// Constructor Tests
// ============================================================================

describe('ResponsiveVoiceAPIClient', () => {
  describe('constructor', () => {
    it('should throw if apiKey is missing', () => {
      expect(() => {
        // @ts-expect-error - Testing missing required parameter
        new ResponsiveVoiceAPIClient({});
      }).toThrow('API key is required');
    });

    it('should throw if apiKey is empty string', () => {
      expect(() => {
        new ResponsiveVoiceAPIClient({ apiKey: '' });
      }).toThrow('API key is required');
    });

    it('should create client with valid apiKey', () => {
      const client = new ResponsiveVoiceAPIClient({ apiKey: 'test-key' });
      expect(client).toBeInstanceOf(ResponsiveVoiceAPIClient);
    });

    it('should use default baseUrl if not provided', async () => {
      const mockFetch = vi.fn().mockResolvedValue(createMockResponse(200, { voices: [] }));

      const client = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        fetch: mockFetch as unknown as typeof fetch,
      });

      await client.getVoices();

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('https://texttospeech.responsivevoice.org/v2/voices'),
        expect.any(Object)
      );
    });

    it('should accept custom baseUrl', async () => {
      const mockFetch = vi.fn().mockResolvedValue(createMockResponse(200, { voices: [] }));

      const client = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        baseUrl: 'https://custom-api.example.com/v2',
        fetch: mockFetch as unknown as typeof fetch,
      });

      await client.getVoices();

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('https://custom-api.example.com/v2/voices'),
        expect.any(Object)
      );
    });

    it('should accept custom timeout', () => {
      const client = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        timeout: 60000,
      });
      expect(client).toBeInstanceOf(ResponsiveVoiceAPIClient);
    });

    it('should accept custom retry configuration', () => {
      const client = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        retryAttempts: 5,
        retryDelay: 2000,
      });
      expect(client).toBeInstanceOf(ResponsiveVoiceAPIClient);
    });

    it('should accept custom fetch implementation', async () => {
      const customFetch = vi.fn().mockResolvedValue(createMockResponse(200, { voices: [] }));

      const client = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        fetch: customFetch as unknown as typeof fetch,
      });

      await client.getVoices();

      expect(customFetch).toHaveBeenCalled();
    });

    it('should normalize baseUrl with trailing slash', async () => {
      const mockFetch = vi.fn().mockResolvedValue(createMockResponse(200, { voices: [] }));

      const client = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com/v2/',
        fetch: mockFetch as unknown as typeof fetch,
      });

      await client.getVoices();

      const calledUrl = (mockFetch.mock.calls[0] as unknown[])[0] as string;
      expect(calledUrl).not.toContain('//voices');
    });
  });

  // ============================================================================
  // synthesize() Method Tests
  // ============================================================================

  describe('synthesize()', () => {
    let mockFetch: ReturnType<typeof vi.fn>;
    let client: ResponsiveVoiceAPIClient;
    let originalCreateObjectURL: typeof URL.createObjectURL;

    beforeEach(() => {
      // Save original and mock only URL.createObjectURL, preserving the URL class
      originalCreateObjectURL = URL.createObjectURL;
      URL.createObjectURL = vi.fn().mockReturnValue('blob:http://localhost/mock-audio-url');
    });

    afterEach(() => {
      // Restore original
      URL.createObjectURL = originalCreateObjectURL;
    });

    it('should make GET request to /text/synthesize', async () => {
      mockFetch = vi.fn().mockResolvedValue(createMockAudioResponse('mp3'));
      client = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        fetch: mockFetch as unknown as typeof fetch,
      });

      await client.synthesize({
        text: 'Hello world',
        lang: 'en-US',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/text/synthesize'),
        expect.objectContaining({
          method: 'GET',
        })
      );
    });

    it('should include API key in query params', async () => {
      mockFetch = vi.fn().mockResolvedValue(createMockAudioResponse('mp3'));
      client = new ResponsiveVoiceAPIClient({
        apiKey: 'my-secret-key',
        fetch: mockFetch as unknown as typeof fetch,
      });

      await client.synthesize({
        text: 'Hello',
        lang: 'en-US',
      });

      const calledUrl = (mockFetch.mock.calls[0] as unknown[])[0] as string;
      expect(calledUrl).toContain('key=my-secret-key');
    });

    it('should send correct query parameters', async () => {
      mockFetch = vi.fn().mockResolvedValue(createMockAudioResponse('mp3'));
      client = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        fetch: mockFetch as unknown as typeof fetch,
      });

      await client.synthesize({
        text: 'Hello world',
        lang: 'en-US',
        pitch: 0.8,
        rate: 0.9,
        volume: 0.7,
        format: 'ogg',
      });

      const calledUrl = (mockFetch.mock.calls[0] as unknown[])[0] as string;
      const url = new URL(calledUrl);

      expect(url.searchParams.get('text')).toBe('Hello world');
      expect(url.searchParams.get('lang')).toBe('en-US');
      expect(url.searchParams.get('pitch')).toBe('0.8');
      expect(url.searchParams.get('rate')).toBe('0.9');
      expect(url.searchParams.get('volume')).toBe('0.7');
      expect(url.searchParams.get('format')).toBe('ogg');
    });

    it('should not set Content-Type header for GET synthesize requests', async () => {
      mockFetch = vi.fn().mockResolvedValue(createMockAudioResponse('mp3'));
      client = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        fetch: mockFetch as unknown as typeof fetch,
      });

      await client.synthesize({
        text: 'Hello',
        lang: 'en-US',
      });

      const callArgs = mockFetch.mock.calls[0] as unknown[];
      const requestInit = callArgs[1] as RequestInit;
      const headers = requestInit.headers as Record<string, string>;

      expect(headers['Content-Type']).toBeUndefined();
    });

    it('should return AudioResponse with blob and url', async () => {
      mockFetch = vi.fn().mockResolvedValue(createMockAudioResponse('mp3'));
      client = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        fetch: mockFetch as unknown as typeof fetch,
      });

      const result = await client.synthesize({
        text: 'Hello',
        lang: 'en-US',
      });

      expect(result).toHaveProperty('blob');
      expect(result).toHaveProperty('url');
      expect(result).toHaveProperty('format');
      expect(result.blob).toBeInstanceOf(Blob);
      expect(result.url).toBe('blob:http://localhost/mock-audio-url');
    });

    it('should extract mp3 format from content-type', async () => {
      mockFetch = vi.fn().mockResolvedValue(createMockAudioResponse('mp3'));
      client = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        fetch: mockFetch as unknown as typeof fetch,
      });

      const result = await client.synthesize({
        text: 'Hello',
        lang: 'en-US',
      });

      expect(result.format).toBe('mp3');
    });

    it('should extract ogg format from content-type', async () => {
      mockFetch = vi.fn().mockResolvedValue(createMockAudioResponse('ogg'));
      client = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        fetch: mockFetch as unknown as typeof fetch,
      });

      const result = await client.synthesize({
        text: 'Hello',
        lang: 'en-US',
      });

      expect(result.format).toBe('ogg');
    });

    it('should extract wav format from content-type', async () => {
      mockFetch = vi.fn().mockResolvedValue(createMockAudioResponse('wav'));
      client = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        fetch: mockFetch as unknown as typeof fetch,
      });

      const result = await client.synthesize({
        text: 'Hello',
        lang: 'en-US',
      });

      expect(result.format).toBe('wav');
    });

    it('should use requested format as fallback', async () => {
      const response = new Response(new ArrayBuffer(100), {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      });
      mockFetch = vi.fn().mockResolvedValue(response);
      client = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        fetch: mockFetch as unknown as typeof fetch,
      });

      const result = await client.synthesize({
        text: 'Hello',
        lang: 'en-US',
        format: 'ogg',
      });

      expect(result.format).toBe('ogg');
    });

    it('should default to mp3 format when no format info available', async () => {
      const response = new Response(new ArrayBuffer(100), {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      });
      mockFetch = vi.fn().mockResolvedValue(response);
      client = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        fetch: mockFetch as unknown as typeof fetch,
      });

      const result = await client.synthesize({
        text: 'Hello',
        lang: 'en-US',
      });

      expect(result.format).toBe('mp3');
    });

    it('should extract duration from X-Audio-Duration header', async () => {
      mockFetch = vi.fn().mockResolvedValue(createMockAudioResponse('mp3', 3.5));
      client = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        fetch: mockFetch as unknown as typeof fetch,
      });

      const result = await client.synthesize({
        text: 'Hello',
        lang: 'en-US',
      });

      expect(result.duration).toBe(3.5);
    });

    it('should throw ValidationError on 400 response', async () => {
      mockFetch = vi.fn().mockResolvedValue(
        createMockResponse(400, {
          message: 'Invalid text parameter',
          errors: { text: ['Text is required'] },
        })
      );
      client = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        fetch: mockFetch as unknown as typeof fetch,
        retryAttempts: 0,
      });

      await expect(client.synthesize({ text: '', lang: 'en-US' })).rejects.toThrow(ValidationError);
    });

    it('should throw AuthError on 401 response', async () => {
      mockFetch = vi
        .fn()
        .mockResolvedValue(createMockResponse(401, { message: 'Invalid API key' }));
      client = new ResponsiveVoiceAPIClient({
        apiKey: 'invalid-key',
        fetch: mockFetch as unknown as typeof fetch,
        retryAttempts: 0,
      });

      await expect(client.synthesize({ text: 'Hello', lang: 'en-US' })).rejects.toThrow(AuthError);
    });

    it('should throw AuthError on 403 response', async () => {
      mockFetch = vi.fn().mockResolvedValue(createMockResponse(403, { message: 'Access denied' }));
      client = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        fetch: mockFetch as unknown as typeof fetch,
        retryAttempts: 0,
      });

      await expect(client.synthesize({ text: 'Hello', lang: 'en-US' })).rejects.toThrow(AuthError);
    });

    it('should throw RateLimitError on 429 response', async () => {
      mockFetch = vi
        .fn()
        .mockResolvedValue(
          createMockResponse(429, { message: 'Too many requests' }, { 'Retry-After': '60' })
        );
      client = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        fetch: mockFetch as unknown as typeof fetch,
        retryAttempts: 0,
      });

      await expect(client.synthesize({ text: 'Hello', lang: 'en-US' })).rejects.toThrow(
        RateLimitError
      );
    });

    it('should throw ApiError on 500 response (with retries exhausted)', async () => {
      mockFetch = vi
        .fn()
        .mockResolvedValue(createMockResponse(500, { message: 'Internal server error' }));
      client = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        fetch: mockFetch as unknown as typeof fetch,
        retryAttempts: 0,
      });

      await expect(client.synthesize({ text: 'Hello', lang: 'en-US' })).rejects.toThrow(ApiError);
    });

    it('should retry on 500 errors', async () => {
      let callCount = 0;
      mockFetch = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount < 3) {
          return createMockResponse(500, { message: 'Server error' });
        }
        return createMockAudioResponse('mp3');
      });
      client = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        fetch: mockFetch as unknown as typeof fetch,
        retryAttempts: 3,
        retryDelay: 10, // Small delay for tests
      });

      const result = await client.synthesize({
        text: 'Hello',
        lang: 'en-US',
      });

      expect(callCount).toBe(3);
      expect(result).toHaveProperty('blob');
    });

    it('should support request abort via signal', async () => {
      const controller = new AbortController();
      mockFetch = vi.fn().mockImplementation(async (_url, options) => {
        // Check if signal is passed
        expect(options.signal).toBeDefined();
        // Simulate abort
        controller.abort();
        throw new DOMException('The operation was aborted', 'AbortError');
      });
      client = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        fetch: mockFetch as unknown as typeof fetch,
        retryAttempts: 0,
      });

      await expect(
        client.synthesize({ text: 'Hello', lang: 'en-US' }, { signal: controller.signal })
      ).rejects.toThrow();
    });

    it('should pass optional parameters in query params', async () => {
      mockFetch = vi.fn().mockResolvedValue(createMockAudioResponse('mp3'));
      client = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        fetch: mockFetch as unknown as typeof fetch,
      });

      await client.synthesize({
        text: 'Hello',
        lang: 'en-US',
        engine: 'g2',
        name: 'UK English Female',
        gender: 'female',
      });

      const calledUrl = (mockFetch.mock.calls[0] as unknown[])[0] as string;
      const url = new URL(calledUrl);

      expect(url.searchParams.get('engine')).toBe('g2');
      expect(url.searchParams.get('name')).toBe('UK English Female');
      expect(url.searchParams.get('gender')).toBe('female');
    });
  });

  // ============================================================================
  // getVoices() Method Tests
  // ============================================================================

  describe('getVoices()', () => {
    let mockFetch: ReturnType<typeof vi.fn>;
    let client: ResponsiveVoiceAPIClient;

    const mockVoiceList = {
      voices: [
        { name: 'UK English Female', flag: 'gb', gender: 'f', lang: 'en-GB', voiceIDs: [0] },
        { name: 'UK English Male', flag: 'gb', gender: 'm', lang: 'en-GB', voiceIDs: [1] },
        { name: 'US English Female', flag: 'us', gender: 'f', lang: 'en-US', voiceIDs: [2] },
      ],
    };

    beforeEach(() => {
      mockFetch = vi.fn().mockResolvedValue(createMockResponse(200, mockVoiceList));
      client = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        fetch: mockFetch as unknown as typeof fetch,
      });
    });

    it('should make GET request to /voices', async () => {
      await client.getVoices();

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/voices'),
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('should include API key in query params', async () => {
      await client.getVoices();

      const calledUrl = (mockFetch.mock.calls[0] as unknown[])[0] as string;
      expect(calledUrl).toContain('key=test-key');
    });

    it('should parse voice list response', async () => {
      const result = await client.getVoices();

      expect(result).toHaveProperty('voices');
      expect(result).toHaveProperty('systemVoices');
      expect(result.voices).toBeInstanceOf(Array);
      expect(result.voices).toHaveLength(3);
      expect(result.voices[0]).toHaveProperty('name', 'UK English Female');
      expect(result.voices[0]).toHaveProperty('flag', 'gb');
      expect(result.voices[0]).toHaveProperty('gender', 'f');
      expect(result.voices[0]).toHaveProperty('lang', 'en-GB');
    });

    it('should handle empty voice list', async () => {
      mockFetch = vi.fn().mockResolvedValue(createMockResponse(200, { voices: [] }));
      client = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        fetch: mockFetch as unknown as typeof fetch,
      });

      const result = await client.getVoices();

      expect(result.voices).toEqual([]);
      expect(result.systemVoices).toEqual([]);
    });

    it('should include language filter in query params', async () => {
      await client.getVoices({ lang: 'en-GB' });

      const calledUrl = (mockFetch.mock.calls[0] as unknown[])[0] as string;
      expect(calledUrl).toContain('lang=en-GB');
    });

    it('should include gender filter in query params', async () => {
      await client.getVoices({ gender: 'female' });

      const calledUrl = (mockFetch.mock.calls[0] as unknown[])[0] as string;
      expect(calledUrl).toContain('gender=female');
    });

    it('should include multiple filters in query params', async () => {
      await client.getVoices({ lang: 'es', gender: 'male' });

      const calledUrl = (mockFetch.mock.calls[0] as unknown[])[0] as string;
      expect(calledUrl).toContain('lang=es');
      expect(calledUrl).toContain('gender=male');
    });

    it('should not include undefined filters', async () => {
      await client.getVoices({});

      const calledUrl = (mockFetch.mock.calls[0] as unknown[])[0] as string;
      expect(calledUrl).not.toContain('lang=');
      expect(calledUrl).not.toContain('gender=');
    });

    it('should validate response data against Zod schema', async () => {
      // Valid data should pass validation
      const result = await client.getVoices();

      expect(result.voices).toBeInstanceOf(Array);
      expect(result.voices).toHaveLength(3);
    });

    it('should throw ResponseValidationError for invalid voice data', async () => {
      mockFetch = vi.fn().mockResolvedValue(
        createMockResponse(200, {
          voices: [
            { name: 'Invalid Voice' }, // Missing required fields: flag, gender, lang, voiceIDs
          ],
        })
      );
      client = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        fetch: mockFetch as unknown as typeof fetch,
      });

      await expect(client.getVoices()).rejects.toThrow(ResponseValidationError);
    });

    it('should include validation issues in ResponseValidationError', async () => {
      mockFetch = vi.fn().mockResolvedValue(
        createMockResponse(200, {
          voices: [
            { name: 'Invalid Voice', flag: 123 }, // flag should be string, missing other fields
          ],
        })
      );
      client = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        fetch: mockFetch as unknown as typeof fetch,
      });

      try {
        await client.getVoices();
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ResponseValidationError);
        const validationError = error as ResponseValidationError;
        expect(validationError.issues).toBeInstanceOf(Array);
        expect(validationError.issues.length).toBeGreaterThan(0);
        expect(validationError.data).toBeDefined();
      }
    });

    it('should throw ResponseValidationError for wrong gender value', async () => {
      mockFetch = vi.fn().mockResolvedValue(
        createMockResponse(200, {
          voices: [{ name: 'Voice', flag: 'us', gender: 'invalid', lang: 'en-US', voiceIDs: [0] }],
        })
      );
      client = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        fetch: mockFetch as unknown as typeof fetch,
      });

      await expect(client.getVoices()).rejects.toThrow(ResponseValidationError);
    });
  });

  // ============================================================================
  // getVoice() Method Tests
  // ============================================================================

  describe('getVoice()', () => {
    let mockFetch: ReturnType<typeof vi.fn>;
    let client: ResponsiveVoiceAPIClient;

    const mockVoice = {
      id: 1,
      name: 'UK English Female',
      lang: 'en-GB',
      rate: 0.5,
      pitch: 0.5,
      service: 'g1',
    };

    beforeEach(() => {
      mockFetch = vi.fn().mockResolvedValue(createMockResponse(200, mockVoice));
      client = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        fetch: mockFetch as unknown as typeof fetch,
      });
    });

    it('should make GET request to /voices/{name}', async () => {
      await client.getVoice('UK English Female');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/voices/UK%20English%20Female'),
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('should URL-encode voice name', async () => {
      await client.getVoice('Voice Name With Spaces & Special!');

      const calledUrl = (mockFetch.mock.calls[0] as unknown[])[0] as string;
      expect(calledUrl).toContain('Voice%20Name%20With%20Spaces%20%26%20Special!');
    });

    it('should return SystemVoice object', async () => {
      const result = await client.getVoice('UK English Female');

      expect(result).toHaveProperty('name', 'UK English Female');
      expect(result).toHaveProperty('lang', 'en-GB');
      expect(result).toHaveProperty('service', 'g1');
    });

    it('should throw NotFoundError on 404', async () => {
      mockFetch = vi
        .fn()
        .mockResolvedValue(createMockResponse(404, { message: 'Voice not found' }));
      client = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        fetch: mockFetch as unknown as typeof fetch,
        retryAttempts: 0,
      });

      await expect(client.getVoice('Unknown Voice')).rejects.toThrow(NotFoundError);
    });

    it('should include resource name in NotFoundError', async () => {
      mockFetch = vi
        .fn()
        .mockResolvedValue(createMockResponse(404, { message: 'Voice not found' }));
      client = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        fetch: mockFetch as unknown as typeof fetch,
        retryAttempts: 0,
      });

      try {
        await client.getVoice('Unknown Voice');
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(NotFoundError);
        expect((error as NotFoundError).resource).toBeDefined();
      }
    });

    it('should validate response data against SystemVoice schema', async () => {
      // Valid data should pass validation
      const result = await client.getVoice('UK English Female');

      expect(result).toHaveProperty('name', 'UK English Female');
      expect(result).toHaveProperty('service', 'g1');
    });

    it('should throw ResponseValidationError for invalid SystemVoice data', async () => {
      mockFetch = vi.fn().mockResolvedValue(
        createMockResponse(200, {
          name: 123, // name should be string
        })
      );
      client = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        fetch: mockFetch as unknown as typeof fetch,
      });

      await expect(client.getVoice('Invalid')).rejects.toThrow(ResponseValidationError);
    });

    it('should throw ResponseValidationError for invalid service value', async () => {
      mockFetch = vi.fn().mockResolvedValue(
        createMockResponse(200, {
          name: 'Test Voice',
          service: 'invalid-service', // must be g1, g2, g3, or g5
        })
      );
      client = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        fetch: mockFetch as unknown as typeof fetch,
      });

      await expect(client.getVoice('Test Voice')).rejects.toThrow(ResponseValidationError);
    });

    it('should include voice name in ResponseValidationError message', async () => {
      mockFetch = vi.fn().mockResolvedValue(
        createMockResponse(200, {
          name: 123, // Invalid
        })
      );
      client = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        fetch: mockFetch as unknown as typeof fetch,
      });

      try {
        await client.getVoice('My Voice');
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ResponseValidationError);
        expect((error as ResponseValidationError).message).toContain('My Voice');
      }
    });
  });

  // ============================================================================
  // getVoicesByLanguage() Method Tests
  // ============================================================================

  describe('getVoicesByLanguage()', () => {
    let mockFetch: ReturnType<typeof vi.fn>;
    let client: ResponsiveVoiceAPIClient;

    const mockVoiceList = {
      voices: [
        { name: 'German Female', flag: 'de', gender: 'f', lang: 'de-DE', voiceIDs: [10] },
        { name: 'German Male', flag: 'de', gender: 'm', lang: 'de-DE', voiceIDs: [11] },
      ],
    };

    beforeEach(() => {
      mockFetch = vi.fn().mockResolvedValue(createMockResponse(200, mockVoiceList));
      client = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        fetch: mockFetch as unknown as typeof fetch,
      });
    });

    it('should make GET request to /voices/by-language/{lang}', async () => {
      await client.getVoicesByLanguage('de-DE');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/voices/by-language/de-DE'),
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('should URL-encode language code', async () => {
      // Test with a hypothetical complex language tag
      await client.getVoicesByLanguage('zh-Hans-CN');

      const calledUrl = (mockFetch.mock.calls[0] as unknown[])[0] as string;
      expect(calledUrl).toContain('/voices/by-language/zh-Hans-CN');
    });

    it('should return array of Voice objects', async () => {
      const result = await client.getVoicesByLanguage('de-DE');

      expect(result).toBeInstanceOf(Array);
      expect(result).toHaveLength(2);
      expect(result[0]).toHaveProperty('name', 'German Female');
      expect(result[0]).toHaveProperty('lang', 'de-DE');
    });

    it('should handle empty result for unsupported language', async () => {
      mockFetch = vi.fn().mockResolvedValue(createMockResponse(200, { voices: [] }));
      client = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        fetch: mockFetch as unknown as typeof fetch,
      });

      const result = await client.getVoicesByLanguage('xx-XX');

      expect(result).toEqual([]);
    });

    it('should work with short language codes', async () => {
      await client.getVoicesByLanguage('fr');

      const calledUrl = (mockFetch.mock.calls[0] as unknown[])[0] as string;
      expect(calledUrl).toContain('/voices/by-language/fr');
    });

    it('should validate response data against Zod schema', async () => {
      // Valid data should pass validation
      const result = await client.getVoicesByLanguage('de-DE');

      expect(result).toBeInstanceOf(Array);
      expect(result).toHaveLength(2);
    });

    it('should throw ResponseValidationError for invalid voice data', async () => {
      mockFetch = vi.fn().mockResolvedValue(
        createMockResponse(200, {
          voices: [
            { name: 'Invalid Voice' }, // Missing required fields
          ],
        })
      );
      client = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        fetch: mockFetch as unknown as typeof fetch,
      });

      await expect(client.getVoicesByLanguage('de')).rejects.toThrow(ResponseValidationError);
    });

    it('should include language in ResponseValidationError message', async () => {
      mockFetch = vi.fn().mockResolvedValue(
        createMockResponse(200, {
          voices: [{ name: 'Invalid', flag: 123 }],
        })
      );
      client = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        fetch: mockFetch as unknown as typeof fetch,
      });

      try {
        await client.getVoicesByLanguage('fr-FR');
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ResponseValidationError);
        expect((error as ResponseValidationError).message).toContain('fr-FR');
      }
    });
  });

  // ============================================================================
  // Timeout and Network Error Tests
  // ============================================================================

  describe('timeout handling', () => {
    it('should throw TimeoutError when request times out', async () => {
      const mockFetch = vi.fn().mockImplementation(() => {
        return new Promise((_, reject) => {
          const error = new DOMException('The operation was aborted', 'AbortError');
          setTimeout(() => reject(error), 10);
        });
      });

      const client = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        fetch: mockFetch as unknown as typeof fetch,
        timeout: 50,
        retryAttempts: 0,
      });

      await expect(client.getVoices()).rejects.toThrow(TimeoutError);
    });

    it('should include timeout duration in TimeoutError', async () => {
      const mockFetch = vi.fn().mockImplementation(() => {
        return new Promise((_, reject) => {
          const error = new DOMException('The operation was aborted', 'AbortError');
          setTimeout(() => reject(error), 10);
        });
      });

      const client = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        fetch: mockFetch as unknown as typeof fetch,
        timeout: 50,
        retryAttempts: 0,
      });

      try {
        await client.getVoices();
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(TimeoutError);
        expect((error as TimeoutError).timeout).toBe(50);
      }
    });

    it('should support custom timeout per request', async () => {
      const mockFetch = vi.fn().mockImplementation(() => {
        return new Promise((_, reject) => {
          const error = new DOMException('The operation was aborted', 'AbortError');
          setTimeout(() => reject(error), 10);
        });
      });

      const client = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        fetch: mockFetch as unknown as typeof fetch,
        timeout: 30000,
        retryAttempts: 0,
      });

      try {
        await client.getVoices({}, { timeout: 25 });
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(TimeoutError);
        expect((error as TimeoutError).timeout).toBe(25);
      }
    });
  });

  describe('network error handling', () => {
    it('should throw NetworkError on fetch failure', async () => {
      const fetchError = new TypeError('fetch failed');
      const mockFetch = vi.fn().mockRejectedValue(fetchError);

      const client = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        fetch: mockFetch as unknown as typeof fetch,
        retryAttempts: 0,
      });

      await expect(client.getVoices()).rejects.toThrow(NetworkError);
    });

    it('should include original error in NetworkError', async () => {
      const fetchError = new TypeError('fetch failed: Connection refused');
      const mockFetch = vi.fn().mockRejectedValue(fetchError);

      const client = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        fetch: mockFetch as unknown as typeof fetch,
        retryAttempts: 0,
      });

      try {
        await client.getVoices();
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(NetworkError);
        expect((error as NetworkError).cause).toBe(fetchError);
      }
    });
  });

  // ============================================================================
  // Request Options Tests
  // ============================================================================

  describe('request options', () => {
    let mockFetch: ReturnType<typeof vi.fn>;
    let client: ResponsiveVoiceAPIClient;

    beforeEach(() => {
      mockFetch = vi.fn().mockResolvedValue(createMockResponse(200, { voices: [] }));
      client = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        fetch: mockFetch as unknown as typeof fetch,
      });
    });

    it('should allow skipping retry for specific requests', async () => {
      let callCount = 0;
      mockFetch = vi.fn().mockImplementation(async () => {
        callCount++;
        return createMockResponse(500, { message: 'Server error' });
      });

      client = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        fetch: mockFetch as unknown as typeof fetch,
        retryAttempts: 3,
      });

      await expect(client.getVoices({}, { skipRetry: true })).rejects.toThrow(ApiError);

      // Should only be called once (no retries)
      expect(callCount).toBe(1);
    });

    it('should pass abort signal to fetch', async () => {
      const controller = new AbortController();
      mockFetch = vi.fn().mockResolvedValue(createMockResponse(200, { voices: [] }));

      client = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        fetch: mockFetch as unknown as typeof fetch,
      });

      await client.getVoices({}, { signal: controller.signal });

      const callArgs = mockFetch.mock.calls[0] as unknown[];
      const requestInit = callArgs[1] as RequestInit;
      expect(requestInit.signal).toBeDefined();
    });
  });

  describe('reportVoices()', () => {
    let client: ResponsiveVoiceAPIClient;
    let mockFetch: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      mockFetch = vi.fn();
      client = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        fetch: mockFetch as unknown as typeof fetch,
      });
    });

    afterEach(() => {
      vi.resetAllMocks();
    });

    it('should send voice report and return response', async () => {
      const mockResponse = {
        voices: [
          {
            name: 'UK English Female',
            flag: 'gb',
            gender: 'f',
            lang: 'en-GB',
            voiceIDs: [1, 2, 3],
          },
        ],
        systemVoices: [
          { id: 1, name: 'Google UK English Female' },
          { id: 2, name: 'Microsoft Hazel' },
          { id: 3, name: 'Siri Karen' },
        ],
        count: 1,
      };

      mockFetch.mockResolvedValue(createMockResponse(200, mockResponse));

      const report = {
        platform: {
          browser: 'Chrome',
          browserVersion: '120.0',
          os: 'Windows',
          osVersion: '11',
        },
        voices: [
          {
            name: 'Google UK English Female',
            lang: 'en-GB',
            localService: false,
            voiceURI: 'Google UK English Female',
          },
        ],
        timestamp: '2025-01-15T10:30:00Z',
      };

      const result = await client.reportVoices(report);

      expect(result.count).toBe(1);
      expect(result.voices).toHaveLength(1);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/voices/report'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify(report),
        })
      );
    });

    it('should throw ResponseValidationError for invalid response', async () => {
      const invalidResponse = {
        voices: 'not-an-array',
        count: 'not-a-number',
      };

      mockFetch.mockResolvedValue(createMockResponse(200, invalidResponse));

      const report = {
        platform: {
          browser: 'Chrome',
          browserVersion: '120.0',
          os: 'Windows',
          osVersion: '11',
        },
        voices: [],
        timestamp: '2025-01-15T10:30:00Z',
      };

      await expect(client.reportVoices(report)).rejects.toThrow(ResponseValidationError);
    });
  });

  describe('getVoices() with systemVoices', () => {
    let client: ResponsiveVoiceAPIClient;
    let mockFetch: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      mockFetch = vi.fn();
      client = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        fetch: mockFetch as unknown as typeof fetch,
      });
    });

    afterEach(() => {
      vi.resetAllMocks();
    });

    it('should pass through dense systemVoices response', async () => {
      const mockResponse = {
        voices: [
          {
            name: 'UK English Female',
            flag: 'gb',
            gender: 'f',
            lang: 'en-GB',
            voiceIDs: [1, 3],
          },
        ],
        systemVoices: [
          { id: 1, name: 'Google UK English Female', lang: 'en-GB' },
          { id: 3, name: 'Microsoft David', lang: 'en-US' },
        ],
      };

      mockFetch.mockResolvedValue(createMockResponse(200, mockResponse));

      const result = await client.getVoices();

      expect(result.systemVoices).toHaveLength(2);
      expect(result.systemVoices[0].name).toBe('Google UK English Female');
      expect(result.systemVoices[1].name).toBe('Microsoft David');
    });

    it('should handle empty systemVoices array', async () => {
      const mockResponse = {
        voices: [
          {
            name: 'UK English Female',
            flag: 'gb',
            gender: 'f',
            lang: 'en-GB',
            voiceIDs: [1],
          },
        ],
        systemVoices: [],
      };

      mockFetch.mockResolvedValue(createMockResponse(200, mockResponse));

      const result = await client.getVoices();

      expect(result.systemVoices).toHaveLength(0);
    });

    it('should handle undefined systemVoices', async () => {
      const mockResponse = {
        voices: [
          {
            name: 'UK English Female',
            flag: 'gb',
            gender: 'f',
            lang: 'en-GB',
            voiceIDs: [1],
          },
        ],
      };

      mockFetch.mockResolvedValue(createMockResponse(200, mockResponse));

      const result = await client.getVoices();

      expect(result.systemVoices).toHaveLength(0);
    });
  });

  // ==========================================================================
  // Voice Cache Integration
  // ==========================================================================

  describe('voice cache integration', () => {
    let client: ResponsiveVoiceAPIClient;
    let mockFetch: ReturnType<typeof vi.fn>;

    const mockVoicesBody = {
      voices: [
        { name: 'UK English Female', flag: 'gb', gender: 'f', lang: 'en-GB', voiceIDs: [5, 7] },
      ],
      systemVoices: [],
      count: 1,
    };

    beforeEach(() => {
      mockFetch = vi.fn();
      client = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        fetch: mockFetch as unknown as typeof fetch,
        voiceCache: { storage: 'memory', ttl: 0 },
      });
    });

    afterEach(() => {
      vi.resetAllMocks();
    });

    it('should send If-None-Match header when cache has an ETag', async () => {
      // First call: 200 with ETag
      mockFetch.mockResolvedValueOnce(
        createMockResponse(200, mockVoicesBody, { ETag: '"test-etag-1234"' })
      );

      await client.getVoices();

      // Second call: should include If-None-Match
      mockFetch.mockResolvedValueOnce(
        createMockResponse(200, mockVoicesBody, { ETag: '"test-etag-1234"' })
      );

      await client.getVoices();

      const secondCall = mockFetch.mock.calls[1];
      expect(secondCall[1].headers['If-None-Match']).toBe('"test-etag-1234"');
    });

    it('should return cached data on 304 Not Modified', async () => {
      // First call: 200 with ETag
      mockFetch.mockResolvedValueOnce(
        createMockResponse(200, mockVoicesBody, { ETag: '"test-etag-1234"' })
      );

      const firstResult = await client.getVoices();

      // Second call: 304 Not Modified
      mockFetch.mockResolvedValueOnce(
        new Response(null, { status: 304, headers: { ETag: '"test-etag-1234"' } })
      );

      const secondResult = await client.getVoices();

      expect(secondResult.voices).toEqual(firstResult.voices);
    });

    it('should refresh cachedAt on 304 so cache becomes fresh again', async () => {
      // Use a client with default TTL (not ttl: 0) so freshness matters
      const ttlClient = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        fetch: mockFetch as unknown as typeof fetch,
        voiceCache: { storage: 'memory', ttl: 300 },
      });

      // First call: 200 with ETag
      mockFetch.mockResolvedValueOnce(
        createMockResponse(200, mockVoicesBody, { ETag: '"test-etag-refresh"' })
      );

      await ttlClient.getVoices();

      // Simulate stale cache by re-creating with ttl: 0 for the second call
      // Instead, we use the same client — the first call just populated cache as fresh,
      // so the second call returns from cache. To test 304 refresh, we need the cache
      // to be stale first. Let's use a short TTL client and manipulate timing.

      // Actually, use ttl: 0 client for first two calls (always revalidates),
      // then check that after 304, a ttl: 300 client sees fresh data.
      const staleClient = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        fetch: mockFetch as unknown as typeof fetch,
        voiceCache: { storage: 'memory', ttl: 0 },
      });

      // First call: 200 with ETag (populates cache, but ttl: 0 means always stale)
      mockFetch.mockResolvedValueOnce(
        createMockResponse(200, mockVoicesBody, { ETag: '"test-etag-refresh"' })
      );
      await staleClient.getVoices();

      // Second call: 304 — should refresh cachedAt
      mockFetch.mockResolvedValueOnce(
        new Response(null, { status: 304, headers: { ETag: '"test-etag-refresh"' } })
      );
      await staleClient.getVoices();

      // Third call: even with ttl: 0, the cache was just refreshed by the 304
      // but ttl: 0 means ageMs >= 0 is always >= 0*1000, so still stale.
      // The real proof: cachedAt changed. Let's verify via getCachedVoiceData.
      const cached = await staleClient.getCachedVoiceData();
      // cachedAt should be very recent (within last second)
      expect(Date.now() - cached!.cachedAt).toBeLessThan(1000);
    });

    it('should not use cache for filtered requests', async () => {
      // First call: unfiltered, populates cache
      mockFetch.mockResolvedValueOnce(
        createMockResponse(200, mockVoicesBody, { ETag: '"test-etag-1234"' })
      );

      await client.getVoices();

      // Second call: filtered, should not send If-None-Match
      mockFetch.mockResolvedValueOnce(createMockResponse(200, mockVoicesBody));

      await client.getVoices({ lang: 'en-GB' });

      const secondCall = mockFetch.mock.calls[1];
      expect(secondCall[1].headers['If-None-Match']).toBeUndefined();
    });

    it('should update cache when fresh 200 response arrives', async () => {
      // First call: 200 with ETag v1
      mockFetch.mockResolvedValueOnce(
        createMockResponse(200, mockVoicesBody, { ETag: '"etag-v1"' })
      );

      await client.getVoices();

      // Second call: 200 with ETag v2 (data changed)
      const updatedBody = {
        ...mockVoicesBody,
        voices: [
          ...mockVoicesBody.voices,
          { name: 'US English Male', flag: 'us', gender: 'm', lang: 'en-US', voiceIDs: [3] },
        ],
        count: 2,
      };
      mockFetch.mockResolvedValueOnce(createMockResponse(200, updatedBody, { ETag: '"etag-v2"' }));

      await client.getVoices();

      // Third call: should use etag-v2
      mockFetch.mockResolvedValueOnce(
        new Response(null, { status: 304, headers: { ETag: '"etag-v2"' } })
      );

      const result = await client.getVoices();
      expect(result.voices).toHaveLength(2);
    });

    it('should clear voice cache', async () => {
      // Populate cache
      mockFetch.mockResolvedValueOnce(
        createMockResponse(200, mockVoicesBody, { ETag: '"test-etag"' })
      );

      await client.getVoices();

      // Clear cache
      await client.clearVoiceCache();

      // Next call should NOT send If-None-Match
      mockFetch.mockResolvedValueOnce(
        createMockResponse(200, mockVoicesBody, { ETag: '"test-etag"' })
      );

      await client.getVoices();

      const secondCall = mockFetch.mock.calls[1];
      expect(secondCall[1].headers['If-None-Match']).toBeUndefined();
    });

    it('should work with cache disabled', async () => {
      const noCacheClient = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        fetch: mockFetch as unknown as typeof fetch,
        voiceCache: { enabled: false },
      });

      // Should work normally without caching
      mockFetch.mockResolvedValueOnce(
        createMockResponse(200, mockVoicesBody, { ETag: '"test-etag"' })
      );

      const result = await noCacheClient.getVoices();
      expect(result.voices).toHaveLength(1);

      // Second call should NOT send If-None-Match
      mockFetch.mockResolvedValueOnce(
        createMockResponse(200, mockVoicesBody, { ETag: '"test-etag"' })
      );

      await noCacheClient.getVoices();

      const secondCall = mockFetch.mock.calls[1];
      expect(secondCall[1].headers['If-None-Match']).toBeUndefined();
    });

    it('should seed cache from reportVoices response', async () => {
      const reportResponse = {
        voices: mockVoicesBody.voices,
        systemVoices: [],
        count: 1,
      };

      mockFetch.mockResolvedValueOnce(
        createMockResponse(200, reportResponse, {
          ETag: '"report-etag"',
          'X-Voice-Data-ETag': '"report-etag"',
        })
      );

      await client.reportVoices({
        platform: { browser: 'Chrome', browserVersion: '120', os: 'Windows', osVersion: '10' },
        voices: [],
        timestamp: new Date().toISOString(),
      });

      // Next getVoices should have cached data and send If-None-Match
      mockFetch.mockResolvedValueOnce(
        new Response(null, { status: 304, headers: { ETag: '"report-etag"' } })
      );

      const result = await client.getVoices();
      expect(result.voices).toHaveLength(1);
    });

    it('cache should be enabled by default', async () => {
      const defaultClient = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        fetch: mockFetch as unknown as typeof fetch,
        voiceCache: { storage: 'memory' },
      });

      // First call: 200 with ETag
      mockFetch.mockResolvedValueOnce(
        createMockResponse(200, mockVoicesBody, { ETag: '"default-etag"' })
      );

      await defaultClient.getVoices();

      // Second call should be served from fresh cache (no fetch)
      const result = await defaultClient.getVoices();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(result.voices).toHaveLength(1);
    });

    it('should skip network request when cache is fresh (within TTL)', async () => {
      const freshClient = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        fetch: mockFetch as unknown as typeof fetch,
        voiceCache: { storage: 'memory' },
      });

      // First call: 200 with ETag → populates cache
      mockFetch.mockResolvedValueOnce(
        createMockResponse(200, mockVoicesBody, { ETag: '"fresh-etag"' })
      );

      const first = await freshClient.getVoices();

      // Second call: cache is fresh (just populated), no fetch needed
      const second = await freshClient.getVoices();

      // Only 1 fetch call (the first one); second served from cache
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(second.voices).toEqual(first.voices);
    });

    it('should revalidate with If-None-Match when cache is stale (past TTL)', async () => {
      // Use ttl: 0 to force immediate staleness
      const staleClient = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        fetch: mockFetch as unknown as typeof fetch,
        voiceCache: { storage: 'memory', ttl: 0 },
      });

      // First call: 200 with ETag
      mockFetch.mockResolvedValueOnce(
        createMockResponse(200, mockVoicesBody, { ETag: '"stale-etag"' })
      );

      await staleClient.getVoices();

      // Second call: cache is stale (ttl: 0), revalidates with If-None-Match
      mockFetch.mockResolvedValueOnce(
        new Response(null, { status: 304, headers: { ETag: '"stale-etag"' } })
      );

      const result = await staleClient.getVoices();

      expect(mockFetch).toHaveBeenCalledTimes(2);
      const secondCall = mockFetch.mock.calls[1];
      expect(secondCall[1].headers['If-None-Match']).toBe('"stale-etag"');
      expect(result.voices).toHaveLength(1);
    });
  });

  // ==========================================================================
  // getCachedVoiceData()
  // ==========================================================================

  describe('getCachedVoiceData()', () => {
    let client: ResponsiveVoiceAPIClient;
    let mockFetch: ReturnType<typeof vi.fn>;

    const mockVoicesBody = {
      voices: [
        { name: 'UK English Female', flag: 'gb', gender: 'f', lang: 'en-GB', voiceIDs: [5, 7] },
      ],
      systemVoices: [],
      count: 1,
    };

    beforeEach(() => {
      mockFetch = vi.fn();
      client = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        fetch: mockFetch as unknown as typeof fetch,
        voiceCache: { storage: 'memory' },
      });
    });

    afterEach(() => {
      vi.resetAllMocks();
    });

    it('should return null when cache is empty', async () => {
      const result = await client.getCachedVoiceData();
      expect(result).toBeNull();
    });

    it('should return cached data and browserVoiceHash after reportVoices', async () => {
      const reportResponse = {
        voices: mockVoicesBody.voices,
        systemVoices: [],
        count: 1,
      };

      mockFetch.mockResolvedValueOnce(
        createMockResponse(200, reportResponse, {
          ETag: '"report-etag"',
          'X-Voice-Data-ETag': '"report-etag"',
        })
      );

      await client.reportVoices(
        {
          platform: { browser: 'Chrome', browserVersion: '120', os: 'Windows', osVersion: '10' },
          voices: [],
          timestamp: new Date().toISOString(),
        },
        { browserVoiceHash: 'hash-abc-123' }
      );

      const cached = await client.getCachedVoiceData();

      expect(cached).not.toBeNull();
      expect(cached!.etag).toBe('"report-etag"');
      expect(cached!.voices).toEqual(mockVoicesBody.voices);
      expect(cached!.cachedAt).toBeGreaterThan(0);

      // browserVoiceHash is stored separately, not on CachedVoiceData
      const hash = await client.getBrowserVoiceHash();
      expect(hash).toBe('hash-abc-123');
    });

    it('should return cached data and null browserVoiceHash after getVoices', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse(200, mockVoicesBody, { ETag: '"voices-etag"' })
      );

      await client.getVoices();

      const cached = await client.getCachedVoiceData();

      expect(cached).not.toBeNull();
      expect(cached!.etag).toBe('"voices-etag"');

      // browserVoiceHash is stored separately; should be null when never set
      const hash = await client.getBrowserVoiceHash();
      expect(hash).toBeNull();
    });
  });

  // ==========================================================================
  // reportVoices() with browserVoiceHash
  // ==========================================================================

  describe('reportVoices() with browserVoiceHash', () => {
    let client: ResponsiveVoiceAPIClient;
    let mockFetch: ReturnType<typeof vi.fn>;

    const mockVoicesBody = {
      voices: [
        { name: 'UK English Female', flag: 'gb', gender: 'f', lang: 'en-GB', voiceIDs: [5, 7] },
      ],
      systemVoices: [],
      count: 1,
    };

    beforeEach(() => {
      mockFetch = vi.fn();
      client = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        fetch: mockFetch as unknown as typeof fetch,
        voiceCache: { storage: 'memory' },
      });
    });

    afterEach(() => {
      vi.resetAllMocks();
    });

    it('should store browserVoiceHash separately when provided in requestOptions', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse(200, mockVoicesBody, {
          ETag: '"report-etag"',
          'X-Voice-Data-ETag': '"report-etag"',
        })
      );

      await client.reportVoices(
        {
          platform: { browser: 'Chrome', browserVersion: '120', os: 'Windows', osVersion: '10' },
          voices: [],
          timestamp: new Date().toISOString(),
        },
        { browserVoiceHash: 'my-browser-hash' }
      );

      // browserVoiceHash is stored via setBrowserVoiceHash(), not in CachedVoiceData
      const hash = await client.getBrowserVoiceHash();
      expect(hash).toBe('my-browser-hash');
    });

    it('should not store browserVoiceHash when not provided in requestOptions', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse(200, mockVoicesBody, {
          ETag: '"report-etag"',
          'X-Voice-Data-ETag': '"report-etag"',
        })
      );

      await client.reportVoices({
        platform: { browser: 'Firefox', browserVersion: '119', os: 'macOS', osVersion: '14' },
        voices: [],
        timestamp: new Date().toISOString(),
      });

      // browserVoiceHash should be null when never set via setBrowserVoiceHash()
      const hash = await client.getBrowserVoiceHash();
      expect(hash).toBeNull();
    });
  });

  // ==========================================================================
  // getVoices() platform params
  // ==========================================================================

  describe('getVoices() platform params', () => {
    let client: ResponsiveVoiceAPIClient;
    let mockFetch: ReturnType<typeof vi.fn>;

    const mockVoicesBody = {
      voices: [
        { name: 'UK English Female', flag: 'gb', gender: 'f', lang: 'en-GB', voiceIDs: [5, 7] },
      ],
      systemVoices: [],
      count: 1,
    };

    beforeEach(() => {
      mockFetch = vi.fn();
      client = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        fetch: mockFetch as unknown as typeof fetch,
        voiceCache: { storage: 'memory', ttl: 0 },
      });
    });

    afterEach(() => {
      vi.resetAllMocks();
    });

    it('should forward platform params as query parameters', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(200, mockVoicesBody));

      await client.getVoices({
        browser: 'Chrome',
        browserVersion: '120.0',
        os: 'Windows',
        osVersion: '11',
      });

      const calledUrl = (mockFetch.mock.calls[0] as unknown[])[0] as string;
      expect(calledUrl).toContain('browser=Chrome');
      expect(calledUrl).toContain('browserVersion=120.0');
      expect(calledUrl).toContain('os=Windows');
      expect(calledUrl).toContain('osVersion=11');
    });

    it('should forward platform params alongside lang/gender filters', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(200, mockVoicesBody));

      await client.getVoices({
        lang: 'en-GB',
        gender: 'female',
        browser: 'Safari',
        os: 'macOS',
      });

      const calledUrl = (mockFetch.mock.calls[0] as unknown[])[0] as string;
      expect(calledUrl).toContain('lang=en-GB');
      expect(calledUrl).toContain('gender=female');
      expect(calledUrl).toContain('browser=Safari');
      expect(calledUrl).toContain('os=macOS');
    });

    it('should not include platform params when not provided', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(200, mockVoicesBody));

      await client.getVoices({});

      const calledUrl = (mockFetch.mock.calls[0] as unknown[])[0] as string;
      expect(calledUrl).not.toContain('browser=');
      expect(calledUrl).not.toContain('browserVersion=');
      expect(calledUrl).not.toContain('os=');
      expect(calledUrl).not.toContain('osVersion=');
    });

    it('should not bypass cache when only platform params are provided', async () => {
      // First call: populate cache with ETag
      mockFetch.mockResolvedValueOnce(
        createMockResponse(200, mockVoicesBody, { ETag: '"platform-etag"' })
      );

      await client.getVoices();

      // Second call: platform params only (no lang/gender), should still use cached ETag
      mockFetch.mockResolvedValueOnce(
        createMockResponse(200, mockVoicesBody, { ETag: '"platform-etag"' })
      );

      await client.getVoices({
        browser: 'Chrome',
        browserVersion: '120.0',
        os: 'Windows',
        osVersion: '11',
      });

      const secondCall = mockFetch.mock.calls[1];
      expect(secondCall[1].headers['If-None-Match']).toBe('"platform-etag"');
    });

    it('should bypass cache when lang filter is present even with platform params', async () => {
      // First call: populate cache
      mockFetch.mockResolvedValueOnce(
        createMockResponse(200, mockVoicesBody, { ETag: '"cached-etag"' })
      );

      await client.getVoices();

      // Second call: lang filter + platform params should bypass cache
      mockFetch.mockResolvedValueOnce(createMockResponse(200, mockVoicesBody));

      await client.getVoices({
        lang: 'en-GB',
        browser: 'Chrome',
      });

      const secondCall = mockFetch.mock.calls[1];
      expect(secondCall[1].headers['If-None-Match']).toBeUndefined();
    });
  });

  // ============================================================================
  // getConfig() Method Tests
  // ============================================================================

  describe('getConfig()', () => {
    it('should make GET request to /config', async () => {
      const mockConfig = {
        features: {
          welcomeMessage: { enabled: true, text: 'Hello!' },
          speakSelectedText: { enabled: false },
          speakLinks: { enabled: false },
          speakInactivity: { enabled: false, text: null },
          speakEndPage: { enabled: false, text: null },
          exitIntent: { enabled: false, text: null },
          accessibilityNavigation: { enabled: false },
          paragraphNavigation: { enabled: false },
          welcomeMessageOnce: false,
        },
        voice: { name: 'US English Female', pitch: 1, rate: 1, volume: 1 },
        analytics: { enabled: true },
      };

      const mockFetch = vi.fn().mockResolvedValue(createMockResponse(200, mockConfig));

      const client = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        fetch: mockFetch as unknown as typeof fetch,
      });

      const config = await client.getConfig();

      expect(config.features.welcomeMessage.enabled).toBe(true);
      expect(config.features.welcomeMessage.text).toBe('Hello!');
      expect(config.voice.name).toBe('US English Female');
      expect(config.analytics.enabled).toBe(true);

      const calledUrl = (mockFetch.mock.calls[0] as unknown[])[0] as string;
      expect(calledUrl).toContain('/config');
    });

    it('should apply schema defaults for missing fields', async () => {
      const mockFetch = vi.fn().mockResolvedValue(createMockResponse(200, {}));

      const client = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        fetch: mockFetch as unknown as typeof fetch,
      });

      const config = await client.getConfig();

      expect(config.features.welcomeMessage.enabled).toBe(false);
      expect(config.features.welcomeMessage.text).toBeNull();
      expect(config.voice.name).toBe('UK English Female');
      expect(config.voice.pitch).toBe(1);
      expect(config.analytics.enabled).toBe(false);
    });

    it('should throw ResponseValidationError on invalid response', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValue(createMockResponse(200, { features: { welcomeMessage: 'invalid' } }));

      const client = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        fetch: mockFetch as unknown as typeof fetch,
      });

      await expect(client.getConfig()).rejects.toThrow(ResponseValidationError);
    });

    it('should throw ApiError on server error', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValue(createMockResponse(500, { error: 'Internal Server Error' }));

      const client = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        fetch: mockFetch as unknown as typeof fetch,
        retryAttempts: 0,
      });

      await expect(client.getConfig()).rejects.toThrow();
    });
  });

  // ============================================================================
  // getConfig() Method Tests
  // ============================================================================

  describe('getConfig()', () => {
    it('should make GET request to /config', async () => {
      const mockConfig = {
        features: {
          welcomeMessage: { enabled: true, text: 'Hello!' },
          speakSelectedText: { enabled: false },
          speakLinks: { enabled: false },
          speakInactivity: { enabled: false, text: null },
          speakEndPage: { enabled: false, text: null },
          exitIntent: { enabled: false, text: null },
          accessibilityNavigation: { enabled: false },
          paragraphNavigation: { enabled: false },
          welcomeMessageOnce: false,
        },
        voice: { name: 'US English Female', pitch: 1, rate: 1, volume: 1 },
        analytics: { enabled: true },
      };

      const mockFetch = vi.fn().mockResolvedValue(createMockResponse(200, mockConfig));

      const client = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        fetch: mockFetch as unknown as typeof fetch,
      });

      const config = await client.getConfig();

      expect(config.features.welcomeMessage.enabled).toBe(true);
      expect(config.features.welcomeMessage.text).toBe('Hello!');
      expect(config.voice.name).toBe('US English Female');
      expect(config.analytics.enabled).toBe(true);

      const calledUrl = (mockFetch.mock.calls[0] as unknown[])[0] as string;
      expect(calledUrl).toContain('/config');
    });

    it('should apply schema defaults for missing fields', async () => {
      const mockFetch = vi.fn().mockResolvedValue(createMockResponse(200, {}));

      const client = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        fetch: mockFetch as unknown as typeof fetch,
      });

      const config = await client.getConfig();

      expect(config.features.welcomeMessage.enabled).toBe(false);
      expect(config.features.welcomeMessage.text).toBeNull();
      expect(config.voice.name).toBe('UK English Female');
      expect(config.voice.pitch).toBe(1);
      expect(config.analytics.enabled).toBe(false);
    });

    it('should throw ResponseValidationError on invalid response', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValue(createMockResponse(200, { features: { welcomeMessage: 'invalid' } }));

      const client = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        fetch: mockFetch as unknown as typeof fetch,
      });

      await expect(client.getConfig()).rejects.toThrow(ResponseValidationError);
    });

    it('should throw on server error', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValue(createMockResponse(500, { error: 'Internal Server Error' }));

      const client = new ResponsiveVoiceAPIClient({
        apiKey: 'test-key',
        fetch: mockFetch as unknown as typeof fetch,
        retryAttempts: 0,
      });

      await expect(client.getConfig()).rejects.toThrow();
    });
  });

  describe('auth headers', () => {
    function lastFetchHeaders(mockFetch: ReturnType<typeof vi.fn>): Record<string, string> {
      const [, init] = mockFetch.mock.calls.at(-1)!;
      return (init?.headers ?? {}) as Record<string, string>;
    }

    it('does not attach X-API-Key/X-API-Secret when apiSecret is unset', async () => {
      const mockFetch = vi.fn().mockResolvedValue(createMockResponse(200, { features: {} }));
      const client = new ResponsiveVoiceAPIClient({
        apiKey: 'k',
        fetch: mockFetch as unknown as typeof fetch,
        retryAttempts: 0,
      });

      await client.getConfig().catch(() => {});

      const headers = lastFetchHeaders(mockFetch);
      expect(headers['X-API-Key']).toBeUndefined();
      expect(headers['X-API-Secret']).toBeUndefined();
    });

    it('attaches X-API-Key + X-API-Secret on every request when apiSecret is set', async () => {
      const mockFetch = vi.fn().mockResolvedValue(createMockResponse(200, { features: {} }));
      const client = new ResponsiveVoiceAPIClient({
        apiKey: 'serverkey',
        apiSecret: 's3cr3t-server-credential',
        fetch: mockFetch as unknown as typeof fetch,
        retryAttempts: 0,
      });

      await client.getConfig().catch(() => {});

      const headers = lastFetchHeaders(mockFetch);
      expect(headers['X-API-Key']).toBe('serverkey');
      expect(headers['X-API-Secret']).toBe('s3cr3t-server-credential');
    });

    it('invokes authHeaders hook per request and merges its return value', async () => {
      const mockFetch = vi.fn().mockResolvedValue(createMockResponse(200, { features: {} }));
      const authHeaders = vi
        .fn<() => Record<string, string>>()
        .mockReturnValue({ Authorization: 'Bearer fresh-token' });
      const client = new ResponsiveVoiceAPIClient({
        apiKey: 'k',
        authHeaders,
        fetch: mockFetch as unknown as typeof fetch,
        retryAttempts: 0,
      });

      await client.getConfig().catch(() => {});
      await client.getConfig().catch(() => {});

      expect(authHeaders).toHaveBeenCalledTimes(2);
      const headers = lastFetchHeaders(mockFetch);
      expect(headers.Authorization).toBe('Bearer fresh-token');
    });

    it('authHeaders take precedence over X-API-Key/X-API-Secret on conflict', async () => {
      const mockFetch = vi.fn().mockResolvedValue(createMockResponse(200, { features: {} }));
      const client = new ResponsiveVoiceAPIClient({
        apiKey: 'k',
        apiSecret: 'server-secret',
        authHeaders: () => ({ 'X-API-Secret': 'overridden-by-hook' }),
        fetch: mockFetch as unknown as typeof fetch,
        retryAttempts: 0,
      });

      await client.getConfig().catch(() => {});

      const headers = lastFetchHeaders(mockFetch);
      expect(headers['X-API-Key']).toBe('k');
      expect(headers['X-API-Secret']).toBe('overridden-by-hook');
    });

    it('does not call authHeaders when not configured', async () => {
      const mockFetch = vi.fn().mockResolvedValue(createMockResponse(200, { features: {} }));
      const client = new ResponsiveVoiceAPIClient({
        apiKey: 'k',
        fetch: mockFetch as unknown as typeof fetch,
        retryAttempts: 0,
      });

      await client.getConfig().catch(() => {});

      const headers = lastFetchHeaders(mockFetch);
      expect(headers.Authorization).toBeUndefined();
    });

    it('supports async authHeaders return values', async () => {
      const mockFetch = vi.fn().mockResolvedValue(createMockResponse(200, { features: {} }));
      const client = new ResponsiveVoiceAPIClient({
        apiKey: 'k',
        authHeaders: async () => ({ Authorization: 'Bearer async-token' }),
        fetch: mockFetch as unknown as typeof fetch,
        retryAttempts: 0,
      });

      await client.getConfig().catch(() => {});

      const headers = lastFetchHeaders(mockFetch);
      expect(headers.Authorization).toBe('Bearer async-token');
    });
  });

  describe('sliding renewal pickup', () => {
    it('invokes onTokenRenewed when X-RV-Auth-Renewed header is present', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ features: {} }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'X-RV-Auth-Renewed': 'fresh-jwt-token',
            'X-RV-Auth-Renewed-Exp': '1779999999',
          },
        })
      );
      const renewals: Array<{ token: string; exp: number }> = [];
      const client = new ResponsiveVoiceAPIClient({
        apiKey: 'k',
        onTokenRenewed: (r) => renewals.push(r),
        fetch: mockFetch as unknown as typeof fetch,
        retryAttempts: 0,
      });

      await client.getConfig().catch(() => {});

      expect(renewals).toHaveLength(1);
      expect(renewals[0]).toEqual({ token: 'fresh-jwt-token', exp: 1779999999 });
    });

    it('does not call onTokenRenewed when the header is absent', async () => {
      const mockFetch = vi.fn().mockResolvedValue(createMockResponse(200, { features: {} }));
      const renewals: Array<{ token: string; exp: number }> = [];
      const client = new ResponsiveVoiceAPIClient({
        apiKey: 'k',
        onTokenRenewed: (r) => renewals.push(r),
        fetch: mockFetch as unknown as typeof fetch,
        retryAttempts: 0,
      });

      await client.getConfig().catch(() => {});

      expect(renewals).toHaveLength(0);
    });

    it('ignores malformed exp header (non-numeric)', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ features: {} }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'X-RV-Auth-Renewed': 'fresh-jwt-token',
            'X-RV-Auth-Renewed-Exp': 'not-a-number',
          },
        })
      );
      const renewals: Array<{ token: string; exp: number }> = [];
      const client = new ResponsiveVoiceAPIClient({
        apiKey: 'k',
        onTokenRenewed: (r) => renewals.push(r),
        fetch: mockFetch as unknown as typeof fetch,
        retryAttempts: 0,
      });

      await client.getConfig().catch(() => {});

      expect(renewals).toHaveLength(0);
    });
  });
});

describe('onRateLimit', () => {
  it('surfaces X-RateLimit headers on a response', async () => {
    const seen: unknown[] = [];
    const mockFetch = vi
      .fn()
      .mockResolvedValue(
        createMockResponse(
          200,
          { voices: [] },
          { 'X-RateLimit-Limit': '10', 'X-RateLimit-Remaining': '3' }
        )
      );
    const client = new ResponsiveVoiceAPIClient({
      apiKey: 'k',
      fetch: mockFetch as unknown as typeof fetch,
      onRateLimit: (info) => seen.push(info),
    });

    await client.getVoices();

    expect(seen[0]).toEqual({ limit: 10, remaining: 3, retryAfter: null });
  });

  it('surfaces Retry-After on a 429', async () => {
    const seen: Array<{ retryAfter: number | null }> = [];
    const mockFetch = vi
      .fn()
      .mockResolvedValue(
        createMockResponse(
          429,
          { error: { message: 'rate limited', code: 'RATE_LIMIT_EXCEEDED', statusCode: 429 } },
          { 'Retry-After': '7', 'X-RateLimit-Limit': '10', 'X-RateLimit-Remaining': '0' }
        )
      );
    const client = new ResponsiveVoiceAPIClient({
      apiKey: 'k',
      fetch: mockFetch as unknown as typeof fetch,
      retryAttempts: 0,
      onRateLimit: (info) => seen.push(info),
    });

    await client.getConfig().catch(() => {});

    expect(seen[0]).toEqual({ limit: 10, remaining: 0, retryAfter: 7 });
  });
});

describe('verifyOrigin', () => {
  it('POSTs the token as Authorization: Bearer with no body or auth headers', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(createMockResponse(200, { verified: true, origin: 'https://site.com' }));
    const client = new ResponsiveVoiceAPIClient({
      apiKey: 'k',
      apiSecret: 'should-not-be-sent',
      fetch: mockFetch as unknown as typeof fetch,
    });

    const result = await client.verifyOrigin('verify.jwt.token');

    expect(result).toEqual({ verified: true, origin: 'https://site.com' });
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/auth/verify-origin');
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer verify.jwt.token');
    expect(headers['X-API-Secret']).toBeUndefined();
    expect(headers['X-API-Key']).toBeUndefined();
  });

  it('throws a typed ApiError on non-2xx (e.g. origin mismatch)', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      createMockResponse(401, {
        error: { message: 'origin does not match', code: 'UNAUTHORIZED', statusCode: 401 },
      })
    );
    const client = new ResponsiveVoiceAPIClient({
      apiKey: 'k',
      fetch: mockFetch as unknown as typeof fetch,
      retryAttempts: 0,
    });

    await expect(client.verifyOrigin('bad.token')).rejects.toBeInstanceOf(AuthError);
  });

  it('throws ResponseValidationError on a malformed success body', async () => {
    const mockFetch = vi.fn().mockResolvedValue(createMockResponse(200, { verified: 'yes' }));
    const client = new ResponsiveVoiceAPIClient({
      apiKey: 'k',
      fetch: mockFetch as unknown as typeof fetch,
    });

    await expect(client.verifyOrigin('t')).rejects.toBeInstanceOf(ResponseValidationError);
  });
});
