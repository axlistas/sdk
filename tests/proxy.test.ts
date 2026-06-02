import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
    AuthenticationError,
    AuthorizationError,
    Enkryptify,
    EnkryptifyError,
    ProxyError,
    ProxyValidationError,
    RateLimitError,
} from "@/index";
import { storeToken } from "@/internal/token-store";
import type { EnkryptifyAuthProvider, EnkryptifyConfig } from "@/types";

function createAuth(token = "ek_test"): EnkryptifyAuthProvider {
    const auth = { _brand: "EnkryptifyAuthProvider" as const };
    storeToken(auth, token);
    return auth;
}

/**
 * Build the response shape the real Enkryptify proxy returns on success:
 * HTTP 200 wrapping the upstream status/headers/body in a JSON envelope.
 */
function envelope(body: unknown = {}, upstreamStatus = 200, upstreamHeaders: Record<string, string> = {}): Response {
    return new Response(JSON.stringify({ status: upstreamStatus, headers: upstreamHeaders, body }), {
        status: 200,
        headers: { "content-type": "application/json" },
    });
}

/** Default no-op proxy success response used by tests that only care about the wire body. */
function okEnvelope(): Response {
    return envelope({}, 200, {});
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

function getCallBody(call: unknown[]): Record<string, unknown> {
    const opts = call[1] as RequestInit;
    return JSON.parse(opts.body as string) as Record<string, unknown>;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("client.proxy.fetch — body translation", () => {
    it("GET without body sends correct wire body", async () => {
        fetchMock.mockResolvedValue(okEnvelope());
        const client = new Enkryptify(makeConfig());

        await client.proxy.fetch("https://upstream/x?k=%K%");

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const url = fetchMock.mock.calls[0]?.[0] as string;
        expect(url).toBe("https://proxy.test.com/ws-1/prj-1/env-1");
        const opts = fetchMock.mock.calls[0]?.[1] as RequestInit;
        expect(opts.method).toBe("POST");

        const body = getCallBody(fetchMock.mock.calls[0] as unknown[]);
        expect(body).toMatchObject({
            url: "https://upstream/x?k=%K%",
            method: "GET",
            "is-personal": true,
        });
        expect(body.body).toBeUndefined();
        expect(body.headers).toBeUndefined();
    });

    it("POST with JSON string body parses to object in wire body", async () => {
        fetchMock.mockResolvedValue(okEnvelope());
        const client = new Enkryptify(makeConfig());

        await client.proxy.fetch("https://upstream/x", {
            method: "POST",
            body: JSON.stringify({ user: "%USER%", count: 5 }),
        });

        const body = getCallBody(fetchMock.mock.calls[0] as unknown[]);
        expect(body.body).toEqual({ user: "%USER%", count: 5 });
    });

    it("POST with plain object body passes through", async () => {
        fetchMock.mockResolvedValue(okEnvelope());
        const client = new Enkryptify(makeConfig());

        // Cast needed because RequestInit.body doesn't include plain objects
        await client.proxy.fetch("https://upstream/x", {
            method: "POST",
            body: { user: "%USER%" } as unknown as BodyInit,
        });

        const body = getCallBody(fetchMock.mock.calls[0] as unknown[]);
        expect(body.body).toEqual({ user: "%USER%" });
    });

    it("rejects GET with body synchronously", async () => {
        const client = new Enkryptify(makeConfig());

        await expect(client.proxy.fetch("https://upstream/x", { method: "GET", body: '"x"' })).rejects.toThrow(
            "GET requests cannot include a body",
        );
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects HEAD with body synchronously", async () => {
        const client = new Enkryptify(makeConfig());

        await expect(client.proxy.fetch("https://upstream/x", { method: "HEAD", body: '"x"' })).rejects.toThrow(
            "HEAD requests cannot include a body",
        );
    });

    it("rejects Blob body", async () => {
        const client = new Enkryptify(makeConfig());
        const blob = new Blob(["hello"]);

        await expect(client.proxy.fetch("https://upstream/x", { method: "POST", body: blob })).rejects.toThrow(
            /JSON-compatible.*Blob/,
        );
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects FormData body", async () => {
        const client = new Enkryptify(makeConfig());
        const form = new FormData();
        form.append("key", "value");

        await expect(client.proxy.fetch("https://upstream/x", { method: "POST", body: form })).rejects.toThrow(
            /JSON-compatible.*FormData/,
        );
    });

    it("rejects URLSearchParams body", async () => {
        const client = new Enkryptify(makeConfig());
        const params = new URLSearchParams({ k: "v" });

        await expect(client.proxy.fetch("https://upstream/x", { method: "POST", body: params })).rejects.toThrow(
            /JSON-compatible.*URLSearchParams/,
        );
    });

    it("rejects non-JSON string body with helpful error", async () => {
        const client = new Enkryptify(makeConfig());

        await expect(
            client.proxy.fetch("https://upstream/x", { method: "POST", body: "not json at all" }),
        ).rejects.toThrow("Proxy body must be JSON-serializable");
    });

    it("rejects unsupported HTTP method", async () => {
        const client = new Enkryptify(makeConfig());

        await expect(client.proxy.fetch("https://upstream/x", { method: "TRACE" })).rejects.toThrow(
            /Unsupported HTTP method/,
        );
    });

    it("rejects Request input", async () => {
        const client = new Enkryptify(makeConfig());
        const req = new Request("https://upstream/x");

        await expect(client.proxy.fetch(req as unknown as string)).rejects.toThrow(/does not accept Request objects/);
    });

    it("coerces URL object input to string", async () => {
        fetchMock.mockResolvedValue(okEnvelope());
        const client = new Enkryptify(makeConfig());

        await client.proxy.fetch(new URL("https://upstream/x?a=1"));

        const body = getCallBody(fetchMock.mock.calls[0] as unknown[]);
        expect(body.url).toBe("https://upstream/x?a=1");
    });

    it("normalizes headers from Headers object", async () => {
        fetchMock.mockResolvedValue(okEnvelope());
        const client = new Enkryptify(makeConfig());

        await client.proxy.fetch("https://upstream/x", {
            method: "POST",
            headers: new Headers({ "X-Foo": "bar", Authorization: "Bearer %T%" }),
            body: "{}",
        });

        const body = getCallBody(fetchMock.mock.calls[0] as unknown[]);
        expect(body.headers).toMatchObject({
            "x-foo": "bar",
            authorization: "Bearer %T%",
        });
    });

    it("defaults method to GET when init omitted", async () => {
        fetchMock.mockResolvedValue(okEnvelope());
        const client = new Enkryptify(makeConfig());

        await client.proxy.fetch("https://upstream/x");

        const body = getCallBody(fetchMock.mock.calls[0] as unknown[]);
        expect(body.method).toBe("GET");
    });

    it("uppercases lowercase method", async () => {
        fetchMock.mockResolvedValue(okEnvelope());
        const client = new Enkryptify(makeConfig());

        await client.proxy.fetch("https://upstream/x", { method: "post", body: "{}" });

        const body = getCallBody(fetchMock.mock.calls[0] as unknown[]);
        expect(body.method).toBe("POST");
    });
});

describe("client.proxy.request — low-level API", () => {
    it("sends wire body and routes context in URL path", async () => {
        fetchMock.mockResolvedValue(okEnvelope());
        const client = new Enkryptify(makeConfig());

        await client.proxy.request({
            url: "https://upstream/x",
            method: "POST",
            body: { foo: "%BAR%" },
        });

        const body = getCallBody(fetchMock.mock.calls[0] as unknown[]);
        expect(body).toMatchObject({
            url: "https://upstream/x",
            method: "POST",
            body: { foo: "%BAR%" },
            "is-personal": true,
        });
        expect(fetchMock.mock.calls[0]?.[0]).toBe("https://proxy.test.com/ws-1/prj-1/env-1");
    });

    it("applies per-call environment override", async () => {
        fetchMock.mockResolvedValue(okEnvelope());
        const client = new Enkryptify(makeConfig());

        await client.proxy.request({
            url: "https://upstream/x",
            method: "GET",
            environment: "other-env",
        });

        expect(fetchMock.mock.calls[0]?.[0]).toBe("https://proxy.test.com/ws-1/prj-1/other-env");
    });

    it("applies per-call workspace/project/usePersonal overrides", async () => {
        fetchMock.mockResolvedValue(okEnvelope());
        const client = new Enkryptify(makeConfig());

        await client.proxy.request({
            url: "https://upstream/x",
            method: "GET",
            workspace: "other-ws",
            project: "other-prj",
            usePersonal: false,
        });

        const body = getCallBody(fetchMock.mock.calls[0] as unknown[]);
        expect(body["is-personal"]).toBe(false);
        expect(fetchMock.mock.calls[0]?.[0]).toBe("https://proxy.test.com/other-ws/other-prj/env-1");
    });

    it("rejects GET with body", async () => {
        const client = new Enkryptify(makeConfig());

        await expect(
            client.proxy.request({
                url: "https://upstream/x",
                method: "GET",
                body: { x: 1 },
            }),
        ).rejects.toThrow("GET requests cannot include a body");
    });

    it("rejects empty url", async () => {
        const client = new Enkryptify(makeConfig());

        await expect(client.proxy.request({ url: "", method: "GET" })).rejects.toThrow("non-empty `url`");
    });
});

describe("client.proxy — authorization", () => {
    it("sends Authorization: Bearer <token>", async () => {
        fetchMock.mockResolvedValue(okEnvelope());
        const client = new Enkryptify(makeConfig({ auth: createAuth("my-proxy-token") }));

        await client.proxy.fetch("https://upstream/x");

        const opts = fetchMock.mock.calls[0]?.[1] as RequestInit;
        expect(opts.headers).toMatchObject({
            Authorization: "Bearer my-proxy-token",
            "Content-Type": "application/json",
        });
    });

    it("uses exchanged JWT when useTokenExchange=true", async () => {
        fetchMock.mockImplementation((url: string) => {
            if (url.includes("/v1/auth/exchange")) {
                return Promise.resolve(
                    new Response(JSON.stringify({ accessToken: "jwt-abc", expiresIn: 900, tokenType: "Bearer" }), {
                        status: 200,
                    }),
                );
            }
            return Promise.resolve(okEnvelope());
        });

        const client = new Enkryptify(
            makeConfig({
                token: "ek_live_static",
                auth: undefined,
                useTokenExchange: true,
            }),
        );

        await client.proxy.fetch("https://upstream/x");

        // First call is the exchange
        const exchangeUrl = fetchMock.mock.calls[0]?.[0] as string;
        expect(exchangeUrl).toBe("https://api.test.com/v1/auth/exchange");

        // Second call is the proxy, with JWT
        const proxyOpts = fetchMock.mock.calls[1]?.[1] as RequestInit;
        expect(proxyOpts.headers).toMatchObject({ Authorization: "Bearer jwt-abc" });

        client.destroy();
    });
});

describe("client.proxy — envelope unwrap (upstream response)", () => {
    // The proxy returns `{ status, headers, body }` wrapped in an HTTP 200.
    // The SDK unwraps that envelope into a `Response` whose status/headers/body
    // mirror what the upstream API itself produced.

    it("returns the upstream body on 2xx and body is readable", async () => {
        const payload = { hello: "world" };
        fetchMock.mockResolvedValue(envelope(payload, 200, { "content-type": "application/json" }));
        const client = new Enkryptify(makeConfig());

        const res = await client.proxy.fetch("https://upstream/x");
        expect(res.ok).toBe(true);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual(payload);
    });

    it("preserves upstream status on 201/204/etc.", async () => {
        fetchMock.mockResolvedValue(envelope(null, 204, {}));
        const client = new Enkryptify(makeConfig());

        const res = await client.proxy.fetch("https://upstream/x", { method: "DELETE" });
        expect(res.status).toBe(204);
    });

    it("returns upstream 401 without throwing — distinguishes upstream auth from proxy auth", async () => {
        const body = { cod: 401, message: "Invalid API key" };
        fetchMock.mockResolvedValue(envelope(body, 401, { "content-type": "application/json" }));
        const client = new Enkryptify(makeConfig());

        const res = await client.proxy.fetch("https://upstream/x");
        expect(res.ok).toBe(false);
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual(body);
    });

    it.each([
        [400, { error: "bad" }],
        [403, "forbidden"],
        [404, { message: "not found" }],
        [500, "boom"],
        [502, "bad gateway"],
        [503, "down"],
    ])("returns upstream %i as Response without throwing", async (upstreamStatus, body) => {
        fetchMock.mockResolvedValue(envelope(body, upstreamStatus));
        const client = new Enkryptify(makeConfig());

        const res = await client.proxy.fetch("https://upstream/x");
        expect(res.ok).toBe(false);
        expect(res.status).toBe(upstreamStatus);
    });

    it("forwards upstream string body verbatim with explicit content-type", async () => {
        fetchMock.mockResolvedValue(envelope("<note>hi</note>", 200, { "content-type": "application/xml" }));
        const client = new Enkryptify(makeConfig());

        const res = await client.proxy.fetch("https://upstream/x");
        expect(res.headers.get("content-type")).toBe("application/xml");
        expect(await res.text()).toBe("<note>hi</note>");
    });

    it("preserves upstream Retry-After header on 429", async () => {
        fetchMock.mockResolvedValue(envelope("rate limited", 429, { "Retry-After": "42" }));
        const client = new Enkryptify(makeConfig());

        const res = await client.proxy.fetch("https://upstream/x");
        expect(res.status).toBe(429);
        expect(res.headers.get("Retry-After")).toBe("42");
    });

    it("strips hop-by-hop headers (content-length, transfer-encoding) from the synthesized Response", async () => {
        fetchMock.mockResolvedValue(
            envelope({ ok: true }, 200, {
                "content-length": "999",
                "transfer-encoding": "chunked",
                "x-custom": "keep",
            }),
        );
        const client = new Enkryptify(makeConfig());

        const res = await client.proxy.fetch("https://upstream/x");
        expect(res.headers.get("transfer-encoding")).toBeNull();
        expect(res.headers.get("content-length")).toBeNull();
        expect(res.headers.get("x-custom")).toBe("keep");
    });
});

describe("client.proxy — proxy-layer errors map to typed exceptions", () => {
    // Non-2xx from the proxy itself (auth failed, validation failed, missing
    // secret, rate limit, etc.) must NOT look like an upstream Response —
    // surface a typed error so callers can branch on the cause.

    function errorBody(message: string): Response {
        return new Response(JSON.stringify({ error: message }), {
            status: 401,
            headers: { "content-type": "application/json" },
        });
    }

    it("401 from the proxy throws AuthenticationError", async () => {
        fetchMock.mockResolvedValue(
            new Response(JSON.stringify({ error: "Invalid token" }), {
                status: 401,
                headers: { "content-type": "application/json" },
            }),
        );
        const client = new Enkryptify(makeConfig());

        await expect(client.proxy.fetch("https://upstream/x")).rejects.toBeInstanceOf(AuthenticationError);
    });

    it("403 from the proxy throws AuthorizationError", async () => {
        fetchMock.mockResolvedValue(
            new Response(JSON.stringify({ error: "Forbidden" }), {
                status: 403,
                headers: { "content-type": "application/json" },
            }),
        );
        const client = new Enkryptify(makeConfig());

        await expect(client.proxy.fetch("https://upstream/x")).rejects.toBeInstanceOf(AuthorizationError);
    });

    it("400 from the proxy throws ProxyValidationError with the proxy's detail", async () => {
        fetchMock.mockResolvedValue(
            new Response(JSON.stringify({ error: 'Secret "X" missing' }), {
                status: 400,
                headers: { "content-type": "application/json" },
            }),
        );
        const client = new Enkryptify(makeConfig());

        const err = (await client.proxy.fetch("https://upstream/x").catch((e) => e)) as ProxyValidationError;
        expect(err).toBeInstanceOf(ProxyValidationError);
        expect(err.detail).toBe('Secret "X" missing');
    });

    it("429 from the proxy throws RateLimitError with Retry-After", async () => {
        fetchMock.mockResolvedValue(
            new Response(JSON.stringify({ error: "Slow down" }), {
                status: 429,
                headers: { "content-type": "application/json", "Retry-After": "30" },
            }),
        );
        const client = new Enkryptify(makeConfig());

        const err = (await client.proxy.fetch("https://upstream/x").catch((e) => e)) as RateLimitError;
        expect(err).toBeInstanceOf(RateLimitError);
        expect(err.retryAfter).toBe(30);
    });

    it("5xx from the proxy throws ProxyError carrying status and detail", async () => {
        fetchMock.mockResolvedValue(
            new Response(JSON.stringify({ error: "down" }), {
                status: 502,
                headers: { "content-type": "application/json" },
            }),
        );
        const client = new Enkryptify(makeConfig());

        const err = (await client.proxy.fetch("https://upstream/x").catch((e) => e)) as ProxyError;
        expect(err).toBeInstanceOf(ProxyError);
        expect(err.status).toBe(502);
        expect(err.detail).toBe("down");
    });

    it("HTTP 200 with a non-envelope body throws ProxyError (proxy contract violation)", async () => {
        fetchMock.mockResolvedValue(new Response(JSON.stringify({ not: "an envelope" }), { status: 200 }));
        const client = new Enkryptify(makeConfig());

        await expect(client.proxy.fetch("https://upstream/x")).rejects.toBeInstanceOf(ProxyError);
    });

    // Reference unused helper to silence the linter (kept for future tests).
    void errorBody;
});

describe("client.proxy — URL resolution", () => {
    const originalEnv = process.env.ENKRYPTIFY_PROXY_URL;

    afterEach(() => {
        if (originalEnv !== undefined) {
            process.env.ENKRYPTIFY_PROXY_URL = originalEnv;
        } else {
            delete process.env.ENKRYPTIFY_PROXY_URL;
        }
    });

    it("config.proxy.url takes priority over env var", async () => {
        process.env.ENKRYPTIFY_PROXY_URL = "https://env.test.com";
        fetchMock.mockResolvedValue(okEnvelope());

        const client = new Enkryptify(makeConfig({ proxy: { url: "https://config.test.com" } }));
        await client.proxy.fetch("https://upstream/x");

        expect(fetchMock.mock.calls[0]?.[0]).toBe("https://config.test.com/ws-1/prj-1/env-1");
    });

    it("falls back to ENKRYPTIFY_PROXY_URL env var", async () => {
        process.env.ENKRYPTIFY_PROXY_URL = "https://env.test.com";
        fetchMock.mockResolvedValue(okEnvelope());

        const client = new Enkryptify(makeConfig({ proxy: undefined }));
        await client.proxy.fetch("https://upstream/x");

        expect(fetchMock.mock.calls[0]?.[0]).toBe("https://env.test.com/ws-1/prj-1/env-1");
    });

    it("falls back to default POC URL when nothing else is set", async () => {
        delete process.env.ENKRYPTIFY_PROXY_URL;
        fetchMock.mockResolvedValue(okEnvelope());

        const client = new Enkryptify(makeConfig({ proxy: undefined }));
        await client.proxy.fetch("https://upstream/x");

        expect(fetchMock.mock.calls[0]?.[0]).toBe("https://proxy.enkryptify.com/ws-1/prj-1/env-1");
    });
});

describe("client.proxy — lifecycle", () => {
    it("throws when parent is destroyed", async () => {
        const client = new Enkryptify(makeConfig());
        client.destroy();

        expect(() => client.proxy).toThrow(/destroyed/);
    });

    it("throws when destroyed between getting proxy and calling fetch", async () => {
        fetchMock.mockResolvedValue(okEnvelope());
        const client = new Enkryptify(makeConfig());
        const proxy = client.proxy;
        client.destroy();

        await expect(proxy.fetch("https://upstream/x")).rejects.toThrow(/destroyed/);
    });
});

describe("client.proxy — destructured fetch (axios/ky wiring)", () => {
    it("works when fetch is destructured from proxy", async () => {
        fetchMock.mockResolvedValue(okEnvelope());
        const client = new Enkryptify(makeConfig());

        const { fetch: proxyFetch } = client.proxy;
        await proxyFetch("https://upstream/x");

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const body = getCallBody(fetchMock.mock.calls[0] as unknown[]);
        expect(body.url).toBe("https://upstream/x");
    });
});

describe("proxyOnly mode", () => {
    it(".get() throws with pointer to proxy when proxyOnly=true", async () => {
        const client = new Enkryptify(makeConfig({ proxy: { url: "https://proxy.test.com", proxyOnly: true } }));

        await expect(client.get("ANY_KEY")).rejects.toThrow(/proxy-only/);
        await expect(client.get("ANY_KEY")).rejects.toThrow(/client\.proxy\.fetch/);
    });

    it(".preload() throws when proxyOnly=true", async () => {
        const client = new Enkryptify(makeConfig({ proxy: { url: "https://proxy.test.com", proxyOnly: true } }));

        await expect(client.preload()).rejects.toThrow(/proxy-only/);
    });

    it(".getFromCache() throws when proxyOnly=true", () => {
        const client = new Enkryptify(makeConfig({ proxy: { url: "https://proxy.test.com", proxyOnly: true } }));

        expect(() => client.getFromCache("X")).toThrow(/proxy-only/);
    });

    it(".proxy.fetch() still works when proxyOnly=true", async () => {
        fetchMock.mockResolvedValue(okEnvelope());
        const client = new Enkryptify(makeConfig({ proxy: { url: "https://proxy.test.com", proxyOnly: true } }));

        await client.proxy.fetch("https://upstream/x");
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("throws EnkryptifyError (not AuthenticationError) for clarity", async () => {
        const client = new Enkryptify(makeConfig({ proxy: { url: "https://proxy.test.com", proxyOnly: true } }));
        await expect(client.get("X")).rejects.toThrow(EnkryptifyError);
    });
});
