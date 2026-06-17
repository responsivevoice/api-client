/**
 * REST and WebSocket client for the ResponsiveVoice Text-to-Speech API. This
 * is the Node.js entry point — re-exports the shared surface from
 * `./index.common` and adds the Node-only `FileStorage` adapter plus its
 * factory registration. Browsers resolve to `./index.browser` via the package
 * `exports` map.
 *
 * @packageDocumentation
 */

export * from './index.common';

// Filesystem storage (Node.js only — not included in browser entry)
import { FileStorage } from './file-storage';
import { setFileStorageFactory } from './voice-cache';

export { FileStorage };

// Register FileStorage factory for Node.js auto-detection
setFileStorageFactory((fileId) => new FileStorage(fileId));
