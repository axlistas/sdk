import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Enkryptify, InterceptorError } from "@/index";
import { storeToken } from "@/internal/token-store";
import { mergeHeaders, resolveBody, templateUrl } from "@/internal/template";
import type { EnkryptifyAuthProvider, EnkryptifyConfig } from "@/types";

function createAuth(token = "ek_test"): EnkryptifyAuthProvider {
    const auth = { _brand: "EnkryptifyAuthProvider" as const };
    storeToken(auth, token);
    return auth;
}

function makeConfig(overrides?: Partial<EnkryptifyConfig>): EnkryptifyConfig {
    return {
        auth: createAuth(),
        workspace: "ws-1",
        project: "prj-1",
        environment: "env-1",
        baseUrl: "https://api.test.com",
        logger: { level: "error" },
        proxy: { url: "https://proxy.test.com" },
        ...overrides,
    };
}

/**
 * Normalise a vitest mock call into `{ url, headers, bodyText }`.
 *
 * The interceptor uses native fetch internally; when that nested call is
 * itself intercepted by @mswjs/interceptors and passed through to the
 * stubbed fetch, mswjs invokes the original with a `Request` object rather
 * than `(url, init)`. Handle both shapes so tests can inspect either.
 */
async function readCall(call: unknown[]): Promise<{
    url: string;
    headers: Record<string, string>;
    bodyText: string | null;
} | null> {
    const arg = call[0];
    if (typeof Request !== "undefined" && arg instanceof Request) {
        const headers: Record<string, string> = {};
        arg.headers.forEach((value, key) => {
            headers[key] = value;
        });
        let bodyText: string | null = null;
        try {
            bodyText = await arg.clone().text();
        } catch {
            bodyText = null;
        }
        return { url: arg.url, headers, bodyText };
    }
    if (typeof arg === "string" || arg instanceof URL) {
        const opts = call[1] as RequestInit | undefined;
        const rawHeaders = opts?.headers;
        const headers: Record<string, string> = {};
        if (rawHeaders instanceof Headers) {
            rawHeaders.forEach((value, key) => {
                headers[key] = value;
            });
        } else if (Array.isArray(rawHeaders)) {
            for (const [k, v] of rawHeaders) headers[k] = v;
        } else if (rawHeaders && typeof rawHeaders === "object") {
            for (const [k, v] of Object.entries(rawHeaders)) headers[k] = String(v);
        }
        const bodyText = typeof opts?.body === "string" ? (opts.body as string) : null;
        return { url: String(arg), headers, bodyText };
    }
    return null;
}

/**
 * Find the call to the proxy URL and return its parsed wire body.
 */
async function findProxyCall(fetchMock: ReturnType<typeof vi.fn>): Promise<Record<string, unknown> | null> {
    for (const call of fetchMock.mock.calls) {
        const parsed = await readCall(call);
        if (!parsed) continue;
        // mswjs sometimes normalises the URL with a trailing slash when it
        // runs through URL(); accept both shapes.
        if (parsed.url.startsWith("https://proxy.test.com/")) {
            if (parsed.bodyText === null) return null;
            try {
                return JSON.parse(parsed.bodyText) as Record<string, unknown>;
            } catch {
                return null;
            }
        }
    }
    return null;
}

/**
 * Find the call (if any) whose URL starts with `prefix` — regardless of
 * whether mswjs passed it through as a Request or (url, init) pair.
 */
async function findCallByUrlPrefix(
    fetchMock: ReturnType<typeof vi.fn>,
    prefix: string,
): Promise<{ url: string; headers: Record<string, string>; bodyText: string | null } | null> {
    for (const call of fetchMock.mock.calls) {
        const parsed = await readCall(call);
        if (parsed && parsed.url.startsWith(prefix)) return parsed;
    }
    return null;
}

// ---------------------------------------------------------------------------
// Pure helper tests: no interceptor state.
// ---------------------------------------------------------------------------

