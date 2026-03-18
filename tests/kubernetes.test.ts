import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Enkryptify, KubernetesAuthError } from "@/index";
import { KubernetesAuthProvider } from "@/auth";
import { KubernetesExchangeManager } from "@/kubernetes-exchange";
import { Logger } from "@/logger";
import { retrieveToken } from "@/internal/token-store";
import type { Secret } from "@/types";

vi.mock("node:fs", () => ({
    readFileSync: vi.fn(),
}));

import { readFileSync } from "node:fs";

const readFileMock = vi.mocked(readFileSync);

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    readFileMock.mockReset();
});

afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.ENKRYPTIFY_TOKEN_PATH;
    delete process.env.ENKRYPTIFY_API_URL;
});

// --- KubernetesAuthProvider ---

describe("KubernetesAuthProvider", () => {
    it("uses ENKRYPTIFY_TOKEN_PATH env var with highest priority", () => {
        process.env.ENKRYPTIFY_TOKEN_PATH = "/custom/env/path";
        const provider = new KubernetesAuthProvider({ tokenPath: "/option/path" });
        expect(provider.tokenPath).toBe("/custom/env/path");
    });

    it("uses options.tokenPath when env var is not set", () => {
        const provider = new KubernetesAuthProvider({ tokenPath: "/option/path" });
        expect(provider.tokenPath).toBe("/option/path");
    });

    it("defaults to /var/run/secrets/tokens/token", () => {
        const provider = new KubernetesAuthProvider();
        expect(provider.tokenPath).toBe("/var/run/secrets/tokens/token");
    });

    it("has the _brand property", () => {
        const provider = new KubernetesAuthProvider();
        expect(provider._brand).toBe("EnkryptifyAuthProvider");
    });

    it("readToken() reads and trims file content", () => {
        readFileMock.mockReturnValue("  eyJhbGciOiJSUzI1NiJ9.payload.sig  \n");
        const provider = new KubernetesAuthProvider({ tokenPath: "/tokens/sa" });

        const token = provider.readToken();

        expect(token).toBe("eyJhbGciOiJSUzI1NiJ9.payload.sig");
        expect(readFileMock).toHaveBeenCalledWith("/tokens/sa", "utf-8");
    });

    it("readToken() throws KubernetesAuthError when file is missing", () => {
        readFileMock.mockImplementation(() => {
            throw new Error("ENOENT: no such file or directory");
        });
        const provider = new KubernetesAuthProvider({ tokenPath: "/missing" });

        expect(() => provider.readToken()).toThrow(KubernetesAuthError);
        expect(() => provider.readToken()).toThrow("Failed to read Kubernetes service account token");
    });

    it("readToken() throws KubernetesAuthError when file is empty", () => {
        readFileMock.mockReturnValue("   \n  ");
        const provider = new KubernetesAuthProvider();

        expect(() => provider.readToken()).toThrow(KubernetesAuthError);
        expect(() => provider.readToken()).toThrow("token file is empty");
    });
});

// --- KubernetesExchangeManager ---

describe("KubernetesExchangeManager", () => {
    function createAuth(tokenPath = "/tokens/sa"): KubernetesAuthProvider {
        return new KubernetesAuthProvider({ tokenPath });
    }

    function createManager(auth?: KubernetesAuthProvider): KubernetesExchangeManager {
        return new KubernetesExchangeManager(
            "https://api.test.com",
            auth ?? createAuth(),
            "ws-123",
            new Logger("error"),
        );
    }

    it("exchanges K8s token via POST /v1/auth/oidc/exchange", async () => {
        readFileMock.mockReturnValue("k8s-jwt-token");
        fetchMock.mockResolvedValue(
            new Response(JSON.stringify({ accessToken: "ek-jwt", expiresIn: 900, tokenType: "Bearer" }), {
                status: 200,
            }),
        );

        const manager = createManager();
        await manager.ensureToken();

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe("https://api.test.com/v1/auth/oidc/exchange");
        expect(opts.method).toBe("POST");
        expect(JSON.parse(opts.body as string)).toEqual({ token: "k8s-jwt-token", workspaceId: "ws-123" });

        manager.destroy();
    });

    it("stores exchanged JWT in token store", async () => {
        readFileMock.mockReturnValue("k8s-jwt-token");
        fetchMock.mockResolvedValue(
            new Response(JSON.stringify({ accessToken: "ek-jwt", expiresIn: 900, tokenType: "Bearer" }), {
                status: 200,
            }),
        );

        const auth = createAuth();
        const manager = new KubernetesExchangeManager("https://api.test.com", auth, "ws-123", new Logger("error"));
        await manager.ensureToken();

        expect(retrieveToken(auth)).toBe("ek-jwt");
        manager.destroy();
    });

    it("deduplicates concurrent ensureToken() calls", async () => {
        readFileMock.mockReturnValue("k8s-jwt-token");
        fetchMock.mockResolvedValue(
            new Response(JSON.stringify({ accessToken: "ek-jwt", expiresIn: 900, tokenType: "Bearer" }), {
                status: 200,
            }),
        );

        const manager = createManager();
        await Promise.all([manager.ensureToken(), manager.ensureToken(), manager.ensureToken()]);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        manager.destroy();
    });

    it("throws KubernetesAuthError on exchange failure (no fallback)", async () => {
        readFileMock.mockReturnValue("k8s-jwt-token");
        fetchMock.mockResolvedValue(new Response("Unauthorized", { status: 401 }));

        const manager = createManager();
        await expect(manager.ensureToken()).rejects.toThrow(KubernetesAuthError);
        await expect(manager.ensureToken()).rejects.toThrow("OIDC token exchange failed with HTTP 401");

        manager.destroy();
    });

    it("re-reads K8s token file on each exchange", async () => {
        readFileMock.mockReturnValueOnce("first-token").mockReturnValueOnce("second-token");
        fetchMock.mockImplementation(() =>
            Promise.resolve(
                new Response(JSON.stringify({ accessToken: "ek-jwt", expiresIn: 900, tokenType: "Bearer" }), {
                    status: 200,
                }),
            ),
        );

        const manager = createManager();

        // First exchange
        await manager.ensureToken();
        expect(readFileMock).toHaveBeenCalledTimes(1);

        // Force re-exchange by destroying and creating new manager
        manager.destroy();

        const manager2 = createManager();
        await manager2.ensureToken();
        expect(readFileMock).toHaveBeenCalledTimes(2);

        manager2.destroy();
    });
});

