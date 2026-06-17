// Client-specific types for the ResponsiveVoice API Client.
// Extends types from `@responsivevoice/types`.

import type { VoiceGender } from '@responsivevoice/types';

/**
 * Storage adapter interface for plugging in custom cache backends.
 * All methods may return synchronously or asynchronously.
 */
export interface CacheStorageAdapter {
  /** Retrieve a value by key, or `null` if not present. */
  getItem(key: string): string | null | Promise<string | null>;
  /** Store a value under `key`, overwriting any existing entry. */
  setItem(key: string, value: string): void | Promise<void>;
  /** Remove the value stored under `key`. No-op if absent. */
  removeItem(key: string): void | Promise<void>;
}

/**
 * Storage type for voice cache.
 * - `'auto'` (default): detects environment and picks the best backend
 * - `'localStorage'`: force browser localStorage
 * - `'sessionStorage'`: force browser sessionStorage
 * - `'filesystem'`: force Node.js filesystem (os.tmpdir())
 * - `'memory'`: force in-memory Map (process/page lifetime only)
 */
export type CacheStorageType = 'auto' | 'localStorage' | 'sessionStorage' | 'filesystem' | 'memory';

/**
 * Configuration for the client-side voice cache.
 */
export interface VoiceCacheConfig {
  /** Whether caching is enabled (default: true) */
  enabled?: boolean;

  /** Storage backend selection (default: 'auto') */
  storage?: CacheStorageType;

  /** Custom storage adapter — overrides `storage` when provided */
  customStorage?: CacheStorageAdapter;

  /** Key prefix for cache entries (default: 'rv-voice-cache') */
  keyPrefix?: string;

  /** Cache TTL in seconds — cached data within this window is served without a network request (default: 300) */
  ttl?: number;

  /** API key used to scope cache keys per-website (prevents cross-site cache collisions on same domain) */
  apiKey?: string;
}

/**
 * Cached voice data stored in the client-side cache.
 */
export interface CachedVoiceData {
  /** ETag from the server response */
  etag: string;
  /** Cached voice collection */
  voices: VoiceData[];
  /** Cached system voices (dense; reachable from voices[*].voiceIDs chains) */
  systemVoices?: SystemVoiceResponse[];
  /** Timestamp when the data was cached */
  cachedAt: number;
}

/**
 * Configuration for the ResponsiveVoice API client
 */
export interface ResponsiveVoiceAPIClientConfig {
  /** API key — account identifier; never used as a credential alone. */
  apiKey: string;

  /**
   * Server-issued secret paired with `apiKey`. When set, the client
   * attaches `X-API-Key` + `X-API-Secret` headers to every request.
   * For server-to-server callers only — should not be used in browser
   * code.
   */
  apiSecret?: string;

  /**
   * Hook returning auth headers to attach to every request. Called per
   * request, so the caller can return a fresh bearer token each time
   * (e.g. core injects `Authorization: Bearer <jwt>` here after a
   * handshake). Headers returned merge into the request, overriding
   * any conflicting `X-API-Key`/`X-API-Secret`. May return synchronously
   * or as a Promise — the client awaits the result.
   */
  authHeaders?: () => Record<string, string> | Promise<Record<string, string>>;

  /**
   * Hook fired when a response carries an `X-RV-Auth-Renewed` header
   * (sliding renewal piggy-back from tts-api). Receives the fresh token
   * + exp so the caller can swap its stored bearer transparently.
   */
  onTokenRenewed?: (renewed: { token: string; exp: number }) => void;

  /** Base URL for the API (default: `https://texttospeech.responsivevoice.org/v2`) */
  baseUrl?: string;

  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;

  /** Number of retry attempts for transient errors (default: 3) */
  retryAttempts?: number;

  /** Base delay between retries in milliseconds (default: 1000) */
  retryDelay?: number;

  /** Custom fetch implementation (for testing or server-side usage) */
  fetch?: typeof fetch;

  /** Voice cache configuration (enabled by default) */
  voiceCache?: VoiceCacheConfig;

  /** Callback invoked when the server assigns a different URL via X-Server-URL header */
  onServerUrlChange?: (newUrl: string) => void;

  /**
   * Hook fired on every response carrying rate-limit headers
   * (`X-RateLimit-Limit`/`X-RateLimit-Remaining`/`Retry-After`). Lets callers
   * pace requests against the advertised allowance rather than discovering the
   * limit only by hitting 429s.
   */
  onRateLimit?: (info: RateLimitInfo) => void;
}

