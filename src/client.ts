/**
 * ResponsiveVoice API Client
 * TypeScript REST client for texttospeech.responsivevoice.org
 */

import type {
  AudioFormat,
  AudioResponse,
  AuthToken,
  StreamChunk,
  SynthesizeRequest,
  SystemVoice,
  Voice,
  VoiceReportRequest,
  VoiceReportResponse,
  WebsiteConfigResponse,
} from '@responsivevoice/types';

import {
  AuthTokenSchema,
  parseProsodyApplied,
  STREAMING_ACCEPT_TYPE,
  SystemVoiceSchema,
  VoiceReportResponseSchema,
  VoiceSchema,
  WebsiteConfigResponseSchema,
} from '@responsivevoice/types';

import { z } from 'zod';

import { createApiError, NetworkError, ResponseValidationError, TimeoutError } from './errors';

import { type RetryConfig, withRetry } from './retry';

import type {
  CachedVoiceData,
  RequestOptions,
  ResolvedClientConfig,
  ResponsiveVoiceAPIClientConfig,
  SystemVoiceResponse,
  VoiceFilters,
  VoicesResponse,
} from './types';

import { ClientVoiceCache } from './voice-cache';

/**
 * Default configuration values
 */
const DEFAULTS = {
  baseUrl: 'https://texttospeech.responsivevoice.org/v2',
  timeout: 30000,
  retryAttempts: 3,
  retryDelay: 1000,
} as const;

const VerifyOriginResponseSchema = z.object({
  verified: z.boolean(),
  origin: z.string(),
});

/** Response from `POST /v2/auth/verify-origin`. */
export interface VerifyOriginResponse {
  /** Whether the request origin was verified for the apiKey. */
  verified: boolean;
  /** The proven origin (`scheme://host[:port]`). */
  origin: string;
}

/**
 * ResponsiveVoice API Client
 *
 * Provides methods to interact with the ResponsiveVoice TTS API:
 * - Synthesize text to speech
 * - List available voices
 * - Get specific voice information
 *
 * @example
 * ```typescript
 * const client = new ResponsiveVoiceAPIClient({ apiKey: 'your-api-key' });
 *
 * // Synthesize text
 * const audio = await client.synthesize({
 *   text: 'Hello, world!',
 *   lang: 'en-US',
 * });
 *
 * // Play the audio
 * const audioElement = new Audio(audio.url);
 * audioElement.play();
 * ```
 */
export class ResponsiveVoiceAPIClient {
  private config: ResolvedClientConfig;
  private readonly voiceCache: Pick<
    ClientVoiceCache,
    | 'getVoices'
    | 'setVoices'
    | 'clear'
    | 'enabled'
    | 'isFresh'
    | 'getBrowserVoiceHash'
    | 'setBrowserVoiceHash'
  >;

  /**
   * Create a new ResponsiveVoice API client
   *
   * @param config - Client configuration
   * @throws Error if apiKey is not provided
   */
  constructor(config: ResponsiveVoiceAPIClientConfig) {
    if (!config.apiKey) {
      throw new Error('API key is required');
    }

    const baseUrl = config.baseUrl ?? DEFAULTS.baseUrl;

    this.config = {
      apiKey: config.apiKey,
      apiSecret: config.apiSecret ?? null,
      authHeaders: config.authHeaders ?? null,
      onTokenRenewed: config.onTokenRenewed ?? null,
      baseUrl,
      timeout: config.timeout ?? DEFAULTS.timeout,
      retryAttempts: config.retryAttempts ?? DEFAULTS.retryAttempts,
      retryDelay: config.retryDelay ?? DEFAULTS.retryDelay,
      fetch:
        config.fetch ??
        globalThis.fetch?.bind(globalThis) ??
        ((() => {
          throw new Error(
            'fetch is not available in this environment. ' +
              'Pass a fetch implementation via the fetch config option ' +
              "(e.g. 'node-fetch' or 'undici' on Node.js < 18)."
          );
        }) as typeof globalThis.fetch),
      voiceCache: config.voiceCache ?? {},
      onServerUrlChange: config.onServerUrlChange ?? null,
      onRateLimit: config.onRateLimit ?? null,
    };

    const voiceCacheConfig: typeof config.voiceCache = {
      ...config.voiceCache,
      apiKey: config.voiceCache?.apiKey ?? config.apiKey,
    };
    this.voiceCache = ClientVoiceCache.create(voiceCacheConfig);

    // Migrate legacy unscoped voice cache entries
    if (this.voiceCache instanceof ClientVoiceCache) {
      this.voiceCache.migrateVoiceCache().catch(() => {
        // Migration is best-effort
      });
    }
  }

