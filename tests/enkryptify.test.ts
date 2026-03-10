import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Enkryptify, EnkryptifyError, SecretNotFoundError } from "@/index";
import { storeToken } from "@/internal/token-store";
import type { EnkryptifyAuthProvider, EnkryptifyConfig, Secret } from "@/types";

function createAuth(token = "ek_test"): EnkryptifyAuthProvider {
    const auth = { _brand: "EnkryptifyAuthProvider" as const };
    storeToken(auth, token);
    return auth;
}

function makeSecret(name: string, value: string, envId: string, isPersonal = false): Secret {
    return {
        id: `id-${name}`,
        name,
        note: "",
        type: "string",
        dataType: "text",
        values: [{ environmentId: envId, value, isPersonal }],
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
    };
}

function makeConfig(overrides?: Partial<EnkryptifyConfig>): EnkryptifyConfig {
    return {
        auth: createAuth(),
        workspace: "ws-1",
        project: "prj-1",
        environment: "env-1",
        baseUrl: "https://api.test.com",
        logger: { level: "error" },
        ...overrides,
    };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("Enkryptify — config validation", () => {
    it("throws on missing workspace", () => {
        expect(() => new Enkryptify(makeConfig({ workspace: "" }))).toThrow(
            'Missing required config field "workspace"',
        );
    });

    it("throws on missing project", () => {
        expect(() => new Enkryptify(makeConfig({ project: "" }))).toThrow('Missing required config field "project"');
    });

    it("throws on missing environment", () => {
        expect(() => new Enkryptify(makeConfig({ environment: "" }))).toThrow(
            'Missing required config field "environment"',
        );
    });

    it("throws when no token or auth provided", () => {
        delete process.env.ENKRYPTIFY_TOKEN;
        expect(() => new Enkryptify({ ...makeConfig(), auth: undefined as unknown as EnkryptifyAuthProvider })).toThrow(
            "No token provided",
        );
    });
});

describe("Enkryptify — token resolution", () => {
    const originalEnv = process.env.ENKRYPTIFY_TOKEN;

    afterEach(() => {
        if (originalEnv !== undefined) {
            process.env.ENKRYPTIFY_TOKEN = originalEnv;
        } else {
            delete process.env.ENKRYPTIFY_TOKEN;
        }
    });

    it("accepts token option (ek_live_ format)", () => {
        const client = new Enkryptify({
            token: "ek_live_abc123",
            workspace: "ws-1",
            project: "prj-1",
            environment: "env-1",
            baseUrl: "https://api.test.com",
            logger: { level: "error" },
        });
        expect(client).toBeInstanceOf(Enkryptify);
        client.destroy();
    });

    it("accepts token option (JWT format)", () => {
        const client = new Enkryptify({
            token: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig",
            workspace: "ws-1",
            project: "prj-1",
            environment: "env-1",
            baseUrl: "https://api.test.com",
            logger: { level: "error" },
        });
        expect(client).toBeInstanceOf(Enkryptify);
        client.destroy();
    });

    it("rejects invalid token format", () => {
        expect(
            () =>
                new Enkryptify({
                    token: "not-a-valid-token",
                    workspace: "ws-1",
                    project: "prj-1",
                    environment: "env-1",
                    logger: { level: "error" },
                }),
        ).toThrow("Invalid token format");
    });

    it("falls back to ENKRYPTIFY_TOKEN env var", () => {
        process.env.ENKRYPTIFY_TOKEN = "ek_live_from_env";
        const client = new Enkryptify({
            workspace: "ws-1",
            project: "prj-1",
            environment: "env-1",
            baseUrl: "https://api.test.com",
            logger: { level: "error" },
        });
        expect(client).toBeInstanceOf(Enkryptify);
        client.destroy();
    });

    it("token option takes priority over auth option", async () => {
        const secrets = [makeSecret("KEY", "val", "env-1")];
        fetchMock.mockResolvedValue(new Response(JSON.stringify(secrets), { status: 200 }));

        const client = new Enkryptify({
            token: "ek_live_priority",
            auth: createAuth("ek_live_fallback"),
            workspace: "ws-1",
            project: "prj-1",
            environment: "env-1",
            baseUrl: "https://api.test.com",
            logger: { level: "error" },
        });
        await client.get("KEY");

        const opts = fetchMock.mock.calls[0]?.[1] as RequestInit;
        expect(opts.headers).toHaveProperty("Authorization", "Bearer ek_live_priority");
        client.destroy();
    });

    it("throws when no token source available", () => {
        delete process.env.ENKRYPTIFY_TOKEN;
        expect(
            () =>
                new Enkryptify({
                    workspace: "ws-1",
                    project: "prj-1",
                    environment: "env-1",
                    logger: { level: "error" },
                }),
        ).toThrow("No token provided");
    });
});

describe("Enkryptify.fromEnv()", () => {
    it("returns valid auth provider when env var is set", () => {
        process.env.ENKRYPTIFY_TOKEN = "ek_test";
        const auth = Enkryptify.fromEnv();
        expect(auth._brand).toBe("EnkryptifyAuthProvider");
        delete process.env.ENKRYPTIFY_TOKEN;
    });
});

describe("Enkryptify.get()", () => {
    it("fetches single secret from API and returns value", async () => {
        const secret = makeSecret("DB_HOST", "localhost", "env-1");
        fetchMock.mockResolvedValue(new Response(JSON.stringify(secret), { status: 200 }));

        const client = new Enkryptify(makeConfig({ cache: { enabled: false } }));
        const value = await client.get("DB_HOST");
        expect(value).toBe("localhost");
    });

    it("second call hits cache (fetch called only once)", async () => {
        const secrets = [makeSecret("DB_HOST", "localhost", "env-1")];
        fetchMock.mockResolvedValue(new Response(JSON.stringify(secrets), { status: 200 }));

        const client = new Enkryptify(makeConfig());
        const v1 = await client.get("DB_HOST");
        const v2 = await client.get("DB_HOST");

        expect(v1).toBe("localhost");
        expect(v2).toBe("localhost");
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("bypasses cache with { cache: false }", async () => {
        const secret = makeSecret("DB_HOST", "localhost", "env-1");
        fetchMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify(secret), { status: 200 })));

        const client = new Enkryptify(makeConfig({ cache: { enabled: true, eager: false } }));
        await client.get("DB_HOST");
        await client.get("DB_HOST", { cache: false });

        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("strict mode throws SecretNotFoundError for unknown key", async () => {
        fetchMock.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));

        const client = new Enkryptify(makeConfig({ options: { strict: true } }));
        await expect(client.get("NONEXISTENT")).rejects.toThrow(SecretNotFoundError);
    });

    it("non-strict mode returns empty string for unknown key", async () => {
        fetchMock.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));

        const client = new Enkryptify(makeConfig({ options: { strict: false } }));
        const value = await client.get("NONEXISTENT");
        expect(value).toBe("");
    });

    it("eager mode fetches ALL secrets on first call", async () => {
        const secrets = [makeSecret("KEY_A", "a", "env-1"), makeSecret("KEY_B", "b", "env-1")];
        fetchMock.mockResolvedValue(new Response(JSON.stringify(secrets), { status: 200 }));

        const client = new Enkryptify(makeConfig({ cache: { enabled: true, eager: true } }));
        const value = await client.get("KEY_A");

        expect(value).toBe("a");
        // Should have called the all-secrets endpoint
        const url = fetchMock.mock.calls[0]?.[0] as string;
        expect(url).not.toContain("/secret/KEY_A");
        expect(url).toMatch(/\/secret\?/);
    });

    it("eager=false fetches only the requested single secret", async () => {
        const secret = makeSecret("KEY_A", "a", "env-1");
        fetchMock.mockResolvedValue(new Response(JSON.stringify(secret), { status: 200 }));

        const client = new Enkryptify(makeConfig({ cache: { enabled: true, eager: false } }));
        await client.get("KEY_A");

        const url = fetchMock.mock.calls[0]?.[0] as string;
        expect(url).toContain("/secret/KEY_A");
    });
});