/** Rate-limit headers surfaced from a response; a field is null when absent. */
export interface RateLimitInfo {
  /** `X-RateLimit-Limit` — max requests per window. */
  limit: number | null;
  /** `X-RateLimit-Remaining` — requests left in the current window. */
  remaining: number | null;
  /** `Retry-After` — seconds to wait, present on 429. */
  retryAfter: number | null;
}

/**
 * Resolved configuration with all defaults applied
 */
export interface ResolvedClientConfig {
  /** API key used to authenticate every request. */
  apiKey: string;
  /** Server-issued secret; null when unset (browser callers). */
  apiSecret: string | null;
  /** Auth-header injection hook; null when unset (server callers using only apiKey+secret). */
  authHeaders: (() => Record<string, string> | Promise<Record<string, string>>) | null;
  /** Sliding-renewal pickup callback; null when unset. */
  onTokenRenewed: ((renewed: { token: string; exp: number }) => void) | null;
  /** Fully-resolved base URL for the TTS API (no trailing slash). */
  baseUrl: string;
  /** Per-request timeout in milliseconds. */
  timeout: number;
  /** Max retry attempts for transient failures. */
  retryAttempts: number;
  /** Base delay between retries in milliseconds (exponential backoff multiplies this). */
  retryDelay: number;
  /** Fetch implementation (defaults to the global `fetch`). */
  fetch: typeof fetch;
  /** Voice-cache configuration resolved with defaults applied. */
  voiceCache: VoiceCacheConfig;
  /** Callback invoked when the server assigns a new base URL (`X-RV-Server-URL` header). */
  onServerUrlChange: ((newUrl: string) => void) | null;
  /** Rate-limit header observer; null when unset. */
  onRateLimit: ((info: RateLimitInfo) => void) | null;
}

/**
 * Filters for listing voices
 */
export interface VoiceFilters {
  /** Filter by language code */
  lang?: string;

  /** Filter by gender */
  gender?: VoiceGender;

  /** Platform context for personalized voice selection (not a filter for cache bypass) */
  browser?: string;
  /** Browser version (paired with `browser` for platform-aware voice resolution) */
  browserVersion?: string;
  /** Operating system name (paired with `os_version` for platform-aware voice resolution) */
  os?: string;
  /** Operating system version (paired with `os` for platform-aware voice resolution) */
  osVersion?: string;
}

/**
 * Request options for API calls
 */
export interface RequestOptions {
  /** Custom timeout for this request */
  timeout?: number;

  /** Custom signal for abort control */
  signal?: AbortSignal;

  /** Skip retry logic for this request */
  skipRetry?: boolean;
}

/**
 * Voice list response from the API
 */
export interface VoicesResponse {
  voices: VoiceData[];
  /** System voices (dense array; only entries reachable from voices[*].voiceIDs chains) */
  systemVoices?: SystemVoiceResponse[];
  count?: number;
}

/**
 * Voice data from the API. Runtime-transport mirror of the canonical `Voice`
 * type in `@responsivevoice/types`.
 *
 * @internal
 * TODO: replace with `Voice` from `@responsivevoice/types`. This interface
 * duplicates the canonical shape and was added to avoid a Zod import in
 * api-client — but `Voice` is a pure `z.infer<>` type alias so importing it
 * carries no runtime cost. Migration: change `CachedVoiceData.voices`, the
 * `setVoices()` signature, and every internal use site to `Voice[]`.
 */
export interface VoiceData {
  name: string;
  flag: string;
  gender: 'f' | 'm';
  lang: string;
  voiceIDs: number[];
  deprecated?: boolean;
  /** Whether this voice requires user-provided API keys (BYOK) */
  isByok?: boolean;
  /** Human-readable provider name for BYOK voices (e.g., "Google Cloud WaveNet") */
  provider?: string;
}

/**
 * System voice response from the API. Runtime-transport mirror of the
 * canonical `SystemVoice` type in `@responsivevoice/types`.
 *
 * @internal
 * TODO: replace with `SystemVoice` from `@responsivevoice/types`. Same
 * situation as `VoiceData` above — this duplicates the canonical Zod-
 * inferred type and was added to avoid a Zod import. Migrate usages in
 * `CachedVoiceData.systemVoices`, the `setVoices()` signature, and
 * everywhere else to `SystemVoice[]`.
 */
export interface SystemVoiceResponse {
  /** Catalog voice ID. Required — used as the lookup key on the client. */
  id: number;
  name: string;
  lang?: string;
  rate?: number;
  pitch?: number;
  timerSpeed?: number;
  /** Whether this is a fallback voice (HTTP audio) */
  fallbackVoice?: boolean;
  service?: 'g1' | 'g2' | 'g3' | 'g5';
  /** Service-specific voice identifier */
  voiceName?: string;
  gender?: string;
  volume?: number;
  deprecated?: boolean;
}
