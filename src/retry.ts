/**
 * Retry utilities with exponential backoff
 */

import { ApiError, NetworkError, RetryExhaustedError } from './errors';

/**
 * Configuration for retry behavior
 */
export interface RetryConfig {
  /** Maximum number of retry attempts (not including the initial request) */
  maxAttempts: number;

  /** Base delay between retries in milliseconds */
  baseDelay: number;

  /** Maximum delay between retries in milliseconds */
  maxDelay: number;

  /** Multiplier for exponential backoff */
  backoffMultiplier: number;

  /** Whether to add jitter to delay times */
  jitter: boolean;
}

/**
 * Default retry configuration
 */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  baseDelay: 1000,
  maxDelay: 30000,
  backoffMultiplier: 2,
  jitter: true,
};

/**
 * Result of checking if an error is retryable
 */
export interface RetryDecision {
  /** Whether the operation should be retried */
  shouldRetry: boolean;

  /** Suggested delay before retrying, in milliseconds */
  delay?: number;
}

/**
 * Determine if an error is retryable
 */
export function isRetryableError(error: unknown): RetryDecision {
  // Network errors are always retryable
  if (error instanceof NetworkError) {
    return { shouldRetry: true };
  }

  // API errors with specific status codes
  if (error instanceof ApiError) {
    // Rate limit errors - use retry-after if available
    if (error.status === 429) {
      const rateLimitError = error as ApiError & { retryAfter?: number };
      return {
        shouldRetry: true,
        delay: rateLimitError.retryAfter ? rateLimitError.retryAfter * 1000 : undefined,
      };
    }

    // Server errors (5xx) are retryable
    if (error.isServerError) {
      return { shouldRetry: true };
    }

    // Client errors (4xx except 429) are not retryable
    return { shouldRetry: false };
  }

  // Unknown errors - don't retry to be safe
  return { shouldRetry: false };
}

/**
 * Calculate delay for a retry attempt using exponential backoff
 *
 * @param attempt - The retry attempt number (1-based)
 * @param config - Retry configuration
 * @param suggestedDelay - Optional suggested delay (e.g., from Retry-After header)
 * @returns Delay in milliseconds
 */
export function calculateRetryDelay(
  attempt: number,
  config: RetryConfig,
  suggestedDelay?: number
): number {
  // If a suggested delay is provided (e.g., from Retry-After), use it
  if (suggestedDelay !== undefined && suggestedDelay > 0) {
    return Math.min(suggestedDelay, config.maxDelay);
  }

  // Calculate exponential backoff
  const exponentialDelay = config.baseDelay * config.backoffMultiplier ** (attempt - 1);
  let delay = Math.min(exponentialDelay, config.maxDelay);

  // Add jitter to prevent thundering herd
  if (config.jitter) {
    // Add random jitter of +/- 25%
    const jitterRange = delay * 0.25;
    const jitter = Math.random() * jitterRange * 2 - jitterRange;
    delay = Math.max(0, delay + jitter);
  }

  return Math.round(delay);
}

/**
 * Sleep for a specified duration
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute a function with retry logic
 *
 * @param fn - The async function to execute
 * @param config - Retry configuration (partial, merged with defaults)
 * @returns The result of the function
 * @throws RetryExhaustedError if all retries fail
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  config: Partial<RetryConfig> = {}
): Promise<T> {
  const fullConfig: RetryConfig = { ...DEFAULT_RETRY_CONFIG, ...config };
  const totalAttempts = fullConfig.maxAttempts + 1; // Include initial attempt

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Check if we should retry
      const decision = isRetryableError(error);

      // If not retryable or this was the last attempt, throw
      if (!decision.shouldRetry || attempt === totalAttempts) {
        if (attempt > 1) {
          // If we retried at least once, wrap in RetryExhaustedError
          throw new RetryExhaustedError(
            `Operation failed after ${attempt} attempts`,
            attempt,
            lastError
          );
        }
        throw lastError;
      }

      // Calculate delay and wait
      const delay = calculateRetryDelay(attempt, fullConfig, decision.delay);
      await sleep(delay);
    }
  }

  // This should never happen, but TypeScript needs it
  throw new RetryExhaustedError(
    `Operation failed after ${totalAttempts} attempts`,
    totalAttempts,
    lastError!
  );
}

/**
 * Create a retry wrapper with pre-configured settings
 */
export function createRetryWrapper(config: Partial<RetryConfig> = {}) {
  return <T>(fn: () => Promise<T>) => withRetry(fn, config);
}
