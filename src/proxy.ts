import type {
    EnkryptifyAuthProvider,
    IEnkryptifyProxy,
    JsonValue,
    ProxyMethod,
    ProxyRequestInit,
    ProxyRequestOptions,
    TokenExchange,
} from "@/types";
import { EnkryptifyError } from "@/errors";
import type { Logger } from "@/logger";
import { retrieveToken } from "@/internal/token-store";

const ALLOWED_METHODS: readonly ProxyMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

export interface EnkryptifyProxyInit {
    proxyUrl: string;
    auth: EnkryptifyAuthProvider;
    tokenExchange: TokenExchange | null;
    workspace: string;
    project: string;
    environment: string;
    logger: Logger;
    isDestroyed: () => boolean;
}

/**
 * Internal wire format the SDK POSTs to the Enkryptify proxy service. Exported
 * for reuse by the HTTP interceptor (which builds these directly). Not part
 * of the public SDK surface — do not import from `@enkryptify/sdk`.
 */
export interface ProxyWireBody {
    url: string;
    method: ProxyMethod;
    headers?: Record<string, string>;
    body?: JsonValue;
    workspace: string;
    project: string;
    "environment-id": string;
}

/**
 * Shared context needed to POST a `ProxyWireBody` to the proxy service.
 * Passed to `sendProxyWire()` by both `EnkryptifyProxy` and `HttpInterceptor`.
 */
export interface ProxySendContext {
    proxyUrl: string;
    auth: EnkryptifyAuthProvider;
    tokenExchange: TokenExchange | null;
    logger: Logger;
    isDestroyed: () => boolean;
}

/**
 * Low-level: POSTs a pre-built wire body to the proxy service. Handles token
 * exchange, Bearer auth, destroyed-guard, and debug logging. Returns the
 * upstream `Response` verbatim (no status-based error mapping — see the notes
 * on `EnkryptifyProxy.#send` for why).
 */
export async function sendProxyWire(
    ctx: ProxySendContext,
    body: ProxyWireBody,
    signal: AbortSignal | null,
): Promise<Response> {
    if (ctx.isDestroyed()) {
        throw new EnkryptifyError(
            "This Enkryptify client has been destroyed. Create a new instance to continue.\n" +
                "Docs: https://docs.enkryptify.com/sdk/lifecycle",
        );
    }

    await ctx.tokenExchange?.ensureToken();

    const token = retrieveToken(ctx.auth);

    // Strip undefined fields from the wire body so we don't send `"body": null`
    // when the user didn't specify one.
    const wireBody: Record<string, unknown> = {
        url: body.url,
        method: body.method,
    };
    if (body.headers !== undefined) wireBody.headers = body.headers;
    if (body.body !== undefined) wireBody.body = body.body;

    const proxyRequestUrl = buildProxyRequestUrl(ctx.proxyUrl, body.workspace, body.project, body["environment-id"]);
    ctx.logger.debug(`Proxy request: ${body.method} ${body.url}`);
    const start = Date.now();

    const response = await fetch(proxyRequestUrl, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(wireBody),
        signal,
    });

    ctx.logger.debug(`Proxy responded with HTTP ${response.status} in ${Date.now() - start}ms`);

    // Return the Response verbatim — whatever status, body, and headers it carries.
    //
    // The Proxy forwards upstream responses unchanged (2xx or not), so mapping status
    // codes to typed errors here is fundamentally unsafe: an upstream 401 from the
    // caller's target API (e.g. OpenWeatherMap rejecting its own API key) is
    // indistinguishable on the wire from a proxy 401 (e.g. Enkryptify token expired),
    // and translating both into AuthenticationError produced wrong, misleading errors.
    //
    // Callers handle non-2xx like native fetch: check `response.ok` / `response.status`
    // and read the body. Proxy-layer errors are delivered as `{error: {code, message}}`
    // JSON bodies that callers can parse for specifics.
    return response;
}

export class EnkryptifyProxy implements IEnkryptifyProxy {
    #ctx: ProxySendContext;
    #workspace: string;
    #project: string;
    #environment: string;

    // Public-surface methods — rebound in the constructor so that
    // `const { fetch } = client.proxy` (the pattern users need for wiring into
    // axios's `fetch` option or ky's `fetch`) keeps working.
    fetch: (input: string | URL, init?: ProxyRequestInit) => Promise<Response>;
    request: (options: ProxyRequestOptions) => Promise<Response>;

    constructor(init: EnkryptifyProxyInit) {
        this.#ctx = {
            proxyUrl: init.proxyUrl,
            auth: init.auth,
            tokenExchange: init.tokenExchange,
            logger: init.logger,
            isDestroyed: init.isDestroyed,
        };
        this.#workspace = init.workspace;
        this.#project = init.project;
        this.#environment = init.environment;

