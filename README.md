# @enkryptify/sdk

[![CI](https://github.com/enkryptify/sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/enkryptify/sdk/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@enkryptify/sdk)](https://www.npmjs.com/package/@enkryptify/sdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Official TypeScript SDK for [Enkryptify](https://enkryptify.com) — fetch and manage secrets from the Enkryptify API.

## Installation

```bash
pnpm add @enkryptify/sdk
```

```bash
npm install @enkryptify/sdk
```

```bash
yarn add @enkryptify/sdk
```

## Quick Start

```typescript
import Enkryptify from "@enkryptify/sdk";

const client = new Enkryptify({
    auth: Enkryptify.fromEnv(),
    workspace: "my-workspace",
    project: "my-project",
    environment: "env-id",
});

const dbUrl = await client.get("DATABASE_URL");
```

## Usage

### Preloading Secrets

When caching is enabled (the default), you can preload all secrets up front. This makes subsequent `get()` and `getFromCache()` calls instant.

```typescript
const client = new Enkryptify({
    auth: Enkryptify.fromEnv(),
    workspace: "my-workspace",
    project: "my-project",
    environment: "env-id",
});

await client.preload();

// Synchronous — no API call needed
const dbHost = client.getFromCache("DB_HOST");
const dbPort = client.getFromCache("DB_PORT");
```

### Eager Caching

By default `cache.eager` is `true`. This means the first `get()` call fetches _all_ secrets and caches them, so subsequent calls are served from the cache without additional API requests.

```typescript
// First call fetches all secrets from the API
const dbHost = await client.get("DB_HOST");

// Second call is served from cache — no API call
const dbPort = await client.get("DB_PORT");
```

Set `cache.eager` to `false` to fetch secrets individually:

```typescript
const client = new Enkryptify({
    auth: Enkryptify.fromEnv(),
    workspace: "my-workspace",
    project: "my-project",
    environment: "env-id",
    cache: { eager: false },
});

// Each call fetches only the requested secret
const dbHost = await client.get("DB_HOST");
const dbPort = await client.get("DB_PORT");
```

### Bypassing the Cache

Pass `{ cache: false }` to always fetch a fresh value from the API:

```typescript
const secret = await client.get("ROTATING_KEY", { cache: false });
```

### Strict vs Non-Strict Mode

By default, `get()` throws a `SecretNotFoundError` when a key doesn't exist. Disable strict mode to return an empty string instead:

```typescript
const client = new Enkryptify({
    auth: Enkryptify.fromEnv(),
    workspace: "my-workspace",
    project: "my-project",
    environment: "env-id",
    options: { strict: false },
});

const value = await client.get("MAYBE_MISSING"); // "" if not found
```

### Personal Values

When `usePersonalValues` is `true` (the default), the SDK prefers your personal override for a secret. If no personal value exists, it falls back to the shared value.

```typescript
const client = new Enkryptify({
    auth: Enkryptify.fromEnv(),
    workspace: "my-workspace",
    project: "my-project",
    environment: "env-id",
    options: { usePersonalValues: false }, // always use shared values
});
```

### Cleanup

Destroy the client when you're done to clear all cached secrets from memory:

```typescript
client.destroy();
```

## Proxy

The Enkryptify proxy lets your code call upstream APIs without the secret values ever touching your process. Write `%VARIABLE_NAME%` placeholders in the URL, headers, or body, and Enkryptify substitutes them server-side before forwarding the request.

### Basic Usage (fetch-compatible)

```typescript
const res = await client.proxy.fetch("https://api.stripe.com/v1/charges", {
    method: "POST",
    headers: { Authorization: "Bearer %STRIPE_SECRET%" },
    body: JSON.stringify({ amount: 1000, currency: "usd" }),
});
const charge = await res.json();
```

`client.proxy.fetch` returns a standard `Response` — call `.json()`, `.text()`, `.arrayBuffer()`, etc. as needed.

### Wiring into axios, ky, or other HTTP clients

Because `client.proxy.fetch` matches the native `fetch` signature, any client that accepts a custom `fetch` implementation or fetch adapter will work:

```typescript
// axios (1.7+)
import axios from "axios";
const api = axios.create({ adapter: "fetch", fetch: client.proxy.fetch });
const res = await api.get("https://api.upstream.com/x?key=%API_KEY%");

// ky
import ky from "ky";
const api = ky.extend({ fetch: client.proxy.fetch });
const data = await api.get("https://api.upstream.com/x?key=%API_KEY%").json();
```

### Low-level Request API

Prefer `client.proxy.request` when writing new code — it takes a typed JSON body directly and skips the fetch-init translation:

```typescript
const res = await client.proxy.request({
    url: "https://api.upstream.com/x",
    method: "POST",
    headers: { "X-Auth": "Bearer %TOKEN%" },
    body: { user: "%USER_ID%" },
    // Optional per-call overrides:
    // environment: "other-env-id",
});
```

### Proxy-Only Clients

If your token has no permission to read secrets directly (proxy-gated access), set `proxy.proxyOnly` so that `.get()` / `.preload()` / `.getFromCache()` throw a clear error pointing users at the proxy:

```typescript
const client = new Enkryptify({
    token: process.env.ENKRYPTIFY_TOKEN,
    workspace: "demo",
    project: "proxy",
    environment: "env-id",
    proxy: { proxyOnly: true },
});

// Throws: "This client is configured as proxy-only. Use client.proxy.fetch() or client.proxy.request() instead."
await client.get("SOME_KEY");

// Works as expected:
await client.proxy.fetch("https://api.upstream.com/x?key=%SOME_KEY%");
```

### Body Restrictions

The proxy operates on JSON payloads (so it can template `%VARIABLE%` placeholders). Non-JSON bodies throw with a clear message:

- ✅ plain objects / arrays / primitives / `JSON.stringify`-ed strings
- ❌ `FormData`, `Blob`, `ArrayBuffer`, typed arrays, `ReadableStream`, `URLSearchParams`

GET and HEAD requests cannot include a body (matches the proxy contract).

## Configuration

| Option                      | Type                                     | Default                        | Description                                      |
| --------------------------- | ---------------------------------------- | ------------------------------ | ------------------------------------------------ |
| `auth`                      | `EnkryptifyAuthProvider`                 | _required_                     | Auth provider created via `Enkryptify.fromEnv()` |
| `workspace`                 | `string`                                 | _required_                     | Workspace slug or ID                             |
| `project`                   | `string`                                 | _required_                     | Project slug or ID                               |
| `environment`               | `string`                                 | _required_                     | Environment ID                                   |
| `baseUrl`                   | `string`                                 | `"https://api.enkryptify.com"` | API base URL                                     |
| `options.strict`            | `boolean`                                | `true`                         | Throw on missing secrets                         |
| `options.usePersonalValues` | `boolean`                                | `true`                         | Prefer personal secret values                    |
| `cache.enabled`             | `boolean`                                | `true`                         | Enable in-memory caching                         |
| `cache.ttl`                 | `number`                                 | `-1`                           | Cache TTL in ms (`-1` = never expire)            |
| `cache.eager`               | `boolean`                                | `true`                         | Fetch all secrets on first `get()`               |
| `logger.level`              | `"debug" \| "info" \| "warn" \| "error"` | `"info"`                       | Minimum log level                                |
| `proxy.url`                 | `string`                                 | POC URL (overridable)          | Proxy service URL                                |
| `proxy.proxyOnly`           | `boolean`                                | `false`                        | Disable direct secret access; require proxy      |

### Environment Variables

| Variable                | Description                                         |
| ----------------------- | --------------------------------------------------- |
| `ENKRYPTIFY_TOKEN`      | Auth token, used when no `token` / `auth` is passed |
| `ENKRYPTIFY_API_URL`    | Overrides the default `baseUrl`                     |
| `ENKRYPTIFY_PROXY_URL`  | Overrides the default proxy URL                     |
| `ENKRYPTIFY_TOKEN_PATH` | Kubernetes service account token path               |

## API Reference

### `Enkryptify.fromEnv(): EnkryptifyAuthProvider`

Creates an auth provider by reading the `ENKRYPTIFY_TOKEN` environment variable.

### `client.get(key, options?): Promise<string>`

Fetches a secret by key. Uses the cache when available, otherwise calls the API.

- `key` — the secret name
- `options.cache` — set to `false` to bypass the cache (default: `true`)

### `client.getFromCache(key): string`

Returns a secret from the cache synchronously. Throws if the key is not cached or caching is disabled.

### `client.preload(): Promise<void>`

Fetches all secrets and populates the cache. Throws if caching is disabled.

### `client.destroy(): void`

Clears the cache and marks the client as destroyed. All subsequent method calls will throw.

## Error Handling

The SDK provides specific error classes so you can handle different failure modes:

```typescript
import Enkryptify, { SecretNotFoundError, AuthenticationError, ApiError } from "@enkryptify/sdk";

try {
    const value = await client.get("MY_SECRET");
} catch (error) {
    if (error instanceof SecretNotFoundError) {
        // Secret doesn't exist in the project/environment
    } else if (error instanceof AuthenticationError) {
        // Token is invalid or expired (HTTP 401/403)
    } else if (error instanceof ApiError) {
        // Other API error (500, network issues, etc.)
    }
}
```

| Error Class            | When                                                    |
| ---------------------- | ------------------------------------------------------- |
| `EnkryptifyError`      | Base class for all SDK errors                           |
| `SecretNotFoundError`  | Secret key not found in the project/environment         |
| `AuthenticationError`  | HTTP 401 from the API or proxy                          |
| `AuthorizationError`   | HTTP 403 from the API or proxy                          |
| `NotFoundError`        | HTTP 404 from the API (wrong workspace/project/env)     |
| `RateLimitError`       | HTTP 429 (includes `retryAfter` in seconds)             |
| `ApiError`             | Any other non-OK response from the secrets API          |
| `ProxyError`           | Any non-OK, non-400 response from the proxy service     |
| `ProxyValidationError` | HTTP 400 from the proxy (bad URL, method, body, config) |
| `KubernetesAuthError`  | Kubernetes service account token read failed            |

## Development

```bash
# Install dependencies
pnpm install

# Build
pnpm build

# Run tests
pnpm test

# Run tests in watch mode
pnpm test:watch

# Lint
pnpm lint

# Format
pnpm format

# Typecheck
pnpm typecheck
```

## Contributing

Please read our [Contributing Guide](CONTRIBUTING.md) before submitting a pull request.

## License

[MIT](LICENSE)
