# @responsivevoice/api-client

## 2.0.0

First public release of the rebuilt ResponsiveVoice — a complete, TypeScript-first rewrite of the original library, now split into focused, independently-versioned packages.

`@responsivevoice/api-client` is the REST and WebSocket client that powers server-side and headless text-to-speech, in the browser and Node.js.

### Highlights

- Synthesis and voice queries (`synthesize`, `getVoices`, `getVoicesByLanguage`, `getVoice`, `reportVoices`)
- Tracks the v2 REST API's published OpenAPI 3.1 specification — typed end to end against the documented contract
- WebSocket streaming for low-latency audio
- Automatic retry with exponential backoff
- Zod-validated responses and typed error classes
- Pluggable voice cache with memory and file storage adapters
- Zero-dependency native `fetch` — runs in the browser and Node.js

Documentation: https://docs.responsivevoice.org
