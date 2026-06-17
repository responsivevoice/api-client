// Browser entry point for `@responsivevoice/api-client`.
// Identical to the Node entry but excludes FileStorage (Node.js-only) so
// browser bundlers never encounter `node:` built-in imports. The shared
// export surface lives in `./index.common`.

export * from './index.common';
