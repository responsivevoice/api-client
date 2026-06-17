/**
 * Tests for retry utilities
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, NetworkError, RetryExhaustedError, TimeoutError } from '../errors';
import {
  calculateRetryDelay,
  createRetryWrapper,
  DEFAULT_RETRY_CONFIG,
  isRetryableError,
  type RetryConfig,
  withRetry,
} from '../retry';

describe('isRetryableError', () => {
  it('should mark NetworkError as retryable', () => {
    const error = new NetworkError('Network failed', 'https://api.example.com');
    const decision = isRetryableError(error);
    expect(decision.shouldRetry).toBe(true);
  });

  it('should mark TimeoutError as retryable', () => {
    const error = new TimeoutError('Timeout', 'https://api.example.com', 30000);
    const decision = isRetryableError(error);
    expect(decision.shouldRetry).toBe(true);
  });

  it('should mark 5xx errors as retryable', () => {
    const error500 = new ApiError(
      'Server error',
      500,
      'Internal Server Error',
      'https://api.example.com'
    );
    const error502 = new ApiError('Bad gateway', 502, 'Bad Gateway', 'https://api.example.com');
    const error503 = new ApiError(
      'Unavailable',
      503,
      'Service Unavailable',
      'https://api.example.com'
    );

    expect(isRetryableError(error500).shouldRetry).toBe(true);
    expect(isRetryableError(error502).shouldRetry).toBe(true);
    expect(isRetryableError(error503).shouldRetry).toBe(true);
  });

  it('should mark 429 as retryable with delay', () => {
    const error = Object.assign(
      new ApiError('Rate limited', 429, 'Too Many Requests', 'https://api.example.com'),
      { retryAfter: 60 }
    );
    const decision = isRetryableError(error);
    expect(decision.shouldRetry).toBe(true);
    expect(decision.delay).toBe(60000); // 60 seconds in ms
  });

  it('should not mark 4xx errors (except 429) as retryable', () => {
    const error400 = new ApiError('Bad request', 400, 'Bad Request', 'https://api.example.com');
    const error401 = new ApiError('Unauthorized', 401, 'Unauthorized', 'https://api.example.com');
    const error404 = new ApiError('Not found', 404, 'Not Found', 'https://api.example.com');

    expect(isRetryableError(error400).shouldRetry).toBe(false);
    expect(isRetryableError(error401).shouldRetry).toBe(false);
    expect(isRetryableError(error404).shouldRetry).toBe(false);
  });

  it('should not mark unknown errors as retryable', () => {
    const error = new Error('Unknown error');
    const decision = isRetryableError(error);
    expect(decision.shouldRetry).toBe(false);
  });
});

describe('calculateRetryDelay', () => {
  const baseConfig: RetryConfig = {
    ...DEFAULT_RETRY_CONFIG,
    jitter: false, // Disable jitter for predictable tests
  };

  it('should calculate exponential backoff', () => {
    expect(calculateRetryDelay(1, baseConfig)).toBe(1000);
    expect(calculateRetryDelay(2, baseConfig)).toBe(2000);
    expect(calculateRetryDelay(3, baseConfig)).toBe(4000);
    expect(calculateRetryDelay(4, baseConfig)).toBe(8000);
  });

  it('should respect max delay', () => {
    const config: RetryConfig = { ...baseConfig, maxDelay: 5000 };
    expect(calculateRetryDelay(10, config)).toBe(5000);
  });

  it('should use suggested delay when provided', () => {
    const delay = calculateRetryDelay(1, baseConfig, 10000);
    expect(delay).toBe(10000);
  });

  it('should cap suggested delay to max delay', () => {
    const config: RetryConfig = { ...baseConfig, maxDelay: 5000 };
    const delay = calculateRetryDelay(1, config, 10000);
    expect(delay).toBe(5000);
  });

  it('should add jitter when enabled', () => {
    const config: RetryConfig = { ...baseConfig, jitter: true };
    const delays = new Set<number>();

    // Run multiple times to verify randomness
    for (let i = 0; i < 10; i++) {
      delays.add(calculateRetryDelay(1, config));
    }

    // With jitter, we should get some variation
    // All delays should be within +/- 25% of 1000
    for (const delay of delays) {
      expect(delay).toBeGreaterThanOrEqual(750);
      expect(delay).toBeLessThanOrEqual(1250);
    }
  });
});

describe('withRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should return result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('success');

    const promise = withRetry(fn, { maxAttempts: 3 });
    const result = await promise;

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should retry on retryable error', async () => {
    const error = new NetworkError('Network failed', 'https://api.example.com');
    const fn = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce('success');

    const promise = withRetry(fn, { maxAttempts: 3, jitter: false });

    // First attempt fails immediately
    await vi.advanceTimersByTimeAsync(0);

    // Wait for first retry delay
    await vi.advanceTimersByTimeAsync(1000);

    // Wait for second retry delay
    await vi.advanceTimersByTimeAsync(2000);

    const result = await promise;
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('should not retry non-retryable errors', async () => {
    const error = new ApiError('Not found', 404, 'Not Found', 'https://api.example.com');
    const fn = vi.fn().mockRejectedValue(error);

    await expect(withRetry(fn, { maxAttempts: 3 })).rejects.toThrow(error);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should throw RetryExhaustedError when all retries fail', async () => {
    vi.useRealTimers(); // Use real timers for this test to avoid unhandled rejection

    const error = new NetworkError('Network failed', 'https://api.example.com');
    const fn = vi.fn().mockRejectedValue(error);

    await expect(
      withRetry(fn, { maxAttempts: 2, baseDelay: 1, maxDelay: 10, jitter: false })
    ).rejects.toThrow(RetryExhaustedError);

    expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries

    vi.useFakeTimers(); // Restore fake timers for subsequent tests
  });

  it('should use suggested delay from rate limit error', async () => {
    const rateLimitError = Object.assign(
      new ApiError('Rate limited', 429, 'Too Many Requests', 'https://api.example.com'),
      { retryAfter: 5 }
    );
    const fn = vi.fn().mockRejectedValueOnce(rateLimitError).mockResolvedValueOnce('success');

    const promise = withRetry(fn, { maxAttempts: 3, jitter: false });

    await vi.advanceTimersByTimeAsync(0);

    // Should wait 5000ms (5 seconds * 1000)
    await vi.advanceTimersByTimeAsync(5000);

    const result = await promise;
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('createRetryWrapper', () => {
  it('should create a wrapper with preset config', async () => {
    const wrapper = createRetryWrapper({ maxAttempts: 1 });
    const fn = vi.fn().mockResolvedValue('success');

    const result = await wrapper(fn);
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('DEFAULT_RETRY_CONFIG', () => {
  it('should have sensible defaults', () => {
    expect(DEFAULT_RETRY_CONFIG.maxAttempts).toBe(3);
    expect(DEFAULT_RETRY_CONFIG.baseDelay).toBe(1000);
    expect(DEFAULT_RETRY_CONFIG.maxDelay).toBe(30000);
    expect(DEFAULT_RETRY_CONFIG.backoffMultiplier).toBe(2);
    expect(DEFAULT_RETRY_CONFIG.jitter).toBe(true);
  });
});