describe("templateUrl", () => {
    it("returns original URL when template is undefined", () => {
        expect(templateUrl("https://api.example.com/v1/users?q=1", undefined)).toBe(
            "https://api.example.com/v1/users?q=1",
        );
    });

    it("substitutes {origin}/{host}/{path}/{search} tokens", () => {
        const url = "https://api.openai.com/v1/chat/completions?model=gpt-4";
        expect(templateUrl(url, "{origin}{path}{search}")).toBe(url);
        expect(templateUrl(url, "https://proxy.example.com{path}{search}")).toBe(
            "https://proxy.example.com/v1/chat/completions?model=gpt-4",
        );
        expect(templateUrl(url, "https://{host}{path}")).toBe("https://api.openai.com/v1/chat/completions");
    });

    it("preserves %VARIABLE% tokens verbatim", () => {
        expect(templateUrl("https://api.example.com/v1/users", "https://api.example.com/v1/%USER_ID%")).toBe(
            "https://api.example.com/v1/%USER_ID%",
        );
    });

    it("handles empty query string", () => {
        expect(templateUrl("https://api.example.com/v1/users", "https://proxy.com{path}{search}")).toBe(
            "https://proxy.com/v1/users",
        );
    });
});

describe("mergeHeaders", () => {
    it("merges override onto intercepted", () => {
        const result = mergeHeaders(
            { "content-type": "application/json", "x-foo": "bar" },
            { authorization: "Bearer %KEY%" },
        );
        expect(result).toEqual({
            "content-type": "application/json",
            "x-foo": "bar",
            authorization: "Bearer %KEY%",
        });
    });

    it("override is case-insensitive against intercepted headers", () => {
        const result = mergeHeaders({ "content-type": "text/plain" }, { "Content-Type": "application/json" });
        expect(result).toEqual({ "content-type": "application/json" });
    });

    it("undefined override deletes the header", () => {
        const result = mergeHeaders(
            { "content-type": "application/json", authorization: "Bearer old" },
            { authorization: undefined },
        );
        expect(result).toEqual({ "content-type": "application/json" });
    });

    it("drops hop-by-hop headers", () => {
        const result = mergeHeaders(
            {
                host: "upstream.com",
                connection: "keep-alive",
                "content-length": "42",
                "transfer-encoding": "chunked",
                "x-keep": "1",
            },
            undefined,
        );
        expect(result).toEqual({ "x-keep": "1" });
    });

    it("returns undefined when result is empty", () => {
        expect(mergeHeaders({}, undefined)).toBeUndefined();
    });
});

describe("resolveBody", () => {
    it("returns intercepted body when override is undefined", () => {
        expect(resolveBody({ a: 1 }, undefined)).toEqual({ a: 1 });
        expect(resolveBody(undefined, undefined)).toBeUndefined();
    });

    it("returns object override wholesale", () => {
        expect(resolveBody({ original: true }, { user: "%USER%" })).toEqual({ user: "%USER%" });
    });

    it("parses JSON string override", () => {
        expect(resolveBody(undefined, '{"key": "%SECRET%"}')).toEqual({ key: "%SECRET%" });
    });

    it("throws on non-JSON string override", () => {
        expect(() => resolveBody(undefined, "not json")).toThrow(InterceptorError);
    });

    it("invokes function override with intercepted body", () => {
        const intercepted = { model: "gpt-4", messages: [] };
        const override = vi.fn((body: unknown) => ({ ...(body as object), apiKey: "%KEY%" }));
        const result = resolveBody(intercepted, override);
        expect(override).toHaveBeenCalledWith(intercepted);
        expect(result).toEqual({ model: "gpt-4", messages: [], apiKey: "%KEY%" });
    });
});

// ---------------------------------------------------------------------------
// Integration tests against real @mswjs/interceptors.
// Because the interceptor patches globalThis.fetch, these tests must stub
// fetch BEFORE the client is constructed so mswjs captures the stub as its
// passthrough target. Each test tears down via client.destroy().
// ---------------------------------------------------------------------------

let fetchMock: ReturnType<typeof vi.fn>;
let activeClient: Enkryptify | null = null;

beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
    activeClient?.destroy();
    activeClient = null;
    vi.unstubAllGlobals();
});

