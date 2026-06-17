/**
 * Tests for ClientVoiceCache
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FileStorage } from '../file-storage';
import type { CachedVoiceData, CacheStorageAdapter, VoiceData } from '../types';
import { ClientVoiceCache, MemoryStorage } from '../voice-cache';

const MOCK_VOICES: VoiceData[] = [
  { name: 'UK English Female', flag: 'gb', gender: 'f', lang: 'en-GB', voiceIDs: [5, 7] },
  { name: 'US English Male', flag: 'us', gender: 'm', lang: 'en-US', voiceIDs: [3, 4] },
];

const MOCK_ETAG = '"abc123def4567890"';

describe('MemoryStorage', () => {
  it('should store and retrieve items', () => {
    const storage = new MemoryStorage();
    storage.setItem('key1', 'value1');
    expect(storage.getItem('key1')).toBe('value1');
  });

  it('should return null for missing items', () => {
    const storage = new MemoryStorage();
    expect(storage.getItem('nonexistent')).toBeNull();
  });

  it('should remove items', () => {
    const storage = new MemoryStorage();
    storage.setItem('key1', 'value1');
    storage.removeItem('key1');
    expect(storage.getItem('key1')).toBeNull();
  });

  it('should overwrite existing items', () => {
    const storage = new MemoryStorage();
    storage.setItem('key1', 'value1');
    storage.setItem('key1', 'value2');
    expect(storage.getItem('key1')).toBe('value2');
  });
});

describe('ClientVoiceCache', () => {
  describe('basic operations', () => {
    let cache: ClientVoiceCache;

    beforeEach(() => {
      cache = new ClientVoiceCache({ storage: 'memory' });
    });

    it('should return null when cache is empty', async () => {
      const result = await cache.getVoices();
      expect(result).toBeNull();
    });

    it('should store and retrieve voice data', async () => {
      await cache.setVoices(MOCK_ETAG, MOCK_VOICES, undefined);
      const result = await cache.getVoices();

      expect(result).not.toBeNull();
      expect(result!.etag).toBe(MOCK_ETAG);
      expect(result!.voices).toEqual(MOCK_VOICES);
      expect(result!.cachedAt).toBeGreaterThan(0);
    });

    it('should store system voices alongside regular voices', async () => {
      const systemVoices = [null, { id: 1, name: 'Voice 1' }];
      await cache.setVoices(
        MOCK_ETAG,
        MOCK_VOICES,
        systemVoices as CachedVoiceData['systemVoices']
      );
      const result = await cache.getVoices();

      expect(result!.systemVoices).toEqual(systemVoices);
    });

    it('should clear the cache', async () => {
      await cache.setVoices(MOCK_ETAG, MOCK_VOICES, undefined);
      await cache.clear();
      const result = await cache.getVoices();

      expect(result).toBeNull();
    });

    it('should clear both voice data and browser voice hash', async () => {
      await cache.setVoices(MOCK_ETAG, MOCK_VOICES, undefined);
      await cache.setBrowserVoiceHash('abc123hash');
      await cache.clear();

      const voiceResult = await cache.getVoices();
      const hashResult = await cache.getBrowserVoiceHash();

      expect(voiceResult).toBeNull();
      expect(hashResult).toBeNull();
    });

    it('should report enabled=true', () => {
      expect(cache.enabled).toBe(true);
    });

    it('should store and retrieve browserVoiceHash via dedicated methods', async () => {
      await cache.setBrowserVoiceHash('abc123hash');
      const hash = await cache.getBrowserVoiceHash();

      expect(hash).toBe('abc123hash');
    });

    it('should return null for browserVoiceHash when not set', async () => {
      const hash = await cache.getBrowserVoiceHash();
      expect(hash).toBeNull();
    });

    it('should overwrite browserVoiceHash on subsequent set', async () => {
      await cache.setBrowserVoiceHash('hash1');
      await cache.setBrowserVoiceHash('hash2');
      const hash = await cache.getBrowserVoiceHash();

      expect(hash).toBe('hash2');
    });

    it('should store browserVoiceHash independently from voice data', async () => {
      await cache.setBrowserVoiceHash('myhash');
      await cache.setVoices(MOCK_ETAG, MOCK_VOICES, undefined);

      // Voice data should not affect the hash
      const hash = await cache.getBrowserVoiceHash();
      expect(hash).toBe('myhash');

      // Clearing voice data by setting new voices should not affect the hash
      await cache.setVoices('"newtag"', [], undefined);
      const hashAfter = await cache.getBrowserVoiceHash();
      expect(hashAfter).toBe('myhash');
    });
  });

  describe('fixed cache key', () => {
    it('should use the same cache key regardless of keyPrefix when keyPrefix matches', async () => {
      const storage = new MemoryStorage();

      const cache1 = new ClientVoiceCache({ customStorage: storage, keyPrefix: 'shared' });
      const cache2 = new ClientVoiceCache({ customStorage: storage, keyPrefix: 'shared' });

      await cache1.setVoices('"etag1"', MOCK_VOICES, undefined);
      const result = await cache2.getVoices();

      expect(result).not.toBeNull();
      expect(result!.etag).toBe('"etag1"');
      expect(result!.voices).toHaveLength(2);
    });

    it('should use different cache keys when keyPrefix differs', async () => {
      const storage = new MemoryStorage();

      const cache1 = new ClientVoiceCache({ customStorage: storage, keyPrefix: 'prefix-a' });
      const cache2 = new ClientVoiceCache({ customStorage: storage, keyPrefix: 'prefix-b' });

      await cache1.setVoices('"etag1"', MOCK_VOICES, undefined);
      const result = await cache2.getVoices();

      expect(result).toBeNull();
    });
  });

  describe('disabled cache', () => {
    it('should return a no-op cache when enabled is false', () => {
      const cache = ClientVoiceCache.create({ enabled: false });
      expect(cache.enabled).toBe(false);
    });

    it('should not store data when disabled', async () => {
      const cache = ClientVoiceCache.create({ enabled: false });
      await cache.setVoices(MOCK_ETAG, MOCK_VOICES, undefined);
      const result = await cache.getVoices();
      expect(result).toBeNull();
    });

    it('should not throw on clear when disabled', async () => {
      const cache = ClientVoiceCache.create({ enabled: false });
      await expect(cache.clear()).resolves.not.toThrow();
    });

    it('should not store browserVoiceHash when disabled', async () => {
      const cache = ClientVoiceCache.create({ enabled: false });
      await cache.setBrowserVoiceHash('test');
      const hash = await cache.getBrowserVoiceHash();
      expect(hash).toBeNull();
    });
  });

  describe('custom storage adapter', () => {
    it('should use custom storage adapter', async () => {
      const customStorage: CacheStorageAdapter = {
        getItem: vi.fn().mockReturnValue(null),
        setItem: vi.fn(),
        removeItem: vi.fn(),
      };

      const cache = new ClientVoiceCache({ customStorage });
      await cache.setVoices(MOCK_ETAG, MOCK_VOICES, undefined);

      expect(customStorage.setItem).toHaveBeenCalled();
    });

    it('should retrieve from custom storage adapter', async () => {
      const cached: CachedVoiceData = {
        etag: MOCK_ETAG,
        voices: MOCK_VOICES,
        cachedAt: Date.now(),
      };

      const customStorage: CacheStorageAdapter = {
        getItem: vi.fn().mockReturnValue(JSON.stringify(cached)),
        setItem: vi.fn(),
        removeItem: vi.fn(),
      };

      const cache = new ClientVoiceCache({ customStorage });
      const result = await cache.getVoices();

      expect(result!.etag).toBe(MOCK_ETAG);
      expect(result!.voices).toEqual(MOCK_VOICES);
    });
  });

  describe('graceful degradation', () => {
    it('should handle storage getItem errors gracefully', async () => {
      const failingStorage: CacheStorageAdapter = {
        getItem: vi.fn().mockImplementation(() => {
          throw new Error('Storage error');
        }),
        setItem: vi.fn(),
        removeItem: vi.fn(),
      };

      const cache = new ClientVoiceCache({ customStorage: failingStorage });
      const result = await cache.getVoices();

      expect(result).toBeNull();
    });

    it('should handle storage setItem errors gracefully', async () => {
      const failingStorage: CacheStorageAdapter = {
        getItem: vi.fn().mockReturnValue(null),
        setItem: vi.fn().mockImplementation(() => {
          throw new Error('Storage full');
        }),
        removeItem: vi.fn(),
      };

      const cache = new ClientVoiceCache({ customStorage: failingStorage });
      // Should not throw
      await expect(cache.setVoices(MOCK_ETAG, MOCK_VOICES, undefined)).resolves.not.toThrow();
    });

    it('should handle invalid JSON in storage gracefully', async () => {
      const corruptStorage: CacheStorageAdapter = {
        getItem: vi.fn().mockReturnValue('not-valid-json'),
        setItem: vi.fn(),
        removeItem: vi.fn(),
      };

      const cache = new ClientVoiceCache({ customStorage: corruptStorage });
      const result = await cache.getVoices();

      expect(result).toBeNull();
    });

    it('should handle incomplete cached data gracefully', async () => {
      const incompleteStorage: CacheStorageAdapter = {
        getItem: vi.fn().mockReturnValue(JSON.stringify({ etag: '"test"' })),
        setItem: vi.fn(),
        removeItem: vi.fn(),
      };

      const cache = new ClientVoiceCache({ customStorage: incompleteStorage });
      const result = await cache.getVoices();

      // Missing voices array → invalid
      expect(result).toBeNull();
    });
  });

  describe('static create', () => {
    it('should create ClientVoiceCache for default config', () => {
      const cache = ClientVoiceCache.create(undefined);
      expect(cache.enabled).toBe(true);
    });

    it('should create ClientVoiceCache for explicit enabled config', () => {
      const cache = ClientVoiceCache.create({ enabled: true });
      expect(cache.enabled).toBe(true);
    });

    it('should create no-op cache when disabled', () => {
      const cache = ClientVoiceCache.create({ enabled: false });
      expect(cache.enabled).toBe(false);
    });
  });

  describe('custom key prefix', () => {
    it('should use custom key prefix', async () => {
      const storage: CacheStorageAdapter = {
        getItem: vi.fn().mockReturnValue(null),
        setItem: vi.fn(),
        removeItem: vi.fn(),
      };

      const cache = new ClientVoiceCache({ customStorage: storage, keyPrefix: 'my-prefix' });
      await cache.setVoices(MOCK_ETAG, MOCK_VOICES, undefined);

      const setItemCall = (storage.setItem as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(setItemCall[0]).toContain('my-prefix');
    });
  });

  describe('TTL freshness', () => {
    async function seedCache(ttl = 300) {
      const cache = new ClientVoiceCache({ storage: 'memory', ttl });
      await cache.setVoices(MOCK_ETAG, MOCK_VOICES, undefined);
      const data = await cache.getVoices();
      expect(data).not.toBeNull();
      return { cache, data: data! };
    }

    it('should report data as fresh within TTL', async () => {
      const { cache, data } = await seedCache();
      expect(cache.isFresh(data)).toBe(true);
    });

    it('should report data as stale after TTL expires', async () => {
      const { cache, data } = await seedCache();

      // Simulate expired cache by manipulating cachedAt
      const staleData = { ...data, cachedAt: Date.now() - 301_000 };
      expect(cache.isFresh(staleData)).toBe(false);
    });

    it('should use default TTL of 300 seconds', async () => {
      const cache = new ClientVoiceCache({ storage: 'memory' });
      await cache.setVoices(MOCK_ETAG, MOCK_VOICES, undefined);

      const data = await cache.getVoices();
      expect(data).not.toBeNull();

      // Fresh data should be within default TTL
      expect(cache.isFresh(data!)).toBe(true);

      // Data 301s old should be stale
      const staleData = { ...data!, cachedAt: Date.now() - 301_000 };
      expect(cache.isFresh(staleData)).toBe(false);

      // Data 299s old should still be fresh
      const freshData = { ...data!, cachedAt: Date.now() - 299_000 };
      expect(cache.isFresh(freshData)).toBe(true);
    });

    it('should respect custom TTL', async () => {
      const cache = new ClientVoiceCache({ storage: 'memory', ttl: 60 });
      await cache.setVoices(MOCK_ETAG, MOCK_VOICES, undefined);

      const data = await cache.getVoices();
      expect(data).not.toBeNull();

      // 59s old → fresh
      const freshData = { ...data!, cachedAt: Date.now() - 59_000 };
      expect(cache.isFresh(freshData)).toBe(true);

      // 61s old → stale
      const staleData = { ...data!, cachedAt: Date.now() - 61_000 };
      expect(cache.isFresh(staleData)).toBe(false);
    });

    it('should treat ttl: 0 as always stale', async () => {
      const cache = new ClientVoiceCache({ storage: 'memory', ttl: 0 });
      await cache.setVoices(MOCK_ETAG, MOCK_VOICES, undefined);

      const data = await cache.getVoices();
      expect(data).not.toBeNull();
      expect(cache.isFresh(data!)).toBe(false);
    });
  });
});

describe('FileStorage', () => {
  it('should return null when file does not exist in Node.js', async () => {
    const fs = new FileStorage('test-hash');
    const result = await fs.getItem('nonexistent');
    // In test environment (Node.js), file simply won't exist
    expect(result).toBeNull();
  });

  it('should round-trip data through filesystem', async () => {
    const fs = new FileStorage(`test-${Date.now()}`);

    await fs.setItem('testKey', 'testValue');
    const result = await fs.getItem('testKey');

    expect(result).toBe('testValue');

    // Clean up
    await fs.removeItem('testKey');
    expect(await fs.getItem('testKey')).toBeNull();
  });
});
