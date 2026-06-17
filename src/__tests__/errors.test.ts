/**
 * Tests for error classes
 */

import { describe, expect, it } from 'vitest';
import {
  ApiError,
  AuthError,
  createApiError,
  NetworkError,
  NotFoundError,
  RateLimitError,
  ResponsiveVoiceError,
  RetryExhaustedError,
  TimeoutError,
  ValidationError,
} from '../errors';

describe('ResponsiveVoiceError', () => {
  it('should create error with message', () => {
    const error = new ResponsiveVoiceError('Test error');
    expect(error.message).toBe('Test error');
    expect(error.name).toBe('ResponsiveVoiceError');
    expect(error).toBeInstanceOf(Error);
  });

  it('should store cause', () => {
    const cause = new Error('Original error');
    const error = new ResponsiveVoiceError('Wrapped error', cause);
    expect(error.cause).toBe(cause);
  });
});

describe('ApiError', () => {
  it('should create error with status and url', () => {
    const error = new ApiError('Not found', 404, 'Not Found', 'https://api.example.com/test');
    expect(error.status).toBe(404);
    expect(error.statusText).toBe('Not Found');
    expect(error.url).toBe('https://api.example.com/test');
    expect(error.name).toBe('ApiError');
  });

  it('should store response body', () => {
    const body = { error: 'Not found' };
    const error = new ApiError('Not found', 404, 'Not Found', 'https://api.example.com', body);
    expect(error.body).toEqual(body);
  });

  it('should identify client errors', () => {
    const error400 = new ApiError('Bad request', 400, 'Bad Request', 'https://api.example.com');
    const error404 = new ApiError('Not found', 404, 'Not Found', 'https://api.example.com');
    const error500 = new ApiError(
      'Server error',
      500,
      'Internal Server Error',
      'https://api.example.com'
    );

    expect(error400.isClientError).toBe(true);
    expect(error404.isClientError).toBe(true);
    expect(error500.isClientError).toBe(false);
  });

  it('should identify server errors', () => {
    const error400 = new ApiError('Bad request', 400, 'Bad Request', 'https://api.example.com');
    const error500 = new ApiError(
      'Server error',
      500,
      'Internal Server Error',
      'https://api.example.com'
    );
    const error503 = new ApiError(
      'Unavailable',
      503,
      'Service Unavailable',
      'https://api.example.com'
    );

    expect(error400.isServerError).toBe(false);
    expect(error500.isServerError).toBe(true);
    expect(error503.isServerError).toBe(true);
  });

  it('should identify retryable errors', () => {
    const error400 = new ApiError('Bad request', 400, 'Bad Request', 'https://api.example.com');
    const error429 = new ApiError(
      'Rate limited',
      429,
      'Too Many Requests',
      'https://api.example.com'
    );
    const error500 = new ApiError(
      'Server error',
      500,
      'Internal Server Error',
      'https://api.example.com'
    );

    expect(error400.isRetryable).toBe(false);
    expect(error429.isRetryable).toBe(true);
    expect(error500.isRetryable).toBe(true);
  });
});

describe('AuthError', () => {
  it('should create auth error', () => {
    const error = new AuthError('Unauthorized', 401, 'Unauthorized', 'https://api.example.com');
    expect(error.name).toBe('AuthError');
    expect(error.status).toBe(401);
    expect(error).toBeInstanceOf(ApiError);
  });
});

describe('NotFoundError', () => {
  it('should create not found error with resource', () => {
    const error = new NotFoundError(
      'Voice not found',
      'voice-name',
      404,
      'Not Found',
      'https://api.example.com/voices/voice-name'
    );
    expect(error.name).toBe('NotFoundError');
    expect(error.resource).toBe('voice-name');
    expect(error).toBeInstanceOf(ApiError);
  });
});

describe('RateLimitError', () => {
  it('should create rate limit error with retry-after', () => {
    const error = new RateLimitError(
      'Rate limited',
      429,
      'Too Many Requests',
      'https://api.example.com',
      60
    );
    expect(error.name).toBe('RateLimitError');
    expect(error.retryAfter).toBe(60);
    expect(error).toBeInstanceOf(ApiError);
  });
});