describe("interceptor — rule matching", () => {
    it("string prefix match routes fetch call through the proxy", async () => {
        fetchMock.mockResolvedValue(new Response('{"ok":true}', { status: 200 }));

        activeClient = new Enkryptify(
            makeConfig({
                interceptor: {
                    rules: [
                        {
                            match: "https://api.openai.com/",
                            headers: { Authorization: "Bearer %OPENAI_KEY%" },
                        },
                    ],
                },
            }),
        );
        await activeClient._interceptorReady();

        const response = await fetch("https://api.openai.com/v1/models");
        expect(response.status).toBe(200);

        const wire = await findProxyCall(fetchMock);
        expect(wire).not.toBeNull();
        expect(wire?.url).toBe("https://api.openai.com/v1/models");
        expect(wire?.method).toBe("GET");
        const openaiHeaders = (wire?.headers ?? {}) as Record<string, string>;
        expect(openaiHeaders.authorization).toBe("Bearer %OPENAI_KEY%");
    });

    it("regex match routes request through the proxy", async () => {
        fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));

        activeClient = new Enkryptify(
            makeConfig({
                interceptor: {
                    rules: [
                        {
                            match: /^https:\/\/api\.stripe\.com\//,
                            headers: { Authorization: "Bearer %STRIPE_KEY%" },
                        },
                    ],
                },
            }),
        );
        await activeClient._interceptorReady();

        await fetch("https://api.stripe.com/v1/charges");

        const wire = await findProxyCall(fetchMock);
        expect(wire?.url).toBe("https://api.stripe.com/v1/charges");
        const stripeHeaders = (wire?.headers ?? {}) as Record<string, string>;
        expect(stripeHeaders.authorization).toBe("Bearer %STRIPE_KEY%");
    });

    it("predicate match routes request through the proxy", async () => {
        fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
        const predicate = vi.fn((url: string) => url.includes("twilio.com"));

        activeClient = new Enkryptify(
            makeConfig({
                interceptor: {
                    rules: [
                        {
                            match: predicate,
                            headers: { Authorization: "Basic %TWILIO_AUTH%" },
                        },
                    ],
                },
            }),
        );
        await activeClient._interceptorReady();

        await fetch("https://api.twilio.com/2010-04-01/Accounts");

        expect(predicate).toHaveBeenCalled();
        const wire = await findProxyCall(fetchMock);
        expect(wire?.url).toBe("https://api.twilio.com/2010-04-01/Accounts");
    });

    it("non-matching URL passes through to the real target without proxy involvement", async () => {
        fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));

        activeClient = new Enkryptify(
            makeConfig({
                interceptor: {
                    rules: [
                        {
                            match: "https://api.openai.com/",
                            headers: { Authorization: "Bearer %OPENAI_KEY%" },
                        },
                    ],
                },
            }),
        );
        await activeClient._interceptorReady();

        await fetch("https://example.com/some/path");

        // The only fetch should have gone directly to example.com — no proxy POST.
        expect(await findProxyCall(fetchMock)).toBeNull();
        const exampleCall = await findCallByUrlPrefix(fetchMock, "https://example.com");
        expect(exampleCall).not.toBeNull();
    });

    it("first matching rule wins when multiple rules overlap", async () => {
        fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));

        activeClient = new Enkryptify(
            makeConfig({
                interceptor: {
                    rules: [
                        { name: "first", match: "https://api.example.com/", headers: { "x-source": "first" } },
                        { name: "second", match: "https://api.example.com/", headers: { "x-source": "second" } },
                    ],
                },
            }),
        );
        await activeClient._interceptorReady();

        await fetch("https://api.example.com/v1");

        const wire = await findProxyCall(fetchMock);
        const mergedHeaders = (wire?.headers ?? {}) as Record<string, string>;
        expect(mergedHeaders["x-source"]).toBe("first");
    });
});

