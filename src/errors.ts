/**
 * Custom error classes for ResponsiveVoice API Client
 * Provides a hierarchy of errors for different failure scenarios
 */

/**
 * Base error class for all API client errors
 */
export class ResponsiveVoiceError extends Error {
  /** Original error that caused this error, if any */
  public readonly cause?: Error;

  constructor(message: string, cause?: Error) {
    super(message);
    this.name = 'ResponsiveVoiceError';
    this.cause = cause;

    // Maintains proper stack trace for where error was thrown (only in V8)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/**
 * Error thrown when an API request fails
 */
export class ApiError extends ResponsiveVoiceError {
  /** HTTP status code of the failed request */
  public readonly status: number;

  /** HTTP status text */
  public readonly statusText: string;

  /** Response body, if available */
  public readonly body?: unknown;

  /** Request URL that failed */
  public readonly url: string;

  constructor(
    message: string,
    status: number,
    statusText: string,
    url: string,
    body?: unknown,
    cause?: Error
  ) {
    super(message, cause);
    this.name = 'ApiError';
    this.status = status;
    this.statusText = statusText;
    this.url = url;
    this.body = body;
  }

  /**
   * Check if this error is a client error (4xx)
   */
  get isClientError(): boolean {
    return this.status >= 400 && this.status < 500;
  }

  /**
   * Check if this error is a server error (5xx)
   */
  get isServerError(): boolean {
    return this.status >= 500 && this.status < 600;
  }

  /**
   * Check if this error is retryable
   * Server errors (5xx) and rate limits (429) are retryable
   */
  get isRetryable(): boolean {
    return this.isServerError || this.status === 429;
  }
}

/**
 * Error thrown when authentication fails (401/403)
 */
export class AuthError extends ApiError {
  constructor(message: string, status: number, statusText: string, url: string, body?: unknown) {
    super(message, status, statusText, url, body);
    this.name = 'AuthError';
  }
}

/**
 * Error thrown when a resource is not found (404)
 */
export class NotFoundError extends ApiError {
  /** The resource that was not found */
  public readonly resource: string;

  constructor(
    message: string,
    resource: string,
    status: number,
    statusText: string,
    url: string,
    body?: unknown
  ) {
    super(message, status, statusText, url, body);
    this.name = 'NotFoundError';
    this.resource = resource;
  }
}

/**
 * Error thrown when rate limited (429)
 */
export class RateLimitError extends ApiError {
  /** Time in seconds to wait before retrying, if provided by the API */
  public readonly retryAfter?: number;

  constructor(
    message: string,
    status: number,
    statusText: string,
    url: string,
    retryAfter?: number,
    body?: unknown
  ) {
    super(message, status, statusText, url, body);
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
  }
}

/**
 * Error thrown when request validation fails (400)
 */
export class ValidationError extends ApiError {
  /** Validation error details, if provided by the API */
  public readonly errors?: Record<string, string[]>;

  constructor(
    message: string,
    status: number,
    statusText: string,
    url: string,
    errors?: Record<string, string[]>,
    body?: unknown
  ) {
    super(message, status, statusText, url, body);
    this.name = 'ValidationError';
    this.errors = errors;
  }
}

/**
 * Error thrown when a network error occurs
 */
export class NetworkError extends ResponsiveVoiceError {
  /** Request URL that failed */
  public readonly url: string;

  constructor(message: string, url: string, cause?: Error) {
    super(message, cause);
    this.name = 'NetworkError';
    this.url = url;
  }

  /**
   * Network errors are always retryable
   */
  get isRetryable(): boolean {
    return true;
  }
}

/**
 * Error thrown when a request times out
 */
export class TimeoutError extends NetworkError {
  /** Timeout duration in milliseconds */
  public readonly timeout: number;

  constructor(message: string, url: string, timeout: number, cause?: Error) {
    super(message, url, cause);
    this.name = 'TimeoutError';
    this.timeout = timeout;
  }
}

/**
 * Error thrown when all retry attempts are exhausted
 */
export class RetryExhaustedError extends ResponsiveVoiceError {
  /** Number of attempts made */
  public readonly attempts: number;

  /** The last error that occurred */
  public readonly lastError: Error;

  constructor(message: string, attempts: number, lastError: Error) {
    super(message, lastError);
    this.name = 'RetryExhaustedError';
    this.attempts = attempts;
    this.lastError = lastError;
  }
}

/**
 * Error thrown when API response validation fails
 * This is for client-side validation of response data against expected schemas
 */
export class ResponseValidationError extends ResponsiveVoiceError {
  /** Detailed validation issues from Zod */
  public readonly issues: Array<{ path: string; message: string }>;

  /** The raw response data that failed validation */
  public readonly data: unknown;

  constructor(message: string, issues: Array<{ path: string; message: string }>, data: unknown) {
    super(message);
    this.name = 'ResponseValidationError';
    this.issues = issues;
    this.data = data;
  }

  /**
   * Get a formatted string of all validation issues
   */
  get formattedIssues(): string {
    return this.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ');
  }
}

/**
 * Create an appropriate error from an API response
 */
export async function createApiError(response: Response, url: string): Promise<ApiError> {
  const status = response.status;
  const statusText = response.statusText;
  const contentType = response.headers.get('Content-Type') || '';
  const isHtml = contentType.includes('text/html');

  let body: unknown;
  try {
    if (isHtml) {
      body = await response.text();
    } else {
      body = await response.json();
    }
  } catch {
    try {
      body = await response.text();
    } catch {
      body = undefined;
    }
  }

  const message = extractErrorMessage(body) || `API request failed: ${status} ${statusText}`;

  switch (status) {
    case 400:
      return new ValidationError(
        message,
        status,
        statusText,
        url,
        extractValidationErrors(body),
        body
      );

    case 401:
    case 403:
      return new AuthError(message, status, statusText, url, body);

    case 404:
      return new NotFoundError(message, extractResource(url), status, statusText, url, body);

    case 429:
      return new RateLimitError(
        message,
        status,
        statusText,
        url,
        extractRetryAfter(response),
        body
      );

    default:
      return new ApiError(message, status, statusText, url, body);
  }
}

/**
 * Extract error message from response body
 */
function extractErrorMessage(body: unknown): string | undefined {
  if (typeof body === 'string') {
    // Don't use HTML responses as error messages
    if (body.trimStart().startsWith('<')) {
      return undefined;
    }
    return body;
  }

  if (typeof body === 'object' && body !== null) {
    const obj = body as Record<string, unknown>;

    if (typeof obj.message === 'string') {
      return obj.message;
    }

    if (typeof obj.error === 'string') {
      return obj.error;
    }

    if (typeof obj.error === 'object' && obj.error !== null) {
      const errorObj = obj.error as Record<string, unknown>;
      if (typeof errorObj.message === 'string') {
        return errorObj.message;
      }
    }
  }

  return undefined;
}

/**
 * Extract validation errors from response body
 */
function extractValidationErrors(body: unknown): Record<string, string[]> | undefined {
  if (typeof body !== 'object' || body === null) {
    return undefined;
  }

  const obj = body as Record<string, unknown>;

  if (typeof obj.errors === 'object' && obj.errors !== null) {
    return obj.errors as Record<string, string[]>;
  }

  return undefined;
}

/**
 * Extract retry-after header value
 */
function extractRetryAfter(response: Response): number | undefined {
  const retryAfter = response.headers.get('Retry-After');

  if (!retryAfter) {
    return undefined;
  }

  // Retry-After can be a number of seconds or a date
  const seconds = parseInt(retryAfter, 10);

  if (!Number.isNaN(seconds)) {
    return seconds;
  }

  // Try to parse as a date
  const date = new Date(retryAfter);

  if (!Number.isNaN(date.getTime())) {
    const now = Date.now();
    const diff = date.getTime() - now;
    return Math.max(0, Math.ceil(diff / 1000));
  }

  return undefined;
}

/**
 * Extract resource name from URL for NotFoundError
 */
function extractResource(url: string): string {
  try {
    const urlObj = new URL(url);
    const pathParts = urlObj.pathname.split('/').filter(Boolean);
    return pathParts[pathParts.length - 1] || 'unknown';
  } catch {
    return 'unknown';
  }
}