        this.fetch = this.#fetchImpl.bind(this);
        this.request = this.#requestImpl.bind(this);
    }

    /** Internal: expose the shared context to the HTTP interceptor. */
    get _ctx(): ProxySendContext {
        return this.#ctx;
    }

    async #fetchImpl(input: string | URL, init?: ProxyRequestInit): Promise<Response> {
        if (typeof Request !== "undefined" && input instanceof Request) {
            throw new EnkryptifyError(
                "client.proxy.fetch does not accept Request objects. Pass a URL string or URL instance instead.\n" +
                    "Docs: https://docs.enkryptify.com/sdk/proxy",
            );
        }

        const url = typeof input === "string" ? input : String(input);

        const method = normalizeMethod(init?.method);
        const headers = normalizeHeaders(init?.headers);
        const body = parseFetchBody(init?.body);

        if ((method === "GET" || method === "HEAD") && body !== undefined) {
            throw new EnkryptifyError(
                `${method} requests cannot include a body. Remove the body or change the method.\n` +
                    "Docs: https://docs.enkryptify.com/sdk/proxy",
            );
        }

        return sendProxyWire(
            this.#ctx,
            {
                url,
                method,
                headers,
                body,
                ...this.#buildScope(),
            },
            init?.signal ?? null,
        );
    }

    async #requestImpl(options: ProxyRequestOptions): Promise<Response> {
        if (!options.url) {
            throw new EnkryptifyError("Proxy request requires a non-empty `url`.");
        }
        if (!options.method) {
            throw new EnkryptifyError("Proxy request requires a `method`.");
        }

        const method = normalizeMethod(options.method);

        if ((method === "GET" || method === "HEAD") && options.body !== undefined) {
            throw new EnkryptifyError(
                `${method} requests cannot include a body. Remove the body or change the method.\n` +
                    "Docs: https://docs.enkryptify.com/sdk/proxy",
            );
        }

        const scope = this.#buildScope({
            workspace: options.workspace,
            project: options.project,
            environment: options.environment,
        });

        return sendProxyWire(
            this.#ctx,
            {
                url: options.url,
                method,
                headers: options.headers,
                body: options.body,
                ...scope,
            },
            null,
        );
    }

    #buildScope(overrides?: {
        workspace?: string;
        project?: string;
        environment?: string;
    }): Pick<ProxyWireBody, "workspace" | "project" | "environment-id"> {
        return {
            workspace: overrides?.workspace ?? this.#workspace,
            project: overrides?.project ?? this.#project,
            "environment-id": overrides?.environment ?? this.#environment,
        };
    }
}

function normalizeMethod(method?: string): ProxyMethod {
    const upper = (method ?? "GET").toUpperCase();
    if (!ALLOWED_METHODS.includes(upper as ProxyMethod)) {
        throw new EnkryptifyError(
            `Unsupported HTTP method "${method}". Supported methods: ${ALLOWED_METHODS.join(", ")}.`,
        );
    }
    return upper as ProxyMethod;
}

function normalizeHeaders(input: HeadersInit | undefined): Record<string, string> | undefined {
    if (input === undefined) return undefined;

    const out: Record<string, string> = {};
    const headers = new Headers(input);
    headers.forEach((value, key) => {
        out[key] = value;
    });

    // If the input was empty, return undefined to avoid sending `"headers": {}`.
    return Object.keys(out).length > 0 ? out : undefined;
}

function parseFetchBody(body: BodyInit | JsonValue | null | undefined): JsonValue | undefined {
    if (body === undefined || body === null) return undefined;

    // Reject binary / form / stream body types — the proxy substitutes
    // %VARIABLE% placeholders which only makes sense for JSON-encoded payloads.
    if (typeof Blob !== "undefined" && body instanceof Blob) {
        throw bodyTypeError("Blob");
    }
    if (typeof FormData !== "undefined" && body instanceof FormData) {
        throw bodyTypeError("FormData");
    }
    if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
        throw bodyTypeError("URLSearchParams");
    }
    if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) {
        throw bodyTypeError("ReadableStream");
    }
    if (typeof ArrayBuffer !== "undefined" && body instanceof ArrayBuffer) {
        throw bodyTypeError("ArrayBuffer");
    }
    if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(body as ArrayBufferView)) {
        throw bodyTypeError("typed array");
    }

    // Treat strings as JSON — this is what axios/ky/etc. produce after their
    // internal JSON.stringify step.
    if (typeof body === "string") {
        try {
            return JSON.parse(body) as JsonValue;
        } catch {
            throw new EnkryptifyError(
                "Proxy body must be JSON-serializable. Received a non-JSON string; " +
                    "pass an object/array/primitive directly or JSON.stringify first.\n" +
                    "Docs: https://docs.enkryptify.com/sdk/proxy",
            );
        }
    }

    // Already a JSON-serializable value (plain object, array, number, boolean)
    return body as JsonValue;
}

function bodyTypeError(typeName: string): EnkryptifyError {
    return new EnkryptifyError(
        `Proxy only accepts JSON-compatible bodies. Received a ${typeName}. ` +
            "Convert the value to a JSON-serializable object/string before calling the proxy.\n" +
            "Docs: https://docs.enkryptify.com/sdk/proxy",
    );
}

function buildProxyRequestUrl(baseUrl: string, workspace: string, project: string, environmentId: string): string {
    const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
    return `${normalizedBaseUrl}/${encodeURIComponent(workspace)}/${encodeURIComponent(project)}/${encodeURIComponent(environmentId)}`;
}