describe('ValidationError', () => {
  it('should create validation error with field errors', () => {
    const errors = {
      text: ['Text is required', 'Text must be less than 4000 characters'],
      lang: ['Invalid language code'],
    };
    const error = new ValidationError(
      'Validation failed',
      400,
      'Bad Request',
      'https://api.example.com',
      errors
    );
    expect(error.name).toBe('ValidationError');
    expect(error.errors).toEqual(errors);
    expect(error).toBeInstanceOf(ApiError);
  });
});

describe('NetworkError', () => {
  it('should create network error', () => {
    const cause = new TypeError('Failed to fetch');
    const error = new NetworkError('Network request failed', 'https://api.example.com', cause);
    expect(error.name).toBe('NetworkError');
    expect(error.url).toBe('https://api.example.com');
    expect(error.cause).toBe(cause);
    expect(error.isRetryable).toBe(true);
  });
});

describe('TimeoutError', () => {
  it('should create timeout error', () => {
    const error = new TimeoutError('Request timed out', 'https://api.example.com', 30000);
    expect(error.name).toBe('TimeoutError');
    expect(error.timeout).toBe(30000);
    expect(error).toBeInstanceOf(NetworkError);
    expect(error.isRetryable).toBe(true);
  });
});

describe('RetryExhaustedError', () => {
  it('should create retry exhausted error', () => {
    const lastError = new ApiError(
      'Server error',
      500,
      'Internal Server Error',
      'https://api.example.com'
    );
    const error = new RetryExhaustedError('All retries failed', 3, lastError);
    expect(error.name).toBe('RetryExhaustedError');
    expect(error.attempts).toBe(3);
    expect(error.lastError).toBe(lastError);
  });
});