  /**
   * Update the base URL for subsequent requests.
   * Called internally when X-Server-URL header is received,
   * or externally by consumers.
   */
  updateBaseUrl(newUrl: string): void {
    this.config = { ...this.config, baseUrl: newUrl };
  }

  /**
   * Get the current base URL
   */
  get baseUrl(): string {
    return this.config.baseUrl;
  }

  /**
   * Synthesize text to speech
   *
   * Converts text to audio using the specified voice and parameters.
   * Returns an AudioResponse with a Blob and URL that can be used for playback.
   *
   * @param options - Synthesis options including text, language, and voice parameters
   * @param requestOptions - Optional request configuration
   * @returns Promise resolving to AudioResponse with audio blob and URL
   *
   * @example
   * ```typescript
   * const audio = await client.synthesize({
   *   text: 'Hello, world!',
   *   voice: 'US English Female',
   * });
   *
   * console.log(`Audio format: ${audio.format}`);
   * console.log(`Audio URL: ${audio.url}`);
   * ```
   */
  async synthesize(
    options: SynthesizeRequest,
    requestOptions?: RequestOptions
  ): Promise<AudioResponse> {
    const synthParams = new URLSearchParams();
    synthParams.set('text', options.text);
    if (options.voice) synthParams.set('voice', options.voice);
    if (options.lang) synthParams.set('lang', options.lang);
    if (options.engine) synthParams.set('engine', options.engine);
    if (options.name) synthParams.set('name', options.name);
    if (options.gender) synthParams.set('gender', options.gender);
    if (options.pitch !== undefined) synthParams.set('pitch', String(options.pitch));
    if (options.rate !== undefined) synthParams.set('rate', String(options.rate));
    if (options.volume !== undefined) synthParams.set('volume', String(options.volume));
    if (options.format) synthParams.set('format', options.format);
    const url = this.buildUrl(`/text/synthesize?${synthParams.toString()}`);

    const response = await this.request<Blob>({
      method: 'GET',
      url,
      responseType: 'blob',
      ...requestOptions,
    });

    const format = this.extractAudioFormat(response.contentType, options.format);
    const prosodyApplied = parseProsodyApplied(response.headers?.get('RV-Prosody-Applied') ?? null);

    return {
      blob: response.data!,
      url: URL.createObjectURL(response.data!),
      format,
      duration: response.duration,
      prosodyApplied: [...prosodyApplied],
    };
  }