describe("Enkryptify.getFromCache()", () => {
    it("returns cached value after preload()", async () => {
        const secrets = [makeSecret("KEY_A", "val_a", "env-1")];
        fetchMock.mockResolvedValue(new Response(JSON.stringify(secrets), { status: 200 }));

        const client = new Enkryptify(makeConfig());
        await client.preload();

        expect(client.getFromCache("KEY_A")).toBe("val_a");
    });

    it("throws when key is not cached", () => {
        const client = new Enkryptify(makeConfig());
        expect(() => client.getFromCache("MISSING")).toThrow(SecretNotFoundError);
    });

    it("throws when cache is disabled", () => {
        const client = new Enkryptify(makeConfig({ cache: { enabled: false } }));
        expect(() => client.getFromCache("KEY")).toThrow(EnkryptifyError);
        expect(() => client.getFromCache("KEY")).toThrow("Cache is disabled");
    });
});

describe("Enkryptify.preload()", () => {
    it("populates cache, subsequent getFromCache() works", async () => {
        const secrets = [makeSecret("A", "1", "env-1"), makeSecret("B", "2", "env-1")];
        fetchMock.mockResolvedValue(new Response(JSON.stringify(secrets), { status: 200 }));

        const client = new Enkryptify(makeConfig());
        await client.preload();

        expect(client.getFromCache("A")).toBe("1");
        expect(client.getFromCache("B")).toBe("2");
    });

    it("throws when cache is disabled", async () => {
        const client = new Enkryptify(makeConfig({ cache: { enabled: false } }));
        await expect(client.preload()).rejects.toThrow("Cannot preload: caching is disabled");
    });
});

