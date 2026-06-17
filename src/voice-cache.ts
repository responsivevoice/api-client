import { djb2Hash } from '@responsivevoice/text';
import type {
  CachedVoiceData,
  CacheStorageAdapter,
  SystemVoiceResponse,
  VoiceCacheConfig,
  VoiceData,
} from './types';

/**
 * In-memory storage adapter. Lives for the process/page lifetime.
 */
export class MemoryStorage implements CacheStorageAdapter {
  private readonly store = new Map<string, string>();

  /** Retrieve a stored value by key, or `null` if absent. */
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  /** Store `value` under `key`, overwriting any existing entry. */
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }

  /** Remove the value stored under `key`. No-op if absent. */
  removeItem(key: string): void {
    this.store.delete(key);
  }
}

/**
 * Factory for creating FileStorage instances.
 * Registered by the Node.js entry point; absent in browser builds.
 * @internal
 */
let fileStorageFactory: ((fileId: string) => CacheStorageAdapter) | null = null;

/** @internal */
export function setFileStorageFactory(
  factory: ((fileId: string) => CacheStorageAdapter) | null
): void {
  fileStorageFactory = factory;
}

/**
 * No-op cache that never stores or returns anything. Used when caching is
 * disabled via `enabled: false`.
 *
 * @internal
 * TODO: remove — `ClientVoiceCache` already handles `enabled: false` itself
 * via per-method early-returns on the `enabled` flag, making this class a
 * redundant parallel implementation. Collapse `.create()` to return
 * `ClientVoiceCache` only.
 */
class NoOpCache {
  async getVoices(): Promise<CachedVoiceData | null> {
    return null;
  }
  isFresh(): boolean {
    return false;
  }
  async setVoices(): Promise<void> {}
  async getBrowserVoiceHash(): Promise<string | null> {
    return null;
  }
  async setBrowserVoiceHash(): Promise<void> {}
  async clear(): Promise<void> {}
  get enabled(): boolean {
    return false;
  }
}

/**
 * Client-side voice cache with multi-environment storage support.
 */
export class ClientVoiceCache {
  private storage: CacheStorageAdapter | null = null;
  private storageResolved = false;
  private readonly config: Required<Omit<VoiceCacheConfig, 'customStorage' | 'apiKey'>> & {
    customStorage?: CacheStorageAdapter;
  };
  private readonly cacheKey: string;
  private readonly hashKey: string;
  /** Whether caching is active; mirrors `VoiceCacheConfig.enabled`. */
  readonly enabled: boolean;

  constructor(config: VoiceCacheConfig = {}) {
    this.config = {
      enabled: config.enabled ?? true,
      storage: config.storage ?? 'auto',
      keyPrefix: config.keyPrefix ?? 'rv-voice-cache',
      ttl: config.ttl ?? 300,
      customStorage: config.customStorage,
    };
    this.enabled = this.config.enabled;

    // Scope cache keys to the API key when provided (prevents cross-site collisions)
    if (config.apiKey) {
      const hash = djb2Hash(config.apiKey);
      this.cacheKey = `rv:${hash}:voice-cache`;
      this.hashKey = `rv:${hash}:voice-cache:browser-hash`;
    } else {
      this.cacheKey = this.config.keyPrefix;
      this.hashKey = `${this.config.keyPrefix}:browser-hash`;
    }
  }

  /**
   * Migrate legacy unscoped cache entries to API-key-scoped keys.
   * Should be called once during initialization when apiKey is available.
   */
  async migrateVoiceCache(): Promise<void> {
    if (!this.enabled) return;

    const legacyCacheKey = 'rv-voice-cache';
    const legacyHashKey = 'rv-voice-cache:browser-hash';

    try {
      const storage = await this.resolveStorage();

      // Migrate voice cache data
      const legacyCache = await storage.getItem(legacyCacheKey);
      if (legacyCache) {
        const existing = await storage.getItem(this.cacheKey);
        if (!existing) {
          await storage.setItem(this.cacheKey, legacyCache);
        }
        await storage.removeItem(legacyCacheKey);
      }

      // Migrate browser hash
      const legacyHash = await storage.getItem(legacyHashKey);
      if (legacyHash) {
        const existing = await storage.getItem(this.hashKey);
        if (!existing) {
          await storage.setItem(this.hashKey, legacyHash);
        }
        await storage.removeItem(legacyHashKey);
      }
    } catch {
      // Migration is best-effort
    }
  }

  /**
   * Resolve the storage backend based on configuration.
   */
  private async resolveStorage(): Promise<CacheStorageAdapter> {
    if (this.storageResolved && this.storage) return this.storage;

    this.storageResolved = true;

    // Custom storage always takes priority
    if (this.config.customStorage) {
      this.storage = this.config.customStorage;
      return this.storage;
    }

    const type = this.config.storage;

    if (type === 'auto') {
      this.storage = await this.autoDetectStorage();
    } else if (type === 'localStorage') {
      this.storage = this.tryLocalStorage() ?? new MemoryStorage();
    } else if (type === 'sessionStorage') {
      this.storage = this.trySessionStorage() ?? new MemoryStorage();
    } else if (type === 'filesystem') {
      this.storage = (await this.tryFileStorage()) ?? new MemoryStorage();
    } else {
      this.storage = new MemoryStorage();
    }

    return this.storage;
  }

