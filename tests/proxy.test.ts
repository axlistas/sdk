import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Enkryptify, EnkryptifyError } from "@/index";
import { storeToken } from "@/internal/token-store";
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
        fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
        const client = new Enkryptify(makeConfig());

        await client.proxy.fetch("https://upstream/x?k=%K%");

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const url = fetchMock.mock.calls[0]?.[0] as string;
        expect(url).toBe("https://proxy.test.com/v1/proxy/ws-1/prj-1/env-1");
        const opts = fetchMock.mock.calls[0]?.[1] as RequestInit;
        expect(opts.method).toBe("POST");

        const body = getCallBody(fetchMock.mock.calls[0] as unknown[]);
        expect(body).toMatchObject({
            url: "https://upstream/x?k=%K%",
            method: "GET",
        });
        expect(body.body).toBeUndefined();
        expect(body.headers).toBeUndefined();
    });

    it("POST with JSON string body parses to object in wire body", async () => {
        fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
        const client = new Enkryptify(makeConfig());

        await client.proxy.fetch("https://upstream/x", {
            method: "POST",
            body: JSON.stringify({ user: "%USER%", count: 5 }),
        });

        const body = getCallBody(fetchMock.mock.calls[0] as unknown[]);
        expect(body.body).toEqual({ user: "%USER%", count: 5 });
    });

    it("POST with plain object body passes through", async () => {
        fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
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
        fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
        const client = new Enkryptify(makeConfig());

        await client.proxy.fetch(new URL("https://upstream/x?a=1"));

        const body = getCallBody(fetchMock.mock.calls[0] as unknown[]);
        expect(body.url).toBe("https://upstream/x?a=1");
    });

    it("normalizes headers from Headers object", async () => {
        fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
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
        fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
        const client = new Enkryptify(makeConfig());

        await client.proxy.fetch("https://upstream/x");

        const body = getCallBody(fetchMock.mock.calls[0] as unknown[]);
        expect(body.method).toBe("GET");
    });

    it("uppercases lowercase method", async () => {
        fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
        const client = new Enkryptify(makeConfig());

        await client.proxy.fetch("https://upstream/x", { method: "post", body: "{}" });

        const body = getCallBody(fetchMock.mock.calls[0] as unknown[]);
        expect(body.method).toBe("POST");
    });
});