describe("Enkryptify — personal value resolution", () => {
    it("prefers personal value when usePersonalValues=true", async () => {
        const secret: Secret = {
            id: "1",
            name: "KEY",
            note: "",
            type: "string",
            dataType: "text",
            values: [
                { environmentId: "env-1", value: "shared-val", isPersonal: false },
                { environmentId: "env-1", value: "personal-val", isPersonal: true },
            ],
            createdAt: "",
            updatedAt: "",
        };
        fetchMock.mockResolvedValue(new Response(JSON.stringify([secret]), { status: 200 }));

        const client = new Enkryptify(makeConfig({ options: { usePersonalValues: true } }));
        const value = await client.get("KEY");
        expect(value).toBe("personal-val");
    });

    it("falls back to shared when no personal value exists", async () => {
        const secret: Secret = {
            id: "1",
            name: "KEY",
            note: "",
            type: "string",
            dataType: "text",
            values: [{ environmentId: "env-1", value: "shared-val", isPersonal: false }],
            createdAt: "",
            updatedAt: "",
        };
        fetchMock.mockResolvedValue(new Response(JSON.stringify([secret]), { status: 200 }));

        const client = new Enkryptify(makeConfig({ options: { usePersonalValues: true } }));
        const value = await client.get("KEY");
        expect(value).toBe("shared-val");
    });

    it("uses shared value when usePersonalValues=false", async () => {
        const secret: Secret = {
            id: "1",
            name: "KEY",
            note: "",
            type: "string",
            dataType: "text",
            values: [
                { environmentId: "env-1", value: "shared-val", isPersonal: false },
                { environmentId: "env-1", value: "personal-val", isPersonal: true },
            ],
            createdAt: "",
            updatedAt: "",
        };
        fetchMock.mockResolvedValue(new Response(JSON.stringify([secret]), { status: 200 }));

        const client = new Enkryptify(makeConfig({ options: { usePersonalValues: false } }));
        const value = await client.get("KEY");
        expect(value).toBe("shared-val");
    });
});

