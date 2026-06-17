<p align="center">
  <img src="https://cdn.responsivevoice.org/assets/logo-128.svg" width="128" height="128" alt="ResponsiveVoice logo">
</p>

<h1 align="center">@responsivevoice/api-client</h1>

<p align="center">
  <a href="https://github.com/responsivevoice/api-client/actions/workflows/ci.yml"><img src="https://github.com/responsivevoice/api-client/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
</p>

<p align="center">
  TypeScript REST client for the ResponsiveVoice Text-to-Speech API.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@responsivevoice/api-client"><img src="https://img.shields.io/npm/v/@responsivevoice/api-client.svg" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@responsivevoice/api-client"><img src="https://img.shields.io/npm/dm/@responsivevoice/api-client.svg" alt="npm downloads"></a>
  <a href="https://github.com/responsivevoice/api-client"><img src="https://img.shields.io/badge/GitHub-api--client-181717?logo=github&logoColor=white" alt="GitHub"></a>
  <img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT">
  <img src="https://img.shields.io/badge/Chrome-66+-4285F4?logo=googlechrome&logoColor=white" alt="Chrome 66+">
  <img src="https://img.shields.io/badge/Firefox-57+-FF7139?logo=firefox&logoColor=white" alt="Firefox 57+">
  <img src="https://img.shields.io/badge/Safari-12+-006CFF?logo=safari&logoColor=white" alt="Safari 12+">
  <img src="https://img.shields.io/badge/Edge-17+-0078D7?logo=microsoftedge&logoColor=white" alt="Edge 17+">
</p>

<p align="center">
  <a href="https://docs.responsivevoice.org/api/api-client/">Documentation</a> | <a href="https://docs.responsivevoice.org/guides/browser-support/">Browser Support</a>
</p>

---

## Installation

```bash
# npm
npm install @responsivevoice/api-client

# pnpm
pnpm add @responsivevoice/api-client

# yarn
yarn add @responsivevoice/api-client
```

## Get your API credentials

You need **both** an API key and an API secret to authenticate your requests — neither works alone.

