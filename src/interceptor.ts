import type { InterceptorConfig, InterceptorRule, InterceptorUrlMatcher, JsonValue, ProxyMethod } from "@/types";
import type { ProxyWireBody } from "@/proxy";
import { EnkryptifyError, InterceptorError, ProxyError } from "@/errors";
import type { Logger } from "@/logger";
import { mergeHeaders, resolveBody, templateUrl } from "@/internal/template";

/**
 * Minimal shape of the `BatchInterceptor` instance we use. Keeping this
 * local avoids a hard top-level import of `@mswjs/interceptors`, which we
 * load dynamically so consumers who never configure the interceptor don't
 * pay for it at process start.
 */
interface BatchInterceptorLike {
    apply(): void;
    dispose(): void;
    on(
        event: "request",
        listener: (args: {
            request: Request;
            requestId: string;
            controller: {
                respondWith(response: Response): void;
                errorWith(reason?: unknown): void;
            };
        }) => Promise<void> | void,
    ): unknown;
}

export interface HttpInterceptorInit {
    config: InterceptorConfig;
    sendWire: (body: ProxyWireBody, signal: AbortSignal | null) => Promise<Response>;
    defaults: {
        workspace: string;
        project: string;
        environment: string;
    };
    logger: Logger;
}

const VALID_METHODS: ReadonlySet<ProxyMethod> = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

/**
 * Routes outbound HTTP(S) / fetch traffic matching configured rules through
 * the Enkryptify proxy so secrets stay server-side.
 *
 * Uses `@mswjs/interceptors` to patch `http.request`, `https.request`, and
 * `globalThis.fetch` — covering every Node HTTP client (axios, got, 3rd-party
 * SDKs, etc.). The library is imported dynamically inside `enable()` so the
 * cost is only paid when the interceptor is actually in use.
 */
export class HttpInterceptor {
    #rules: InterceptorRule[];
    #sendWire: HttpInterceptorInit["sendWire"];
    #defaults: HttpInterceptorInit["defaults"];
    #logger: Logger;
    #batch: BatchInterceptorLike | null = null;
    #enabled = false;
    #ready: Promise<void> | null = null;

    constructor(init: HttpInterceptorInit) {
        this.#rules = init.config.rules;
        this.#sendWire = init.sendWire;
        this.#defaults = init.defaults;
        this.#logger = init.logger;
    }

    /**
     * Resolves once the interceptor has patched the global HTTP stack.
     * Requests issued before this promise settles bypass interception.
     */
    get ready(): Promise<void> {
        return this.#ready ?? Promise.resolve();
    }

    /**
     * Patch the global HTTP stack. Async because `@mswjs/interceptors` is
     * loaded via dynamic `import()`. Safe to call multiple times — subsequent
     * calls are no-ops.
     */
    async enable(): Promise<void> {
        if (this.#enabled) return;
        this.#enabled = true;

        this.#ready = (async () => {
            // Dynamic import so `@mswjs/interceptors` isn't pulled into the
            // process when the interceptor isn't configured. tsup leaves
            // dynamic imports un-bundled in both ESM and CJS output.
            const [{ BatchInterceptor }, nodePresets] = await Promise.all([
                import("@mswjs/interceptors"),
                import("@mswjs/interceptors/presets/node"),
            ]);

            const batch = new BatchInterceptor({
                name: "enkryptify-sdk",
                interceptors: nodePresets.default,
            }) as unknown as BatchInterceptorLike;

            batch.apply();
            batch.on("request", (args) => this.#onRequest(args));

            this.#batch = batch;
            this.#logger.debug(`Interceptor enabled with ${this.#rules.length} rule(s)`);
        })();

        await this.#ready;
    }