describe("Enkryptify — token exchange", () => {
    it("exchanges token before first API call when useTokenExchange=true", async () => {
        const exchangeResponse = { accessToken: "jwt-token", expiresIn: 900, tokenType: "Bearer" };
        const secrets = [makeSecret("KEY", "val", "env-1")];

        fetchMock.mockImplementation((url: string) => {
            if (url.includes("/v1/auth/exchange")) {
                return Promise.resolve(new Response(JSON.stringify(exchangeResponse), { status: 200 }));
            }
            return Promise.resolve(new Response(JSON.stringify(secrets), { status: 200 }));
        });

        const client = new Enkryptify({
            token: "ek_live_static",
            workspace: "ws-1",
            project: "prj-1",
            environment: "env-1",
            baseUrl: "https://api.test.com",
            useTokenExchange: true,
            logger: { level: "error" },
        });

        await client.get("KEY");

        // First call should be the exchange
        const exchangeUrl = fetchMock.mock.calls[0]?.[0] as string;
        expect(exchangeUrl).toBe("https://api.test.com/v1/auth/exchange");
        const exchangeOpts = fetchMock.mock.calls[0]?.[1] as RequestInit;
        expect(exchangeOpts.headers).toHaveProperty("Authorization", "Bearer ek_live_static");

        // Second call should use the JWT
        const secretOpts = fetchMock.mock.calls[1]?.[1] as RequestInit;
        expect(secretOpts.headers).toHaveProperty("Authorization", "Bearer jwt-token");

        client.destroy();
    });

    it("falls back to static token if exchange fails", async () => {
        const secrets = [makeSecret("KEY", "val", "env-1")];

        fetchMock.mockImplementation((url: string) => {
            if (url.includes("/v1/auth/exchange")) {
                return Promise.resolve(new Response("Server Error", { status: 500 }));
            }
            return Promise.resolve(new Response(JSON.stringify(secrets), { status: 200 }));
        });

        const client = new Enkryptify({
            token: "ek_live_static",
            workspace: "ws-1",
            project: "prj-1",
            environment: "env-1",
            baseUrl: "https://api.test.com",
            useTokenExchange: true,
            logger: { level: "error" },
        });

        const value = await client.get("KEY");
        expect(value).toBe("val");

        // Secret request should use static token as fallback
        const secretOpts = fetchMock.mock.calls[1]?.[1] as RequestInit;
        expect(secretOpts.headers).toHaveProperty("Authorization", "Bearer ek_live_static");

        client.destroy();
    });

    it("does not exchange when useTokenExchange is false", async () => {
        const secrets = [makeSecret("KEY", "val", "env-1")];
        fetchMock.mockResolvedValue(new Response(JSON.stringify(secrets), { status: 200 }));

        const client = new Enkryptify({
            token: "ek_live_static",
            workspace: "ws-1",
            project: "prj-1",
            environment: "env-1",
            baseUrl: "https://api.test.com",
            logger: { level: "error" },
        });

        await client.get("KEY");

        // Only one call, no exchange
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const url = fetchMock.mock.calls[0]?.[0] as string;
        expect(url).not.toContain("/v1/auth/exchange");

        client.destroy();
    });
});

describe("Enkryptify.destroy()", () => {
    it("clears cache and subsequent calls throw", async () => {
        const secrets = [makeSecret("KEY", "val", "env-1")];
        fetchMock.mockResolvedValue(new Response(JSON.stringify(secrets), { status: 200 }));

        const client = new Enkryptify(makeConfig());
        await client.preload();
        client.destroy();

        expect(() => client.getFromCache("KEY")).toThrow("destroyed");
        await expect(client.get("KEY")).rejects.toThrow("destroyed");
        await expect(client.preload()).rejects.toThrow("destroyed");
    });

    it("double-destroy does not error", () => {
        const client = new Enkryptify(makeConfig());
        client.destroy();
        expect(() => client.destroy()).not.toThrow();
    });
});