  /**
   * Synthesize text to speech with HTTP streaming.
   *
   * Returns an AsyncGenerator that yields StreamChunk objects as audio data
   * arrives from the server. The server streams audio incrementally as it is
   * synthesized (HTTP audio streaming), reducing time-to-first-byte.
   *
   * @param options - Synthesis options (same as synthesize())
   * @param requestOptions - Optional request configuration (timeout, signal)
   * @returns AsyncGenerator yielding StreamChunk objects
   *
   * @example
   * ```typescript
   * const chunks: Uint8Array[] = [];
   * for await (const chunk of client.synthesizeStream({ text: 'Hello', lang: 'en-US' })) {
   *   if (chunk.type === 'audio') chunks.push(chunk.data);
   *   if (chunk.type === 'end') console.log(`${chunk.totalBytes} bytes`);
   * }
   * ```
   */
  async *synthesizeStream(
    options: SynthesizeRequest,
    requestOptions?: RequestOptions
  ): AsyncGenerator<StreamChunk> {
    const url = this.buildUrl('/text/synthesize');
    const timeout = requestOptions?.timeout ?? this.config.timeout;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const signal = requestOptions?.signal
      ? this.combineAbortSignals(requestOptions.signal, controller.signal)
      : controller.signal;

    try {
      const response = await this.config.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: STREAMING_ACCEPT_TYPE },
        body: JSON.stringify({
          text: options.text,
          voice: options.voice,
          lang: options.lang,
          engine: options.engine,
          name: options.name,
          gender: options.gender,
          pitch: options.pitch,
          rate: options.rate,
          volume: options.volume,
          format: options.format,
        }),
        signal,
      });

      clearTimeout(timeoutId);

      // Check server URL header on streaming responses too
      this.checkServerUrlHeader(response.headers);

      if (!response.ok) {
        const error = await createApiError(response, url);
        yield {
          type: 'error' as const,
          message: error.message,
          retryable: error.isRetryable,
        };
        return;
      }

      const contentType = response.headers.get('Content-Type') || 'audio/mpeg';
      const prosodyApplied = [...parseProsodyApplied(response.headers.get('RV-Prosody-Applied'))];
      yield { type: 'metadata' as const, contentType, prosodyApplied };

      if (!response.body) {
        yield {
          type: 'error' as const,
          message: 'Response body is not readable (streaming not supported in this environment)',
          retryable: false,
        };
        return;
      }

      const reader = response.body.getReader();
      let chunkIndex = 0;
      let totalBytes = 0;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          totalBytes += value.byteLength;
          yield {
            type: 'audio' as const,
            data: value,
            chunkIndex: chunkIndex++,
          };
        }
      } finally {
        reader.releaseLock();
      }

      yield {
        type: 'end' as const,
        totalBytes,
        totalChunks: chunkIndex,
      };
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error && error.name === 'AbortError') {
        yield {
          type: 'error' as const,
          message: `Stream timed out after ${timeout}ms`,
          retryable: true,
        };
        return;
      }

      yield {
        type: 'error' as const,
        message: error instanceof Error ? error.message : 'Unknown streaming error',
        retryable: true,
      };
    }
  }

  private cachedVoiceResult(cached: CachedVoiceData): {
    voices: Voice[];
    systemVoices: SystemVoice[];
  } {
    return {
      voices: cached.voices as Voice[],
      systemVoices: this.mapSystemVoices(cached.systemVoices ?? []),
    };
  }

  private validateVoicesResponse(data: VoicesResponse): Voice[] {
    const result = z.array(VoiceSchema).safeParse(data.voices);
    if (!result.success) {
      throw new ResponseValidationError(
        'Invalid voice data received from API',
        result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
        data.voices
      );
    }
    return result.data;
  }

  /**
   * Retrieves the list of available voices, optionally filtered by language
   * or gender. Without filters, results are served from the client-side
   * cache when fresh; filtered queries always hit the network.
   *
   * @param filters - Optional filters to apply
   * @param requestOptions - Optional per-request configuration
   * @returns Both the user-facing `voices` array and the personalized
   *   `systemVoices` array (see `SystemVoice` from `@responsivevoice/types`)
   *
   * @example
   * ```typescript
   * // Get all voices
   * const { voices } = await client.getVoices();
   *
   * // Get female voices
   * const { voices: female } = await client.getVoices({ gender: 'female' });
   *
   * // Get Spanish voices
   * const { voices: spanish } = await client.getVoices({ lang: 'es' });
   * ```
   */
  async getVoices(
    filters?: VoiceFilters,
    requestOptions?: RequestOptions
  ): Promise<{ voices: Voice[]; systemVoices: SystemVoice[] }> {
    const hasFilters = filters?.lang || filters?.gender;
    const cached = !hasFilters ? await this.voiceCache.getVoices() : null;

    if (cached && this.voiceCache.isFresh(cached)) {
      return this.cachedVoiceResult(cached);
    }

    const params = new URLSearchParams();
    const filterKeys = ['lang', 'gender', 'browser', 'browserVersion', 'os', 'osVersion'] as const;
    for (const key of filterKeys) {
      if (filters?.[key]) params.set(key, filters[key]);
    }

    const queryString = params.toString();
    const path = queryString ? `/voices?${queryString}` : '/voices';
    const url = this.buildUrl(path);

    const extraHeaders: Record<string, string> = {};
    if (cached?.etag) {
      extraHeaders['If-None-Match'] = cached.etag;
    }

    const response = await this.request<VoicesResponse>({
      method: 'GET',
      url,
      extraHeaders,
      ...requestOptions,
    });

    if (response.status === 304 && cached) {
      await this.voiceCache.setVoices(cached.etag, cached.voices, cached.systemVoices);
      return this.cachedVoiceResult(cached);
    }

    const voices = this.validateVoicesResponse(response.data!);
    const systemVoices = this.mapSystemVoices(response.data!.systemVoices ?? []);

    if (!hasFilters) {
      const etag = response.headers?.get('ETag');
      if (etag) {
        await this.voiceCache.setVoices(etag, response.data!.voices, response.data!.systemVoices);
      }
    }

    return { voices, systemVoices };
  }

  /**
   * Clear the client-side voice cache
   */
  async clearVoiceCache(): Promise<void> {
    await this.voiceCache.clear();
  }

  /**
   * Get the raw cached voice data.
   */
  async getCachedVoiceData(): Promise<CachedVoiceData | null> {
    return this.voiceCache.getVoices();
  }

  /**
   * Get the stored browser voice hash.
   * Used by `core` to check if browser voices changed since last report.
   */
  async getBrowserVoiceHash(): Promise<string | null> {
    return this.voiceCache.getBrowserVoiceHash();
  }

  /**
   * Get a specific voice by name
   *
   * Retrieves detailed information about a specific system voice.
   *
   * @param name - The voice name to look up
   * @param requestOptions - Optional request configuration
   * @returns Promise resolving to SystemVoice object
   *
   * @example
   * ```typescript
   * const voice = await client.getVoice('UK English Female');
   * console.log(`Voice service: ${voice.service}`);
   * ```
   */
  async getVoice(name: string, requestOptions?: RequestOptions): Promise<SystemVoice> {
    const encodedName = encodeURIComponent(name);
    const url = this.buildUrl(`/voices/${encodedName}`);

    const response = await this.request<SystemVoiceResponse>({
      method: 'GET',
      url,
      ...requestOptions,
    });

    // Validate response data against Zod schema
    const result = SystemVoiceSchema.safeParse(response.data!);

    if (!result.success) {
      throw new ResponseValidationError(
        `Invalid system voice data received from API for "${name}"`,
        result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
        response.data!
      );
    }

    return result.data;
  }

  /**
   * Get voices for a specific language
   *
   * Retrieves all voices available for the specified language code.
   *
   * @param lang - BCP-47 language code (e.g., 'en-US', 'es', 'fr-FR')
   * @param requestOptions - Optional request configuration
   * @returns Promise resolving to array of Voice objects
   *
   * @example
   * ```typescript
   * const germanVoices = await client.getVoicesByLanguage('de-DE');
   * const frenchVoices = await client.getVoicesByLanguage('fr');
   * ```
   */
  async getVoicesByLanguage(lang: string, requestOptions?: RequestOptions): Promise<Voice[]> {
    const encodedLang = encodeURIComponent(lang);
    const url = this.buildUrl(`/voices/by-language/${encodedLang}`);

    const response = await this.request<VoicesResponse>({
      method: 'GET',
      url,
      ...requestOptions,
    });

    // Validate response data against Zod schema
    const voicesSchema = z.array(VoiceSchema);
    const result = voicesSchema.safeParse(response.data!.voices);

    if (!result.success) {
      throw new ResponseValidationError(
        `Invalid voice data received from API for language "${lang}"`,
        result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
        response.data!.voices
      );
    }

    return result.data;
  }

  /**
   * Report browser voices and receive a personalized voice collection
   *
   * Sends information about available browser voices to the server,
   * which returns an optimized voice collection for the user's browser/OS
   * combination and subscription tier.
   *
   * @param report - Voice report containing platform info and browser voices
   * @param requestOptions - Optional request configuration
   * @returns Personalized voice collection with count
   *
   * @example
   * ```typescript
   * const report = {
   *   platform: {
   *     browser: 'Chrome',
   *     browserVersion: '120.0.0',
   *     os: 'Windows',
   *     osVersion: '11',
   *   },
   *   voices: speechSynthesis.getVoices().map(v => ({
   *     name: v.name,
   *     lang: v.lang,
   *     localService: v.localService,
   *     voiceURI: v.voiceURI,
   *     default: v.default,
   *   })),
   *   timestamp: new Date().toISOString(),
   * };
   *
   * const response = await client.reportVoices(report);
   * console.log(`Received ${response.count} personalized voices`);
   * ```
   */
  async reportVoices(
    report: VoiceReportRequest,
    requestOptions?: RequestOptions & { browserVoiceHash?: string }
  ): Promise<VoiceReportResponse> {
    const url = this.buildUrl('/voices/report');

    const response = await this.request<VoiceReportResponse>({
      method: 'POST',
      url,
      body: report,
      ...requestOptions,
    });

    // Validate response data against Zod schema
    const result = VoiceReportResponseSchema.safeParse(response.data);

    if (!result.success) {
      throw new ResponseValidationError(
        'Invalid voice report response received from API',
        result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
        response.data
      );
    }

    // Seed the voice cache with the report response data + ETag
    const etag = response.headers?.get('ETag') || response.headers?.get('X-Voice-Data-ETag');
    if (etag && result.data.voices) {
      await this.voiceCache.setVoices(
        etag,
        result.data.voices as unknown as VoicesResponse['voices'],
        result.data.systemVoices as unknown as VoicesResponse['systemVoices']
      );
    }

    // Store browser voice hash separately (persists across API URL changes)
    if (requestOptions?.browserVoiceHash) {
      await this.voiceCache.setBrowserVoiceHash(requestOptions.browserVoiceHash);
    }

    return result.data;
  }

  /**
   * Re-run the v2 browser handshake and mint a fresh `AuthToken`.
   * Called by `core` when its current handshake token nears expiry or
   * after a 401 from a previously-valid token. Origin verification
   * uses the same headers as `/v2/config`.
   */
  async refreshAuth(requestOptions?: RequestOptions): Promise<AuthToken> {
    const url = this.buildUrl('/auth/refresh');
    const response = await this.request<AuthToken>({
      method: 'POST',
      url,
      skipAuthHeaders: true,
      ...requestOptions,
    });

    const result = AuthTokenSchema.safeParse(response.data);
    if (!result.success) {
      throw new ResponseValidationError(
        'Invalid auth refresh response received from API',
        result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
        response.data
      );
    }

    return result.data;
  }

  /**
   * Submit an origin-verification token to confirm site ownership. Sent as an
   * `Authorization: Bearer` credential; on success the site is marked verified.
   * Not retried.
   */
  async verifyOrigin(
    token: string,
    requestOptions?: RequestOptions
  ): Promise<VerifyOriginResponse> {
    const url = this.buildUrl('/auth/verify-origin');
    const response = await this.request<VerifyOriginResponse>({
      method: 'POST',
      url,
      extraHeaders: { Authorization: `Bearer ${token}` },
      skipAuthHeaders: true,
      skipRetry: true,
      ...requestOptions,
    });

    const result = VerifyOriginResponseSchema.safeParse(response.data);
    if (!result.success) {
      throw new ResponseValidationError(
        'Invalid verify-origin response received from API',
        result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
        response.data
      );
    }

    return result.data;
  }

  /**
   * Fetch the per-website configuration (features, voice profile, analytics).
   * Returns a typed `WebsiteConfigResponse` validated against the Zod schema.
   */
  async getConfig(requestOptions?: RequestOptions): Promise<WebsiteConfigResponse> {
    const url = this.buildUrl('/config');

    const response = await this.request<WebsiteConfigResponse>({
      method: 'GET',
      url,
      ...requestOptions,
    });

    const result = WebsiteConfigResponseSchema.safeParse(response.data);

    if (!result.success) {
      throw new ResponseValidationError(
        'Invalid config response received from API',
        result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
        response.data
      );
    }

    return result.data;
  }

  /**
   * Check X-Server-URL response header and update baseUrl if the server
   * assigned a different URL. Invokes onServerUrlChange callback so
   * consumers (e.g., core) can persist the new URL.
   */
  private checkServerUrlHeader(headers: Headers | null): void {
    if (!headers) return;
    const serverHostname = headers.get('X-Server-URL');
    if (!serverHostname) return;

    // Construct full baseUrl matching current protocol + /v2 path
    const currentUrl = new URL(this.config.baseUrl);
    const newBaseUrl = `${currentUrl.protocol}//${serverHostname}/v2`;

    if (newBaseUrl !== this.config.baseUrl) {
      this.config = { ...this.config, baseUrl: newBaseUrl };
      this.config.onServerUrlChange?.(newBaseUrl);
    }
  }

  /**
   * Compose per-request auth headers. Server-callers with an
   * `apiSecret` get `X-API-Key` + `X-API-Secret`; callers (typically
   * `core` post-handshake) that supply an `authHeaders` hook get its
   * return value merged in, taking precedence on collision so a
   * bearer token can override the secret pair.
   */
  private async buildAuthHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {};
    if (this.config.apiSecret) {
      headers['X-API-Key'] = this.config.apiKey;
      headers['X-API-Secret'] = this.config.apiSecret;
    }
    if (this.config.authHeaders) {
      Object.assign(headers, await this.config.authHeaders());
    }
    return headers;
  }

  private maybePickupRenewedToken(headers: Headers | null): void {
    if (!headers || !this.config.onTokenRenewed) return;
    const token = headers.get('X-RV-Auth-Renewed');
    const expHeader = headers.get('X-RV-Auth-Renewed-Exp');
    if (!token || !expHeader) return;
    const exp = Number(expHeader);
    if (!Number.isFinite(exp)) return;
    this.config.onTokenRenewed({ token, exp });
  }

  /** Surface rate-limit headers so callers can pace against the allowance. */
  private maybeReportRateLimit(headers: Headers | null): void {
    if (!headers || !this.config.onRateLimit) return;
    const num = (value: string | null): number | null => {
      if (value == null || value.trim() === '') return null;
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    };
    const limit = num(headers.get('X-RateLimit-Limit'));
    const remaining = num(headers.get('X-RateLimit-Remaining'));
    const retryAfter = num(headers.get('Retry-After'));
    if (limit === null && remaining === null && retryAfter === null) return;
    this.config.onRateLimit({ limit, remaining, retryAfter });
  }

  /**
   * Build a full URL with API key
   */
  private buildUrl(path: string): string {
    const baseUrl = this.config.baseUrl.replace(/\/$/, '');
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;

    // Handle existing query params
    const url = new URL(`${baseUrl}${normalizedPath}`);
    url.searchParams.set('key', this.config.apiKey);

    return url.toString();
  }

  /**
   * Map raw system voice responses to SystemVoice objects.
   *
   * The wire shape is now a dense SystemVoiceResponse[] (no nulls, only IDs
   * reachable from voices[*].voiceIDs chains). This mapper is essentially
   * an identity — kept so the response DTO type stays behind the internal
   * SystemVoice type at this seam.
   */
  private mapSystemVoices(raw: SystemVoiceResponse[]): SystemVoice[] {
    return raw.map((v) => ({
      id: v.id,
      name: v.name,
      lang: v.lang,
      rate: v.rate,
      pitch: v.pitch,
      timerSpeed: v.timerSpeed,
      fallbackVoice: v.fallbackVoice,
      service: v.service,
      voiceName: v.voiceName,
      gender: v.gender,
      volume: v.volume,
      deprecated: v.deprecated,
    }));
  }

  /**
   * Make an HTTP request with retry logic
   */
  private async request<T>(options: {
    method: 'GET' | 'POST';
    url: string;
    body?: Record<string, unknown>;
    extraHeaders?: Record<string, string>;
    responseType?: 'json' | 'blob';
    timeout?: number;
    signal?: AbortSignal;
    skipRetry?: boolean;
    /**
     * Skip the per-request auth headers (`buildAuthHeaders`). Used by
     * `refreshAuth()` to avoid reentrant recursion through the
     * `authHeaders` hook when core's hook is itself the trigger for
     * the refresh.
     */
    skipAuthHeaders?: boolean;
  }): Promise<{
    data: T | null;
    contentType: string;
    duration?: number;
    status: number;
    headers: Headers | null;
  }> {
    const timeout = options.timeout ?? this.config.timeout;
    const responseType = options.responseType ?? 'json';

    const rethrowAsTyped = (error: unknown, url: string): never => {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new TimeoutError(`Request timed out after ${timeout}ms`, url, timeout);
      }
      if (error instanceof TypeError && error.message.includes('fetch')) {
        throw new NetworkError(`Network request failed: ${error.message}`, url, error);
      }
      throw error;
    };

    const parseResponseBody = async (response: Response): Promise<T> => {
      return responseType === 'blob'
        ? ((await response.blob()) as T)
        : ((await response.json()) as T);
    };

    const executeRequest = async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      const signal = options.signal
        ? this.combineAbortSignals(options.signal, controller.signal)
        : controller.signal;

      try {
        const fetchOptions: RequestInit = {
          method: options.method,
          headers: {
            ...(options.body && { 'Content-Type': 'application/json' }),
            ...(options.skipAuthHeaders ? {} : await this.buildAuthHeaders()),
            ...options.extraHeaders,
          },
          signal,
          ...(options.body && { body: JSON.stringify(options.body) }),
        };

        const response = await this.config.fetch(options.url, fetchOptions);
        clearTimeout(timeoutId);
        this.maybeReportRateLimit(response.headers);

        if (response.status === 304) {
          this.checkServerUrlHeader(response.headers);
          this.maybePickupRenewedToken(response.headers);
          return {
            data: null as T | null,
            contentType: '',
            status: 304,
            headers: response.headers,
          };
        }

        if (!response.ok) {
          throw await createApiError(response, options.url);
        }

        const contentType = response.headers.get('Content-Type') || '';
        const durationHeader = response.headers.get('X-Audio-Duration');
        const duration = durationHeader ? parseFloat(durationHeader) : undefined;
        const data = await parseResponseBody(response);

        this.checkServerUrlHeader(response.headers);
        this.maybePickupRenewedToken(response.headers);

        return { data, contentType, duration, status: response.status, headers: response.headers };
      } catch (error) {
        clearTimeout(timeoutId);
        return rethrowAsTyped(error, options.url);
      }
    };

    if (options.skipRetry) {
      return executeRequest();
    }

    const retryConfig: Partial<RetryConfig> = {
      maxAttempts: this.config.retryAttempts,
      baseDelay: this.config.retryDelay,
    };

    return withRetry(executeRequest, retryConfig);
  }

  /**
   * Combine multiple abort signals into one
   */
  private combineAbortSignals(signal1: AbortSignal, signal2: AbortSignal): AbortSignal {
    const controller = new AbortController();

    const abort = () => controller.abort();

    signal1.addEventListener('abort', abort);
    signal2.addEventListener('abort', abort);

    if (signal1.aborted || signal2.aborted) {
      controller.abort();
    }

    return controller.signal;
  }

  /**
   * Extract audio format from content type or default
   */
  private extractAudioFormat(contentType: string, requestedFormat?: AudioFormat): AudioFormat {
    if (contentType.includes('ogg')) {
      return 'ogg';
    }

    if (contentType.includes('wav')) {
      return 'wav';
    }

    if (contentType.includes('mp3') || contentType.includes('mpeg')) {
      return 'mp3';
    }

    return requestedFormat ?? 'mp3';
  }
}
