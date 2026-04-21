export interface IEnkryptify {
    /**
     * Gets a secret by key.
     *
     * Uses the cache by default when available. Otherwise, fetches the secret
     * from the API.
     *
     * @param key - The key of the secret to retrieve.
     * @param options - Options for the get operation.
     * @param options.cache - Whether to use the cache when available. Defaults to `true`.
     * @returns The value of the secret.
     */
    get(
        key: string,
        options?: {
            cache?: boolean;
        },
    ): Promise<string>;

    /**
     * Gets a secret by key from the cache.
     *
     * Throws if the secret is not already cached.
     *
     * @param key - The key of the secret to retrieve.
     * @returns The cached value of the secret.
     * @throws {EnkryptifyError} If the secret is not in the cache.
     */
    getFromCache(key: string): string;

    /**
     * Preloads the cache with all secrets.
     *
     * @returns A promise that resolves when the cache has been preloaded.
     */
    preload(): Promise<void>;

    /**
     * Destroys the client, clearing all cached secrets.
     */
    destroy(): void;

    /**
     * Proxy namespace for sending requests through the Enkryptify proxy.
     *
     * The proxy substitutes `%VARIABLE_NAME%` placeholders in the URL, headers,
     * and body with the corresponding secret values server-side, then forwards
     * the request upstream. Secrets never touch the caller's process.
     */
    readonly proxy: IEnkryptifyProxy;
}

export interface EnkryptifyConfig {
    auth?: EnkryptifyAuthProvider;
    token?: string;
    workspace: string;
    project: string;
    environment: string;
    baseUrl?: string;
    useTokenExchange?: boolean;
    options?: {
        strict?: boolean;
        usePersonalValues?: boolean;
    };
    cache?: {
        enabled?: boolean;
        ttl?: number;
        eager?: boolean;
    };
    logger?: {
        level?: "debug" | "info" | "warn" | "error";
    };
    proxy?: ProxyConfig;
    interceptor?: InterceptorConfig;
}

export interface TokenExchangeResponse {
    accessToken: string;
    expiresIn: number;
    tokenType: string;
}

export interface EnkryptifyAuthProvider {
    readonly _brand: "EnkryptifyAuthProvider";
}

export interface KubernetesAuthOptions {
    tokenPath?: string;
}

export interface TokenExchange {
    ensureToken(): Promise<void>;
    destroy(): void;
}

export interface SecretValue {
    environmentId: string;
    value: string;
    isPersonal: boolean;
    reminder?: { id: string; type: "one_time" | "recurring"; nextReminderDate: string };
}

export interface Secret {
    id: string;
    name: string;
    note: string;
    type: string;
    dataType: string;
    values: SecretValue[];
    createdAt: string;
    updatedAt: string;
}

/**
 * A JSON-serializable value. Matches the `body` accepted by the proxy service.
 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * HTTP methods supported by the proxy.
 */
export type ProxyMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

/**
 * Proxy-related client configuration.
 */
export interface ProxyConfig {
    /**
     * Override the proxy service URL. Takes priority over the `ENKRYPTIFY_PROXY_URL`
     * environment variable.
     */
    url?: string;

    /**
     * When `true`, direct secret-fetching methods (`get`, `getFromCache`, `preload`)
     * throw a helpful error pointing users at `client.proxy.fetch()` / `.request()`.
     *
     * Use this for consumers whose tokens have no direct-secret-read permission.
     */
    proxyOnly?: boolean;
}

/**
 * Fetch-compatible init for `client.proxy.fetch`. Widens `body` to accept a
 * plain JSON-serializable value in addition to the standard `BodyInit`.
 */
export interface ProxyRequestInit extends Omit<RequestInit, "body"> {
    body?: BodyInit | JsonValue | null;
}

/**
 * Low-level options for `client.proxy.request`. Mirrors the proxy service's
 * request shape, but in the SDK's idiomatic camelCase.
 */
export interface ProxyRequestOptions {
    url: string;
    method: ProxyMethod;
    headers?: Record<string, string>;
    body?: JsonValue;
    /** Override the client's workspace for this request. */
    workspace?: string;
    /** Override the client's project for this request. */
    project?: string;
    /** Override the client's environment for this request. */
    environment?: string;
    /** Override the client's `usePersonalValues` setting for this request. */
    usePersonal?: boolean;
}