describe("client.proxy.request — low-level API", () => {
    it("sends wire body and routes context in URL path", async () => {
        fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
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
        });
        expect(fetchMock.mock.calls[0]?.[0]).toBe("https://proxy.test.com/ws-1/prj-1/env-1");
    });

    it("applies per-call environment override", async () => {
        fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
        const client = new Enkryptify(makeConfig());

        await client.proxy.request({
            url: "https://upstream/x",
            method: "GET",
            environment: "other-env",
        });

        expect(fetchMock.mock.calls[0]?.[0]).toBe("https://proxy.test.com/ws-1/prj-1/other-env");
    });

    it("applies per-call workspace/project overrides", async () => {
        fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
        const client = new Enkryptify(makeConfig());

        await client.proxy.request({
            url: "https://upstream/x",
            method: "GET",
            workspace: "other-ws",
            project: "other-prj",
        });

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
        fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
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
            return Promise.resolve(new Response("{}", { status: 200 }));
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

describe("client.proxy — response passthrough", () => {
    // client.proxy.fetch is a fetch-style API: it returns whatever the Proxy returned
    // (which for success is the upstream's verbatim Response, and for proxy-layer
    // errors is a `{error: {code, message}}` JSON envelope). No status-based throwing —
    // that produced wrong errors when the upstream itself returned 401/403/etc.

    it("returns the upstream Response on 2xx and body is readable", async () => {
        const payload = { hello: "world" };
        fetchMock.mockResolvedValue(
            new Response(JSON.stringify(payload), {
                status: 200,
                headers: new Headers({ "Content-Type": "application/json" }),
            }),
        );
        const client = new Enkryptify(makeConfig());

        const res = await client.proxy.fetch("https://upstream/x");
        expect(res.ok).toBe(true);
        const json = await res.json();
        expect(json).toEqual(payload);
    });

    it("preserves upstream status code on 201/204/etc.", async () => {
        fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
        const client = new Enkryptify(makeConfig());

        const res = await client.proxy.fetch("https://upstream/x", { method: "DELETE" });
        expect(res.status).toBe(204);
    });

    it("returns upstream 401 as Response without throwing (critical: distinguish upstream auth from proxy auth)", async () => {
        const body = { cod: 401, message: "Invalid API key" };
        fetchMock.mockResolvedValue(
            new Response(JSON.stringify(body), {
                status: 401,
                headers: new Headers({ "Content-Type": "application/json" }),
            }),
        );
        const client = new Enkryptify(makeConfig());

        const res = await client.proxy.fetch("https://upstream/x");
        expect(res.ok).toBe(false);
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual(body);
    });

    it.each([
        [400, "Bad Request"],
        [403, "Forbidden"],
        [404, "Not Found"],
        [429, "Too Many Requests"],
        [500, "Internal Server Error"],
        [502, "Bad Gateway"],
        [503, "Service Unavailable"],
    ])("returns upstream %i as Response without throwing", async (status, statusText) => {
        fetchMock.mockResolvedValue(new Response(statusText, { status, statusText }));
        const client = new Enkryptify(makeConfig());

        const res = await client.proxy.fetch("https://upstream/x");
        expect(res.ok).toBe(false);
        expect(res.status).toBe(status);
        expect(await res.text()).toBe(statusText);
    });

    it("returns proxy-layer error envelope as Response (caller reads body.error.code)", async () => {
        // Simulates the Proxy's own error response for missing_authorization /
        // secrets_unauthorized / invalid_request / etc. — same JSON shape the
        // Proxy produces today.
        const body = { error: { code: "secrets_unauthorized", message: "Unauthorized to load secrets" } };
        fetchMock.mockResolvedValue(
            new Response(JSON.stringify(body), {
                status: 401,
                headers: new Headers({ "Content-Type": "application/json" }),
            }),
        );
        const client = new Enkryptify(makeConfig());

        const res = await client.proxy.fetch("https://upstream/x");
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual(body);
    });

    it("preserves upstream Retry-After header on 429 passthrough", async () => {
        fetchMock.mockResolvedValue(
            new Response("rate limited", { status: 429, headers: new Headers({ "Retry-After": "42" }) }),
        );
        const client = new Enkryptify(makeConfig());

        const res = await client.proxy.fetch("https://upstream/x");
        expect(res.status).toBe(429);
        expect(res.headers.get("Retry-After")).toBe("42");
    });
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
        fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));

        const client = new Enkryptify(makeConfig({ proxy: { url: "https://config.test.com" } }));
        await client.proxy.fetch("https://upstream/x");

        expect(fetchMock.mock.calls[0]?.[0]).toBe("https://config.test.com/ws-1/prj-1/env-1");
    });

    it("falls back to ENKRYPTIFY_PROXY_URL env var", async () => {
        process.env.ENKRYPTIFY_PROXY_URL = "https://env.test.com";
        fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));

        const client = new Enkryptify(makeConfig({ proxy: undefined }));
        await client.proxy.fetch("https://upstream/x");

        expect(fetchMock.mock.calls[0]?.[0]).toBe("https://env.test.com/ws-1/prj-1/env-1");
    });

    it("falls back to default POC URL when nothing else is set", async () => {
        delete process.env.ENKRYPTIFY_PROXY_URL;
        fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));

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
        fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
        const client = new Enkryptify(makeConfig());
        const proxy = client.proxy;
        client.destroy();

        await expect(proxy.fetch("https://upstream/x")).rejects.toThrow(/destroyed/);
    });
});

describe("client.proxy — destructured fetch (axios/ky wiring)", () => {
    it("works when fetch is destructured from proxy", async () => {
        fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
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
        fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
        const client = new Enkryptify(makeConfig({ proxy: { url: "https://proxy.test.com", proxyOnly: true } }));

        await client.proxy.fetch("https://upstream/x");
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("throws EnkryptifyError (not AuthenticationError) for clarity", async () => {
        const client = new Enkryptify(makeConfig({ proxy: { url: "https://proxy.test.com", proxyOnly: true } }));
        await expect(client.get("X")).rejects.toThrow(EnkryptifyError);
    });
});