1. [**Register for a free ResponsiveVoice account**](https://responsivevoice.org/register).
2. A default website is created for you automatically. Its identifier is your **API key** — copy it from the dashboard.
3. Create your **API secret** manually in the dashboard section **"Server-to-server API secrets"** (it is not auto-generated).
4. The secret is shown **once**: click to copy it immediately and paste it straight into your code (next to the API key from step 2). It can't be retrieved later — if you lose it, create a new one.

Keep your API secret server-side — don't ship it in browser code.

## Usage

```typescript
import { ResponsiveVoiceAPIClient } from '@responsivevoice/api-client';

// Authenticate with BOTH your API key and API secret (see above).
const client = new ResponsiveVoiceAPIClient({
  apiKey: 'your-api-key',
  apiSecret: 'your-api-secret',
});

// Synthesize speech: pass text and a ResponsiveVoice voice name.
// The server resolves the right voice for you.
const audio = await client.synthesize({
  text: 'Hello, world!',
  voice: 'UK English Female',
  format: 'mp3',
});

// The result gives you the audio in a few forms:
audio.blob; // the raw audio Blob
audio.url; // an object URL you can play
audio.format; // 'mp3'
audio.duration; // length in seconds (when known)

// Play it in the browser
const audioElement = new Audio(audio.url);
audioElement.play();

// Free the object URL when you're done with it
URL.revokeObjectURL(audio.url);
```

## API Reference

### Constructor

```typescript
new ResponsiveVoiceAPIClient(config: ResponsiveVoiceAPIClientConfig)
```

#### Configuration Options

| Option          | Type           | Default                                       | Description                                   |
| --------------- | -------------- | --------------------------------------------- | --------------------------------------------- |
| `apiKey`        | `string`       | _required_                                    | Your registered website/origin identifier     |
| `apiSecret`     | `string`       | _required_                                    | The credential that authorizes requests       |
| `baseUrl`       | `string`       | `https://texttospeech.responsivevoice.org/v2` | API base URL                                  |
| `timeout`       | `number`       | `30000`                                       | Request timeout in milliseconds               |
| `retryAttempts` | `number`       | `3`                                           | Number of retry attempts for transient errors |
| `retryDelay`    | `number`       | `1000`                                        | Base delay between retries in milliseconds    |
| `fetch`         | `typeof fetch` | `globalThis.fetch`                            | Custom fetch implementation                   |

### Methods

#### `synthesize(options, requestOptions?)`

Synthesize text to speech audio.

```typescript
const audio = await client.synthesize({
  text: 'Hello, world!',
  voice: 'UK English Female', // ResponsiveVoice name (resolved server-side)
  pitch: 0.5, // 0-1, optional
  rate: 0.5, // 0-1, optional
  volume: 1.0, // 0-1, optional
  format: 'mp3', // 'mp3' | 'ogg' | 'wav', optional
  gender: 'female', // 'male' | 'female', optional
});

console.log(audio.blob); // Blob
console.log(audio.url); // string (blob URL)
console.log(audio.format); // 'mp3' | 'ogg' | 'wav'
console.log(audio.duration); // number | undefined (seconds)
```

#### `getVoices(filters?, requestOptions?)`

Get all available voices, optionally filtered.

```typescript
// getVoices() returns { voices, systemVoices } — destructure what you need.

// Get all voices
const { voices } = await client.getVoices();

// Filter by language
const { voices: britishVoices } = await client.getVoices({ lang: 'en-GB' });

// Filter by gender
const { voices: femaleVoices } = await client.getVoices({ gender: 'female' });

// Filter by both
const { voices: britishFemaleVoices } = await client.getVoices({
  lang: 'en-GB',
  gender: 'female',
});
```

#### `getVoice(name, requestOptions?)`

Get a specific voice by name.

```typescript
const voice = await client.getVoice('UK English Female');
console.log(voice.name); // 'UK English Female'
console.log(voice.lang); // 'en-GB'
console.log(voice.service); // 'g1'
```

#### `getVoicesByLanguage(lang, requestOptions?)`

Get all voices for a specific language.

```typescript
const germanVoices = await client.getVoicesByLanguage('de-DE');
const frenchVoices = await client.getVoicesByLanguage('fr');
```

### Request Options

All methods accept an optional `RequestOptions` object:

```typescript
interface RequestOptions {
  timeout?: number; // Custom timeout for this request
  signal?: AbortSignal; // Abort signal for cancellation
  skipRetry?: boolean; // Skip retry logic for this request
}
```

Example with abort:

```typescript
const controller = new AbortController();

// Cancel after 5 seconds
setTimeout(() => controller.abort(), 5000);

try {
  const audio = await client.synthesize(
    { text: 'Long text...', lang: 'en-US' },
    { signal: controller.signal },
  );
} catch (error) {
  if (error.name === 'TimeoutError') {
    console.log('Request was cancelled');
  }
}
```

## Error Handling

The client throws specific error types for different failure scenarios:

```typescript
import {
  ResponsiveVoiceError, // Base error class
  ApiError, // API returned an error response
  AuthError, // Authentication failed (401/403)
  NotFoundError, // Resource not found (404)
  RateLimitError, // Rate limited (429)
  ValidationError, // Request validation failed (400)
  NetworkError, // Network connectivity issues
  TimeoutError, // Request timed out
  RetryExhaustedError, // All retry attempts failed
} from '@responsivevoice/api-client';

try {
  const audio = await client.synthesize({ text: '', lang: 'en-US' });
} catch (error) {
  if (error instanceof ValidationError) {
    console.error('Validation failed:', error.errors);
  } else if (error instanceof AuthError) {
    console.error('Authentication failed:', error.message);
  } else if (error instanceof RateLimitError) {
    console.error(`Rate limited. Retry after ${error.retryAfter} seconds`);
  } else if (error instanceof TimeoutError) {
    console.error(`Request timed out after ${error.timeout}ms`);
  } else if (error instanceof NetworkError) {
    console.error('Network error:', error.message);
  }
}
```

## Retry Behavior

The client automatically retries requests that fail due to:

- Server errors (5xx status codes)
- Rate limiting (429) - uses `Retry-After` header if provided
- Network errors

Client errors (4xx except 429) are NOT retried.

Retry uses exponential backoff with jitter:

- Base delay: 1000ms
- Multiplier: 2x per attempt
- Max delay: 30000ms

You can customize retry behavior:

```typescript
const client = new ResponsiveVoiceAPIClient({
  apiKey: 'your-key',
  apiSecret: 'your-secret',
  retryAttempts: 5, // More attempts
  retryDelay: 500, // Faster initial retry
});
```

Or skip retries for a specific request:

```typescript
const audio = await client.synthesize(
  { text: 'Hello', lang: 'en-US' },
  { skipRetry: true },
);
```

## Browser Support

This package supports all modern browsers. For detailed compatibility information, see the [Browser Support documentation](https://docs.responsivevoice.org/guides/browser-support/).

**Minimum browser versions:**

- Chrome 66+
- Firefox 57+
- Safari 12+
- Edge 17+

## Node.js Support

The package requires Node.js 16+ and works in both Node.js and browser environments.

**Node.js 18+** — all features work out of the box (native `fetch`, `Blob`, `AbortController`).

**Node.js 16–17** — pass a `fetch` implementation via config:

```typescript
import fetch from 'node-fetch';

const client = new ResponsiveVoiceAPIClient({
  apiKey: 'your-key',
  apiSecret: 'your-secret',
  fetch,
});
```

**WebSocket streaming on Node.js < 22** — the global `WebSocket` was added in Node.js 22. On older versions, pass a WebSocket implementation:

```typescript
import WebSocket from 'ws';
import { WebSocketConnection } from '@responsivevoice/api-client';

const ws = new WebSocketConnection({
  baseUrl: 'https://texttospeech.responsivevoice.org',
  apiKey: 'your-key',
  WebSocket,
});
```

## License

MIT

---

**Other language SDKs:** [Python](https://github.com/responsivevoice/sdk-python) · [Go](https://github.com/responsivevoice/sdk-go) · [PHP](https://github.com/responsivevoice/sdk-php) · [Java](https://github.com/responsivevoice/sdk-java)