    /**
     * Restore the global HTTP stack. Safe to call multiple times.
     */
    disable(): void {
        if (!this.#enabled) return;
        this.#enabled = false;
        try {
            this.#batch?.dispose();
        } catch (error) {
            this.#logger.warn(`Interceptor dispose failed: ${(error as Error).message}`);
        }
        this.#batch = null;
        this.#ready = null;
        this.#logger.debug("Interceptor disabled");
    }

    async #onRequest(args: {
        request: Request;
        requestId: string;
        controller: {
            respondWith(response: Response): void;
            errorWith(reason?: unknown): void;
        };
    }): Promise<void> {
        const { request, controller } = args;

        const rule = this.#matchRule(request);
        if (!rule) return; // passthrough — mswjs lets the real request proceed

        try {
            const wire = await this.#translate(request, rule);
            if (wire === "passthrough") return;

            const response = await this.#sendWire(wire, request.signal);
            controller.respondWith(response);
        } catch (error) {
            if (error instanceof EnkryptifyError) {
                controller.errorWith(error);
                return;
            }
            const message = error instanceof Error ? error.message : String(error);
            controller.errorWith(new ProxyError(0, "Network error while contacting Enkryptify proxy", message));
        }
    }

    #matchRule(request: Request): InterceptorRule | null {
        for (const rule of this.#rules) {
            try {
                if (matches(rule.match, request.url, request)) {
                    this.#logger.debug(
                        `Interceptor matched rule ${rule.name ?? "(unnamed)"} for ${request.method} ${request.url}`,
                    );
                    return rule;
                }
            } catch (error) {
                // A broken matcher must not take down the caller's request.
                this.#logger.error(
                    `Interceptor matcher for rule "${rule.name ?? "(unnamed)"}" threw: ${(error as Error).message}`,
                );
            }
        }
        return null;
    }

    async #translate(request: Request, rule: InterceptorRule): Promise<ProxyWireBody | "passthrough"> {
        const method = request.method.toUpperCase() as ProxyMethod;
        if (!VALID_METHODS.has(method)) {
            throw new InterceptorError(
                `Intercepted request uses unsupported method "${request.method}". ` +
                    "The proxy supports GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS.",
            );
        }

        // Extract headers as a plain record. Headers iteration gives lowercase
        // keys, which is what the proxy and our merge layer both expect.
        const interceptedHeaders: Record<string, string> = {};
        request.headers.forEach((value, key) => {
            interceptedHeaders[key] = value;
        });

        // Extract body only when needed. Clone so the underlying stream stays
        // consumable for the fallback passthrough path.
        //
        // We need the intercepted body in two cases:
        //   1. No rule body override → forward it verbatim.
        //   2. The override is a function → feed it to the function.
        // Object/string overrides discard the intercepted body, so skip reading
        // (saves the decode and avoids tripping on non-JSON bodies that would
        // otherwise force `onUnsupportedBody` handling pointlessly).
        let interceptedBody: JsonValue | undefined;
        const hasBody = method !== "GET" && method !== "HEAD";
        const needsInterceptedBody = hasBody && (rule.body === undefined || typeof rule.body === "function");
        if (needsInterceptedBody) {
            const extraction = await extractJsonBody(request);
            if (extraction === "unsupported") {
                return this.#handleUnsupportedBody(request, rule);
            }
            interceptedBody = extraction;
        }

        const templatedUrl = templateUrl(request.url, rule.url);
        const mergedHeaders = mergeHeaders(interceptedHeaders, rule.headers);
        const finalBody = hasBody ? resolveBody(interceptedBody, rule.body) : undefined;

        return {
            url: templatedUrl,
            method,
            headers: mergedHeaders,
            body: finalBody,
            workspace: rule.workspace ?? this.#defaults.workspace,
            project: rule.project ?? this.#defaults.project,
            "environment-id": rule.environment ?? this.#defaults.environment,
        };
    }

    #handleUnsupportedBody(request: Request, rule: InterceptorRule): "passthrough" {
        const label = rule.name ?? "(unnamed)";
        if (rule.onUnsupportedBody === "error") {
            throw new InterceptorError(
                `Rule "${label}" matched ${request.method} ${request.url}, but the request body ` +
                    "is not JSON-serialisable (stream/Blob/FormData/URLSearchParams/binary). " +
                    'Set `onUnsupportedBody: "passthrough"` to skip interception for such requests, ' +
                    "or provide a rule-level `body` override.",
            );
        }
        this.#logger.warn(
            `Rule "${label}" matched ${request.method} ${request.url} but the body is not ` +
                "JSON-serialisable — passing the request through uninterrupted.",
        );
        return "passthrough";
    }
}

function matches(matcher: InterceptorUrlMatcher, url: string, request: Request): boolean {
    if (typeof matcher === "string") {
        return url.startsWith(matcher);
    }
    if (matcher instanceof RegExp) {
        return matcher.test(url);
    }
    return matcher(url, request);
}

/**
 * Reads the intercepted request body as a JSON value. Returns:
 *   - the parsed JSON value on success
 *   - `undefined` when the request has no body
 *   - the sentinel `"unsupported"` when the body is present but not JSON
 *
 * We clone the request first so the original body stream is still intact for
 * the fallback passthrough path.
 */
async function extractJsonBody(request: Request): Promise<JsonValue | undefined | "unsupported"> {
    const clone = request.clone();

    // No body at all.
    if (clone.body === null || clone.body === undefined) {
        return undefined;
    }

    const contentType = request.headers.get("content-type") ?? "";
    const looksJson = /\bjson\b/i.test(contentType) || contentType === "";

    if (!looksJson) {
        return "unsupported";
    }

    let text: string;
    try {
        text = await clone.text();
    } catch {
        return "unsupported";
    }

    if (text.length === 0) return undefined;

    try {
        return JSON.parse(text) as JsonValue;
    } catch {
        return "unsupported";
    }
}
