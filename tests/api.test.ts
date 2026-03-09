import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EnkryptifyApi } from "@/api";
import { AuthenticationError, AuthorizationError, NotFoundError, RateLimitError, ApiError } from "@/errors";
import { storeToken } from "@/internal/token-store";
import type { EnkryptifyAuthProvider } from "@/types";

function createAuth(token: string): EnkryptifyAuthProvider {
    const auth = { _brand: "EnkryptifyAuthProvider" as const };
    storeToken(auth, token);
    return auth;
}

describe("EnkryptifyApi", () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("fetchSecret() constructs correct URL", async () => {
        fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: "1", name: "KEY" }), { status: 200 }));
        const api = new EnkryptifyApi("https://api.example.com", createAuth("tok"));

        await api.fetchSecret("ws-1", "prj-1", "MY_SECRET", "env-1");

        const url = fetchMock.mock.calls[0]?.[0] as string;
        expect(url).toBe(
            "https://api.example.com/v1/workspace/ws-1/project/prj-1/secret/MY_SECRET?environmentId=env-1&resolve=true",
        );
    });

    it("fetchAllSecrets() constructs correct URL", async () => {
        fetchMock.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
        const api = new EnkryptifyApi("https://api.example.com", createAuth("tok"));

        await api.fetchAllSecrets("ws-1", "prj-1", "env-1");

        const url = fetchMock.mock.calls[0]?.[0] as string;
        expect(url).toBe(
            "https://api.example.com/v1/workspace/ws-1/project/prj-1/secret?environmentId=env-1&resolve=true",
        );
    });

    it("sends Authorization: Bearer header", async () => {
        fetchMock.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
        const api = new EnkryptifyApi("https://api.example.com", createAuth("my-token"));

        await api.fetchAllSecrets("ws", "prj", "env");

        const opts = fetchMock.mock.calls[0]?.[1] as RequestInit;
        expect(opts.headers).toHaveProperty("Authorization", "Bearer my-token");
    });

    it("parses successful response", async () => {
        const data = [{ id: "1", name: "KEY", values: [] }];
        fetchMock.mockResolvedValue(new Response(JSON.stringify(data), { status: 200 }));
        const api = new EnkryptifyApi("https://api.example.com", createAuth("tok"));

        const result = await api.fetchAllSecrets("ws", "prj", "env");
        expect(result).toEqual(data);
    });

    it("throws AuthenticationError on 401", async () => {
        fetchMock.mockResolvedValue(new Response("Unauthorized", { status: 401 }));
        const api = new EnkryptifyApi("https://api.example.com", createAuth("tok"));

        await expect(api.fetchAllSecrets("ws", "prj", "env")).rejects.toThrow(AuthenticationError);
    });

    it("throws AuthorizationError on 403", async () => {
        fetchMock.mockResolvedValue(new Response("Forbidden", { status: 403 }));
        const api = new EnkryptifyApi("https://api.example.com", createAuth("tok"));

        await expect(api.fetchAllSecrets("ws", "prj", "env")).rejects.toThrow(AuthorizationError);
    });

    it("throws NotFoundError on 404", async () => {
        fetchMock.mockResolvedValue(new Response("Not Found", { status: 404 }));
        const api = new EnkryptifyApi("https://api.example.com", createAuth("tok"));

        await expect(api.fetchAllSecrets("ws", "prj", "env")).rejects.toThrow(NotFoundError);
    });

    it("throws RateLimitError on 429", async () => {
        const headers = new Headers({ "Retry-After": "30" });
        fetchMock.mockResolvedValue(new Response("Too Many Requests", { status: 429, headers }));
        const api = new EnkryptifyApi("https://api.example.com", createAuth("tok"));

        await expect(api.fetchAllSecrets("ws", "prj", "env")).rejects.toThrow(RateLimitError);
    });

    it("throws ApiError on 500 with status in message", async () => {
        fetchMock.mockResolvedValue(
            new Response("Internal Server Error", { status: 500, statusText: "Internal Server Error" }),
        );
        const api = new EnkryptifyApi("https://api.example.com", createAuth("tok"));

        await expect(api.fetchAllSecrets("ws", "prj", "env")).rejects.toThrow(ApiError);
        await expect(api.fetchAllSecrets("ws", "prj", "env")).rejects.toThrow("HTTP 500");
    });

    it("URL-encodes special characters in path segments", async () => {
        fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: "1" }), { status: 200 }));
        const api = new EnkryptifyApi("https://api.example.com", createAuth("tok"));

        await api.fetchSecret("ws/special", "prj&name", "key with spaces", "env-1");

        const url = fetchMock.mock.calls[0]?.[0] as string;
        expect(url).toContain("ws%2Fspecial");
        expect(url).toContain("prj%26name");
        expect(url).toContain("key%20with%20spaces");
    });
});