export interface IEnkryptifyProxy {
    /**
     * Fetch-compatible proxy call. Drop-in replacement for `globalThis.fetch`.
     *
     * Accepts a URL (string or `URL`) and a standard `RequestInit`. The SDK
     * translates the call into a POST against the proxy service with the
     * URL/method/headers/body and the workspace/project/environment context.
     *
     * Returns the upstream `Response` verbatim on success. On proxy-side
     * failures, throws `AuthenticationError` / `AuthorizationError` /
     * `RateLimitError` / `ProxyValidationError` / `ProxyError`.
     */
    fetch(input: string | URL, init?: ProxyRequestInit): Promise<Response>;

    /**
     * Low-level proxy call. Takes the proxy's request shape directly with
     * typed JSON body.
     */
    request(options: ProxyRequestOptions): Promise<Response>;
}

/**
 * Matches an outbound HTTP request against an interceptor rule.
 *
 * - `string`: prefix match against the full request URL. Example:
 *   `"https://api.openai.com/"` matches any URL starting with that.
 * - `RegExp`: tested against the full request URL.
 * - Predicate: custom escape hatch — receives the URL string and the
 *   intercepted `Request` object.
 */
export type InterceptorUrlMatcher = string | RegExp | ((url: string, request: Request) => boolean);

/**
 * A single interceptor rule. When `match` fires on an outbound request, the
 * request is rewritten to go through the Enkryptify proxy with the provided
 * header/URL/body substitutions. `%VARIABLE%` placeholders in header values,
 * URL template, and body are passed through to the proxy verbatim; the proxy
 * resolves them server-side so secrets never enter the caller's process.
 */
export interface InterceptorRule {
    /** Display name used in debug/warn logs. Optional. */
    name?: string;

    /** Which outbound URLs this rule captures. */
    match: InterceptorUrlMatcher;

    /**
     * Optional URL rewrite sent to the proxy. May contain `%VARIABLE%`
     * placeholders. The following simple template tokens are substituted
     * from the intercepted URL when present:
     *   - `{origin}` — protocol + host (e.g. `https://api.example.com`)
     *   - `{host}`   — host only (e.g. `api.example.com`)
     *   - `{path}`   — pathname (e.g. `/v1/models`)
     *   - `{search}` — query string including leading `?` (or empty)
     *
     * When omitted, the intercepted URL is forwarded as-is.
     */
    url?: string;

    /**
     * Header overrides. Values may contain `%VARIABLE%` placeholders. These
     * are merged OVER the intercepted request's headers (case-insensitive).
     * Explicit `undefined` deletes the header before the proxy call.
     */
    headers?: Record<string, string | undefined>;

    /**
     * Body override. Accepts:
     *   - a `JsonValue` (plain object/array/primitive) — replaces the body wholesale
     *   - a JSON-encoded string — parsed before being forwarded
     *   - a function that receives the parsed intercepted body and returns the replacement
     *
     * Omit to forward the intercepted body verbatim (JSON only — see
     * `onUnsupportedBody` for non-JSON handling).
     */
    body?: JsonValue | string | ((intercepted: JsonValue | undefined) => JsonValue | undefined);

    /** Override the client's workspace for this rule. */
    workspace?: string;
    /** Override the client's project for this rule. */
    project?: string;
    /** Override the client's environment for this rule. */
    environment?: string;
    /** Override the client's `usePersonalValues` setting for this rule. */
    usePersonal?: boolean;

    /**
     * How to handle intercepted requests whose body cannot be represented on
     * the proxy wire (streams, Blob, FormData, URLSearchParams, ArrayBuffer,
     * typed arrays, non-JSON strings).
     *
     *   - `"passthrough"` (default): let the original request reach the network
     *     unmodified and log a warning.
     *   - `"error"`: fail the intercepted request with an `InterceptorError`.
     */
    onUnsupportedBody?: "passthrough" | "error";
}

/**
 * Interceptor configuration. When enabled, the SDK patches the Node HTTP
 * stack (via `@mswjs/interceptors`) and reroutes matching outbound requests
 * through the Enkryptify proxy. The patching is reversed on `client.destroy()`.
 */
export interface InterceptorConfig {
    /**
     * Explicitly enable/disable the interceptor. Defaults to `true` when
     * `rules` is non-empty.
     */
    enabled?: boolean;

    /**
     * Ordered list of rules. The first matching rule wins; non-matching
     * requests pass through to the network unmodified.
     */
    rules: InterceptorRule[];
}
