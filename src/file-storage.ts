import type { CacheStorageAdapter } from './types';

/**
 * Node.js-only `CacheStorageAdapter` that persists voice-cache entries to a
 * JSON file under the operating system's temp directory. Loaded lazily via
 * dynamic `import()` of `node:fs`/`node:os`/`node:path` so browser bundlers
 * never encounter `node:` built-ins. All operations are silent-fail: I/O
 * errors (missing modules, permission denied, corrupt file) resolve to
 * `null`/no-op rather than throwing.
 */
export class FileStorage implements CacheStorageAdapter {
  private filePath: string | null = null;
  private fsModule: {
    readFileSync: (path: string, encoding: string) => string;
    writeFileSync: (path: string, data: string) => void;
    unlinkSync: (path: string) => void;
    existsSync: (path: string) => boolean;
  } | null = null;
  private initialized = false;

  /**
   * @param fileId - Identifier used to scope the temp file name
   *   (`rv-voice-cache-{fileId}.json`). Typically a hash of the API key so
   *   concurrent clients with different keys don't share storage.
   */
  constructor(private readonly fileId: string) {}

  private async init(): Promise<boolean> {
    if (this.initialized) return this.fsModule !== null;

    this.initialized = true;

    try {
      const fs = await import('node:fs');
      const os = await import('node:os');
      const path = await import('node:path');

      this.fsModule = {
        readFileSync: fs.readFileSync as (path: string, encoding: string) => string,
        writeFileSync: fs.writeFileSync as (path: string, data: string) => void,
        unlinkSync: fs.unlinkSync,
        existsSync: fs.existsSync,
      };
      this.filePath = path.join(os.tmpdir(), `rv-voice-cache-${this.fileId}.json`);
      return true;
    } catch {
      // Not in Node.js or modules unavailable
      return false;
    }
  }

  /**
   * Read a stored value by key. Returns `null` when the key is absent, the
   * backing file is missing/unreadable, or the runtime is not Node.js.
   */
  async getItem(key: string): Promise<string | null> {
    if (!(await this.init()) || !this.filePath || !this.fsModule) return null;

    try {
      if (!this.fsModule.existsSync(this.filePath)) return null;
      const content = this.fsModule.readFileSync(this.filePath, 'utf-8');
      const data = JSON.parse(content) as Record<string, string>;
      return data[key] ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Persist a value under `key`, merging into any existing JSON payload.
   * Silently no-ops when the runtime is not Node.js or the write fails.
   */
  async setItem(key: string, value: string): Promise<void> {
    if (!(await this.init()) || !this.filePath || !this.fsModule) return;

    try {
      let data: Record<string, string> = {};
      if (this.fsModule.existsSync(this.filePath)) {
        try {
          const content = this.fsModule.readFileSync(this.filePath, 'utf-8');
          data = JSON.parse(content) as Record<string, string>;
        } catch {
          // Corrupted file, start fresh
        }
      }
      data[key] = value;
      this.fsModule.writeFileSync(this.filePath, JSON.stringify(data));
    } catch {
      // Silently fail on write errors
    }
  }

  /**
   * Remove a stored value. Deletes the backing file when the last entry is
   * removed. Silently no-ops when the runtime is not Node.js.
   */
  async removeItem(key: string): Promise<void> {
    if (!(await this.init()) || !this.filePath || !this.fsModule) return;

    try {
      if (!this.fsModule.existsSync(this.filePath)) return;
      const content = this.fsModule.readFileSync(this.filePath, 'utf-8');
      const data = JSON.parse(content) as Record<string, string>;
      delete data[key];

      if (Object.keys(data).length === 0) {
        this.fsModule.unlinkSync(this.filePath);
      } else {
        this.fsModule.writeFileSync(this.filePath, JSON.stringify(data));
      }
    } catch {
      // Silently fail
    }
  }
}