describe('createApiError', () => {
  function createMockResponse(
    status: number,
    statusText: string,
    body?: unknown,
    headers?: Record<string, string>
  ): Response {
    return {
      status,
      statusText,
      ok: status >= 200 && status < 300,
      headers: new Headers(headers),
      json: async () => body,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    } as Response;
  }

  /**
   * Build a 500 response whose `json()` always throws, so `createApiError`
   * falls through to the `text()` branch. The caller supplies the `text()`
   * implementation.
   */
  function makeNonJsonResponse(text: () => Promise<string>): Response {
    return {
      status: 500,
      statusText: 'Internal Server Error',
      ok: false as boolean,
      headers: new Headers(),
      json: async () => {
        throw new Error('Not JSON');
      },
      text,
    } as Response;
  }

  it('should create ValidationError for 400', async () => {
    const response = createMockResponse(400, 'Bad Request', {
      message: 'Validation failed',
      errors: { text: ['Required'] },
    });

    const error = await createApiError(response, 'https://api.example.com');
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).errors).toEqual({ text: ['Required'] });
  });

  it('should create AuthError for 401', async () => {
    const response = createMockResponse(401, 'Unauthorized', { message: 'Invalid API key' });

    const error = await createApiError(response, 'https://api.example.com');
    expect(error).toBeInstanceOf(AuthError);
  });

  it('should create AuthError for 403', async () => {
    const response = createMockResponse(403, 'Forbidden', { message: 'Access denied' });

    const error = await createApiError(response, 'https://api.example.com');
    expect(error).toBeInstanceOf(AuthError);
  });

  it('should create NotFoundError for 404', async () => {
    const response = createMockResponse(404, 'Not Found', { message: 'Voice not found' });

    const error = await createApiError(response, 'https://api.example.com/voices/test-voice');
    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as NotFoundError).resource).toBe('test-voice');
  });

  it('should create RateLimitError for 429 with Retry-After', async () => {
    const response = createMockResponse(
      429,
      'Too Many Requests',
      { message: 'Rate limited' },
      {
        'Retry-After': '60',
      }
    );

    const error = await createApiError(response, 'https://api.example.com');
    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).retryAfter).toBe(60);
  });

  it('classifies a 429 as a retryable RateLimitError by status, ignoring the body code', async () => {
    const response = createMockResponse(
      429,
      'Too Many Requests',
      {
        error: {
          message: 'Too many concurrent streams',
          code: 'CONCURRENT_STREAM_LIMIT_EXCEEDED',
          statusCode: 429,
        },
      },
      { 'Retry-After': '30' }
    );

    const error = await createApiError(response, 'https://api.example.com');
    expect(error).toBeInstanceOf(RateLimitError);
    expect(error.isRetryable).toBe(true);
    expect((error as RateLimitError).retryAfter).toBe(30);
  });

  it('should create ApiError for other status codes', async () => {
    const response = createMockResponse(500, 'Internal Server Error', { message: 'Server error' });

    const error = await createApiError(response, 'https://api.example.com');
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(500);
  });

  it('should extract message from error.message', async () => {
    const response = createMockResponse(500, 'Internal Server Error', {
      message: 'Custom error message',
    });

    const error = await createApiError(response, 'https://api.example.com');
    expect(error.message).toBe('Custom error message');
  });

  it('should extract message from error string', async () => {
    const response = createMockResponse(500, 'Internal Server Error', { error: 'Error string' });

    const error = await createApiError(response, 'https://api.example.com');
    expect(error.message).toBe('Error string');
  });

  it('should handle non-JSON response', async () => {
    const response = makeNonJsonResponse(async () => 'Plain text error');

    const error = await createApiError(response, 'https://api.example.com');
    expect(error.message).toBe('Plain text error');
  });

  it('should use default message when body is empty', async () => {
    const response = makeNonJsonResponse(async () => {
      throw new Error('No text');
    });

    const error = await createApiError(response, 'https://api.example.com');
    expect(error.message).toBe('API request failed: 500 Internal Server Error');
  });

  it('should create RateLimitError with Retry-After as date', async () => {
    const futureDate = new Date(Date.now() + 120000); // 2 minutes in the future
    const response = createMockResponse(
      429,
      'Too Many Requests',
      { message: 'Rate limited' },
      {
        'Retry-After': futureDate.toUTCString(),
      }
    );

    const error = await createApiError(response, 'https://api.example.com');
    expect(error).toBeInstanceOf(RateLimitError);
    // Should be approximately 120 seconds (allow some tolerance)
    const retryAfter = (error as RateLimitError).retryAfter;
    expect(retryAfter).toBeGreaterThanOrEqual(118);
    expect(retryAfter).toBeLessThanOrEqual(122);
  });

  it('should handle RateLimitError without Retry-After header', async () => {
    const response = createMockResponse(429, 'Too Many Requests', { message: 'Rate limited' });

    const error = await createApiError(response, 'https://api.example.com');
    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).retryAfter).toBeUndefined();
  });

  it('should create ValidationError with null body', async () => {
    const response = createMockResponse(400, 'Bad Request', null);

    const error = await createApiError(response, 'https://api.example.com');
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).errors).toBeUndefined();
  });

  it('should create ValidationError when body has no errors object', async () => {
    const response = createMockResponse(400, 'Bad Request', {
      message: 'Validation failed',
      // No 'errors' property
    });

    const error = await createApiError(response, 'https://api.example.com');
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).errors).toBeUndefined();
  });

  it('should handle NotFoundError with invalid URL', async () => {
    const response = createMockResponse(404, 'Not Found', { message: 'Not found' });

    const error = await createApiError(response, 'not-a-valid-url');
    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as NotFoundError).resource).toBe('unknown');
  });

  it('should handle RateLimitError with invalid Retry-After date', async () => {
    const response = createMockResponse(
      429,
      'Too Many Requests',
      { message: 'Rate limited' },
      {
        'Retry-After': 'invalid-date-string',
      }
    );

    const error = await createApiError(response, 'https://api.example.com');
    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).retryAfter).toBeUndefined();
  });
});