describe("interceptor — ProxyWireBody shape", () => {
    it("puts client default context in the proxy URL path", async () => {
        fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));

        activeClient = new Enkryptify(
            makeConfig({
                workspace: "ws-x",
                project: "prj-y",
                environment: "env-z",
                options: { usePersonalValues: false },
                interceptor: {
                    rules: [{ match: "https://api.example.com/", headers: { authorization: "Bearer %K%" } }],
                },
            }),
        );
        await activeClient._interceptorReady();

        await fetch("https://api.example.com/v1");

        await findProxyCall(fetchMock);
        const proxyCall = await findCallByUrlPrefix(fetchMock, "https://proxy.test.com/");
        expect(proxyCall?.url).toBe("https://proxy.test.com/ws-x/prj-y/env-z");
    });

    it("rule-level workspace/project/environment override defaults", async () => {
        fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));

        activeClient = new Enkryptify(
            makeConfig({
                interceptor: {
                    rules: [
                        {
                            match: "https://api.example.com/",
                            headers: { authorization: "Bearer %K%" },
                            workspace: "override-ws",
                            project: "override-prj",
                            environment: "override-env",
                        },
                    ],
                },
            }),
        );
        await activeClient._interceptorReady();

        await fetch("https://api.example.com/v1");

        await findProxyCall(fetchMock);
        const proxyCall = await findCallByUrlPrefix(fetchMock, "https://proxy.test.com/");
        expect(proxyCall?.url).toBe("https://proxy.test.com/override-ws/override-prj/override-env");
    });

    it("sends Authorization: Bearer <token> on the proxy call", async () => {
        fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));

        activeClient = new Enkryptify(
            makeConfig({
                auth: createAuth("my-sdk-token"),
                interceptor: {
                    rules: [{ match: "https://api.example.com/", headers: { authorization: "Bearer %K%" } }],
                },
            }),
        );
        await activeClient._interceptorReady();

        await fetch("https://api.example.com/v1");

        const proxyCall = await findCallByUrlPrefix(fetchMock, "https://proxy.test.com");
        expect(proxyCall).not.toBeNull();
        // Header names come back lowercased when passing through a Request
        // object (the passthrough path mswjs uses). Match on lowercase so this
        // works regardless of which path vitest's mock received.
        const headers = proxyCall?.headers ?? {};
        const lower: Record<string, string> = {};
        for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
        expect(lower.authorization).toBe("Bearer my-sdk-token");
        expect(lower["content-type"]).toBe("application/json");
    });
});