// --- Enkryptify.fromKubernetes() integration ---

function makeSecret(name: string, value: string, envId: string): Secret {
    return {
        id: `id-${name}`,
        name,
        note: "",
        type: "string",
        dataType: "text",
        values: [{ environmentId: envId, value, isPersonal: false }],
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
    };
}

describe("Enkryptify.fromKubernetes()", () => {
    it("returns a KubernetesAuthProvider", () => {
        const auth = Enkryptify.fromKubernetes({ tokenPath: "/tokens/sa" });
        expect(auth).toBeInstanceOf(KubernetesAuthProvider);
        expect(auth._brand).toBe("EnkryptifyAuthProvider");
    });

    it("auto-enables OIDC exchange and exchanges before first API call", async () => {
        readFileMock.mockReturnValue("k8s-jwt");
        const exchangeResponse = { accessToken: "ek-jwt-123", expiresIn: 900, tokenType: "Bearer" };
        const secrets = [makeSecret("DB_URL", "postgres://...", "env-1")];

        fetchMock.mockImplementation((url: string) => {
            if (url.includes("/v1/auth/oidc/exchange")) {
                return Promise.resolve(new Response(JSON.stringify(exchangeResponse), { status: 200 }));
            }
            return Promise.resolve(new Response(JSON.stringify(secrets), { status: 200 }));
        });

        const client = new Enkryptify({
            auth: Enkryptify.fromKubernetes({ tokenPath: "/tokens/sa" }),
            workspace: "ws-1",
            project: "prj-1",
            environment: "env-1",
            baseUrl: "https://api.test.com",
            logger: { level: "error" },
        });

        const value = await client.get("DB_URL");

        expect(value).toBe("postgres://...");
        // First call = OIDC exchange, second call = secrets API
        expect(fetchMock).toHaveBeenCalledTimes(2);
        const exchangeUrl = fetchMock.mock.calls[0]?.[0] as string;
        expect(exchangeUrl).toBe("https://api.test.com/v1/auth/oidc/exchange");

        // Secrets call should use the exchanged JWT
        const secretOpts = fetchMock.mock.calls[1]?.[1] as RequestInit;
        expect(secretOpts.headers).toHaveProperty("Authorization", "Bearer ek-jwt-123");

        client.destroy();
    });

    it("propagates exchange errors", async () => {
        readFileMock.mockReturnValue("k8s-jwt");
        fetchMock.mockResolvedValue(new Response("Forbidden", { status: 403 }));

        const client = new Enkryptify({
            auth: Enkryptify.fromKubernetes({ tokenPath: "/tokens/sa" }),
            workspace: "ws-1",
            project: "prj-1",
            environment: "env-1",
            baseUrl: "https://api.test.com",
            logger: { level: "error" },
        });

        await expect(client.get("KEY")).rejects.toThrow(KubernetesAuthError);
        client.destroy();
    });

    it("propagates token file read errors", async () => {
        readFileMock.mockImplementation(() => {
            throw new Error("ENOENT: no such file or directory");
        });

        const client = new Enkryptify({
            auth: Enkryptify.fromKubernetes({ tokenPath: "/tokens/sa" }),
            workspace: "ws-1",
            project: "prj-1",
            environment: "env-1",
            baseUrl: "https://api.test.com",
            logger: { level: "error" },
        });

        await expect(client.get("KEY")).rejects.toThrow(KubernetesAuthError);
        client.destroy();
    });

    it("uses ENKRYPTIFY_API_URL env var for baseUrl", async () => {
        process.env.ENKRYPTIFY_API_URL = "https://custom-api.test.com";
        readFileMock.mockReturnValue("k8s-jwt");
        fetchMock.mockResolvedValue(
            new Response(JSON.stringify({ accessToken: "jwt", expiresIn: 900, tokenType: "Bearer" }), { status: 200 }),
        );

        const client = new Enkryptify({
            auth: Enkryptify.fromKubernetes({ tokenPath: "/tokens/sa" }),
            workspace: "ws-1",
            project: "prj-1",
            environment: "env-1",
            logger: { level: "error" },
        });

        // Trigger exchange
        try {
            await client.get("KEY");
        } catch {
            // may fail on secrets fetch, that's fine
        }

        const exchangeUrl = fetchMock.mock.calls[0]?.[0] as string;
        expect(exchangeUrl).toBe("https://custom-api.test.com/v1/auth/oidc/exchange");

        client.destroy();
    });
});