  /**
   * Auto-detect the best storage backend for the current environment.
   */
  private async autoDetectStorage(): Promise<CacheStorageAdapter> {
    // 1. Try localStorage (browser)
    const ls = this.tryLocalStorage();
    if (ls) return ls;

    // 2. Try sessionStorage (browser fallback)
    const ss = this.trySessionStorage();
    if (ss) return ss;

    // 3. Try filesystem (Node.js)
    const fs = await this.tryFileStorage();
    if (fs) return fs;

    // 4. Fall back to memory
    return new MemoryStorage();
  }

  /**
   * Try to use localStorage. Returns null if unavailable.
   */
  private tryLocalStorage(): CacheStorageAdapter | null {
    try {
      if (typeof localStorage !== 'undefined') {
        // Test that it actually works (can be disabled in some browsers)
        const testKey = '__rv_cache_test__';
        localStorage.setItem(testKey, '1');
        localStorage.removeItem(testKey);
        return localStorage;
      }
    } catch {
      // localStorage not available or blocked
    }
    return null;
  }

  /**
   * Try to use sessionStorage. Returns null if unavailable.
   */
  private trySessionStorage(): CacheStorageAdapter | null {
    try {
      if (typeof sessionStorage !== 'undefined') {
        const testKey = '__rv_cache_test__';
        sessionStorage.setItem(testKey, '1');
        sessionStorage.removeItem(testKey);
        return sessionStorage;
      }
    } catch {
      // sessionStorage not available or blocked
    }
    return null;
  }

  /**
   * Try to use filesystem storage. Returns null if not in Node.js
   * or if the FileStorage factory was not registered (browser builds).
   */
  private async tryFileStorage(): Promise<CacheStorageAdapter | null> {
    if (typeof process === 'undefined' || !process.versions?.node) {
      return null;
    }
    if (!fileStorageFactory) return null;

    const fileId = djb2Hash(this.cacheKey);
    const fs = fileStorageFactory(fileId);

    // Test that filesystem is accessible
    try {
      await fs.setItem('__test__', '1');
      await fs.removeItem('__test__');
      return fs;
    } catch {
      return null;
    }
  }

  /**
   * Get cached voice data.
   *
   * @returns Cached voice data or null if not cached / cache disabled
   */
  async getVoices(): Promise<CachedVoiceData | null> {
    if (!this.enabled) return null;

    try {
      const storage = await this.resolveStorage();
      const raw = await storage.getItem(this.cacheKey);
      if (!raw) return null;

      const data = JSON.parse(raw) as CachedVoiceData;

      // Basic structural validation
      if (!data.etag || !Array.isArray(data.voices)) {
        return null;
      }

      return data;
    } catch {
      return null;
    }
  }

  /**
   * Check whether cached data is still fresh (within TTL).
   */
  isFresh(data: CachedVoiceData): boolean {
    const ageMs = Date.now() - data.cachedAt;
    return ageMs < this.config.ttl * 1000;
  }

  /**
   * Store voice data in the cache.
   *
   * @param etag - ETag from the server response
   * @param voices - Voice collection to cache
   * @param systemVoices - System voices to cache
   */
  async setVoices(
    etag: string,
    voices: VoiceData[],
    systemVoices: SystemVoiceResponse[] | undefined
  ): Promise<void> {
    if (!this.enabled) return;

    try {
      const storage = await this.resolveStorage();
      const data: CachedVoiceData = {
        etag,
        voices,
        systemVoices,
        cachedAt: Date.now(),
      };
      await storage.setItem(this.cacheKey, JSON.stringify(data));
    } catch {
      // Silently fail — caching is best-effort
    }
  }

  /**
   * Get the stored browser voice hash.
   * Stored separately from voice data so it persists across API URL changes.
   */
  async getBrowserVoiceHash(): Promise<string | null> {
    if (!this.enabled) return null;

    try {
      const storage = await this.resolveStorage();
      return await storage.getItem(this.hashKey);
    } catch {
      return null;
    }
  }

  /**
   * Store the browser voice hash.
   */
  async setBrowserVoiceHash(hash: string): Promise<void> {
    if (!this.enabled) return;

    try {
      const storage = await this.resolveStorage();
      await storage.setItem(this.hashKey, hash);
    } catch {
      // Silently fail
    }
  }

  /**
   * Clear the voice cache.
   */
  async clear(): Promise<void> {
    if (!this.enabled) return;

    try {
      const storage = await this.resolveStorage();
      await storage.removeItem(this.cacheKey);
      await storage.removeItem(this.hashKey);
    } catch {
      // Silently fail
    }
  }

  /**
   * Create a ClientVoiceCache or NoOpCache based on configuration.
   */
  static create(config: VoiceCacheConfig | undefined): ClientVoiceCache | NoOpCache {
    if (config?.enabled === false) {
      return new NoOpCache();
    }
    return new ClientVoiceCache(config);
  }
}