describe("interceptor — substitution", () => {
    it("URL template rewrites host and preserves path/search + %VAR% tokens", async () => {
        fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));

        activeClient = new Enkryptify(
            makeConfig({
                interceptor: {
                    rules: [
                        {
                            match: "https://api.example.com/",
                            url: "https://internal.example.com{path}{search}?key=%API_KEY%",
                            headers: { authorization: "Bearer %K%" },
                        },
                    ],
                },
            }),
        );
        await activeClient._interceptorReady();

        await fetch("https://api.example.com/v1/users?limit=10");

        const wire = await findProxyCall(fetchMock);
        expect(wire?.url).toBe("https://internal.example.com/v1/users?limit=10?key=%API_KEY%");
    });

    it("header override merges with intercepted headers (case-insensitive)", async () => {
        fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));

        activeClient = new Enkryptify(
            makeConfig({
                interceptor: {
                    rules: [{ match: "https://api.example.com/", headers: { Authorization: "Bearer %K%" } }],
                },
            }),
        );
        await activeClient._interceptorReady();

        await fetch("https://api.example.com/v1", {
            headers: { "X-Trace": "abc", authorization: "Bearer old" },
        });

        const wire = await findProxyCall(fetchMock);
        const headers = wire?.headers as Record<string, string>;
        expect(headers.authorization).toBe("Bearer %K%");
        expect(headers["x-trace"]).toBe("abc");
    });

    it("undefined header override deletes the header", async () => {
        fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));

        activeClient = new Enkryptify(
            makeConfig({
                interceptor: {
                    rules: [
                        {
                            match: "https://api.example.com/",
                            headers: { authorization: "Bearer %K%", "x-drop": undefined },
                        },
                    ],
                },
            }),
        );
        await activeClient._interceptorReady();

        await fetch("https://api.example.com/v1", {
            headers: { "X-Drop": "should-go-away", "X-Keep": "stays" },
        });

        const wire = await findProxyCall(fetchMock);
        const headers = wire?.headers as Record<string, string>;
        expect(headers["x-drop"]).toBeUndefined();
        expect(headers["x-keep"]).toBe("stays");
    });

    it("object body override replaces the intercepted body wholesale", async () => {
        fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));

        activeClient = new Enkryptify(
            makeConfig({
                interceptor: {
                    rules: [
                        {
                            match: "https://api.example.com/",
                            body: { overridden: true, token: "%T%" },
                        },
                    ],
                },
            }),
        );
        await activeClient._interceptorReady();

        await fetch("https://api.example.com/v1", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ original: true }),
        });

        const wire = await findProxyCall(fetchMock);
        expect(wire?.body).toEqual({ overridden: true, token: "%T%" });
    });

    it("function body override receives the intercepted body", async () => {
        fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
        const bodyOverride = vi.fn((input: unknown) => ({
            ...(input as object),
            injected: "%SECRET%",
        }));

        activeClient = new Enkryptify(
            makeConfig({
                interceptor: {
                    rules: [{ match: "https://api.example.com/", body: bodyOverride }],
                },
            }),
        );
        await activeClient._interceptorReady();

        await fetch("https://api.example.com/v1", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ keep: 1 }),
        });

        expect(bodyOverride).toHaveBeenCalledWith({ keep: 1 });
        const wire = await findProxyCall(fetchMock);
        expect(wire?.body).toEqual({ keep: 1, injected: "%SECRET%" });
    });

    it("intercepted JSON body is forwarded verbatim when no body override is set", async () => {
        fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));

        activeClient = new Enkryptify(
            makeConfig({
                interceptor: {
                    rules: [{ match: "https://api.example.com/", headers: { authorization: "Bearer %K%" } }],
                },
            }),
        );
        await activeClient._interceptorReady();

        await fetch("https://api.example.com/v1", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ query: "%SEARCH%", limit: 5 }),
        });

        const wire = await findProxyCall(fetchMock);
        expect(wire?.body).toEqual({ query: "%SEARCH%", limit: 5 });
    });
});

describe("interceptor — response passthrough", () => {
    it("returns the proxy's response body to the caller", async () => {
        const upstream = { data: [{ id: "1" }] };
        fetchMock.mockResolvedValue(
            new Response(JSON.stringify(upstream), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            }),
        );

        activeClient = new Enkryptify(
            makeConfig({
                interceptor: {
                    rules: [{ match: "https://api.example.com/", headers: { authorization: "Bearer %K%" } }],
                },
            }),
        );
        await activeClient._interceptorReady();

        const response = await fetch("https://api.example.com/v1");
        expect(response.ok).toBe(true);
        expect(await response.json()).toEqual(upstream);
    });

    it("non-2xx proxy response is returned as Response without throwing", async () => {
        fetchMock.mockResolvedValue(new Response("boom", { status: 500, statusText: "Internal Error" }));

        activeClient = new Enkryptify(
            makeConfig({
                interceptor: {
                    rules: [{ match: "https://api.example.com/", headers: { authorization: "Bearer %K%" } }],
                },
            }),
        );
        await activeClient._interceptorReady();

        const response = await fetch("https://api.example.com/v1");
        expect(response.ok).toBe(false);
        expect(response.status).toBe(500);
        expect(await response.text()).toBe("boom");
    });
});

