// Shared entry exports for `@responsivevoice/api-client`.
// Re-exported by both the Node entry (`index.ts`) and the browser entry
// (`index.browser.ts`). Contains everything safe to load in both
// environments. Node-only additions (e.g. FileStorage) live in `index.ts`.

// Re-export commonly used types from @responsivevoice/types for convenience
export type {
  AudioFormat,
  AudioResponse,
  StreamAudioChunk,
  StreamChunk,
  StreamEnd,
  StreamError,
  StreamMetadata,
  SynthesizeRequest,
  SynthesizeResponse,
  SystemVoice,
  TTSService,
  Voice,
  VoiceGender,
} from '@responsivevoice/types';
// Main client export
export { ResponsiveVoiceAPIClient, type VerifyOriginResponse } from './client';
// Error classes
export {
  ApiError,
  AuthError,
  NetworkError,
  NotFoundError,
  RateLimitError,
  ResponseValidationError,
  ResponsiveVoiceError,
  RetryExhaustedError,
  TimeoutError,
  ValidationError,
} from './errors';
// Retry utilities
export {
  calculateRetryDelay,
  createRetryWrapper,
  DEFAULT_RETRY_CONFIG,
  isRetryableError,
  type RetryConfig,
  type RetryDecision,
  withRetry,
} from './retry';
// Client-specific types
export type {
  CachedVoiceData,
  CacheStorageAdapter,
  CacheStorageType,
  RateLimitInfo,
  RequestOptions,
  ResolvedClientConfig,
  ResponsiveVoiceAPIClientConfig,
  VoiceCacheConfig,
  VoiceFilters,
} from './types';
// Voice cache
export { ClientVoiceCache, MemoryStorage } from './voice-cache';
// WebSocket streaming connection
export { WebSocketConnection, type WebSocketConnectionConfig } from './websocket';