describe("interceptor — unsupported bodies", () => {
    it("by default, passes a URLSearchParams body through without interception", async () => {
        fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));

        activeClient = new Enkryptify(
            makeConfig({
                logger: { level: "error" }, // silence the passthrough warning
                interceptor: {
                    rules: [{ match: "https://api.example.com/", headers: { authorization: "Bearer %K%" } }],
                },
            }),
        );
        await activeClient._interceptorReady();

        await fetch("https://api.example.com/v1", {
            method: "POST",
            body: new URLSearchParams({ k: "v" }),
        });

        // No proxy call should have happened.
        expect(await findProxyCall(fetchMock)).toBeNull();
    });

    it('fails the request when onUnsupportedBody: "error" and body is not JSON', async () => {
        fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));

        activeClient = new Enkryptify(
            makeConfig({
                interceptor: {
                    rules: [
                        {
                            match: "https://api.example.com/",
                            headers: { authorization: "Bearer %K%" },
                            onUnsupportedBody: "error",
                        },
                    ],
                },
            }),
        );
        await activeClient._interceptorReady();

        await expect(
            fetch("https://api.example.com/v1", {
                method: "POST",
                body: new URLSearchParams({ k: "v" }),
            }),
        ).rejects.toThrow(/not JSON-serialisable/);
    });
});

describe("interceptor — lifecycle", () => {
    it("destroy() disables interception; subsequent matched URLs hit the real target", async () => {
        fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));

        const client = new Enkryptify(
            makeConfig({
                interceptor: {
                    rules: [{ match: "https://api.example.com/", headers: { authorization: "Bearer %K%" } }],
                },
            }),
        );
        await client._interceptorReady();

        // Before destroy: routed through proxy.
        await fetch("https://api.example.com/v1");
        expect(await findProxyCall(fetchMock)).not.toBeNull();

        client.destroy();

        // After destroy: fresh mock to simplify assertion.
        fetchMock.mockClear();
        fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));

        await fetch("https://api.example.com/v1");

        // No proxy POST; only the direct call to api.example.com.
        expect(await findProxyCall(fetchMock)).toBeNull();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(String(fetchMock.mock.calls[0]?.[0])).toContain("api.example.com");
    });

    it("no interceptor is attached when rules array is empty", async () => {
        fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));

        activeClient = new Enkryptify(
            makeConfig({
                interceptor: { rules: [] },
            }),
        );
        await activeClient._interceptorReady();

        await fetch("https://api.example.com/v1");

        expect(await findProxyCall(fetchMock)).toBeNull();
    });

    it("no interceptor is attached when config.interceptor is omitted", async () => {
        fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));

        activeClient = new Enkryptify(makeConfig());
        await activeClient._interceptorReady();

        await fetch("https://api.example.com/v1");

        expect(await findProxyCall(fetchMock)).toBeNull();
    });

    it("enabled: false disables the interceptor even when rules are present", async () => {
        fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));

        activeClient = new Enkryptify(
            makeConfig({
                interceptor: {
                    enabled: false,
                    rules: [{ match: "https://api.example.com/", headers: { authorization: "Bearer %K%" } }],
                },
            }),
        );
        await activeClient._interceptorReady();

        await fetch("https://api.example.com/v1");
        expect(await findProxyCall(fetchMock)).toBeNull();
    });
});

describe("interceptor — errors", () => {
    it("surfaces a network error when the proxy fetch rejects", async () => {
        fetchMock.mockRejectedValue(new TypeError("ECONNREFUSED"));

        activeClient = new Enkryptify(
            makeConfig({
                interceptor: {
                    rules: [{ match: "https://api.example.com/", headers: { authorization: "Bearer %K%" } }],
                },
            }),
        );
        await activeClient._interceptorReady();

        await expect(fetch("https://api.example.com/v1")).rejects.toThrow();
    });

    it("passthrough when a rule matcher throws", async () => {
        fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));

        activeClient = new Enkryptify(
            makeConfig({
                interceptor: {
                    rules: [
                        {
                            name: "broken",
                            match: () => {
                                throw new Error("matcher boom");
                            },
                        },
                        {
                            name: "fallback",
                            match: "https://api.example.com/",
                            headers: { authorization: "Bearer %K%" },
                        },
                    ],
                },
            }),
        );
        await activeClient._interceptorReady();

        // The fallback rule should still match after the first rule's matcher throws.
        await fetch("https://api.example.com/v1");
        const wire = await findProxyCall(fetchMock);
        expect(wire).not.toBeNull();
    });
});
