import { describe, it, expect, afterEach } from "vitest";
import { EnvAuthProvider } from "@/auth";
import { EnkryptifyError } from "@/errors";

describe("EnvAuthProvider", () => {
    const originalEnv = process.env.ENKRYPTIFY_TOKEN;

    afterEach(() => {
        if (originalEnv !== undefined) {
            process.env.ENKRYPTIFY_TOKEN = originalEnv;
        } else {
            delete process.env.ENKRYPTIFY_TOKEN;
        }
    });

    it("creates provider when ENKRYPTIFY_TOKEN is set", () => {
        process.env.ENKRYPTIFY_TOKEN = "ek_test_token";
        const provider = new EnvAuthProvider();
        expect(provider._brand).toBe("EnkryptifyAuthProvider");
    });

    it("throws when ENKRYPTIFY_TOKEN is missing", () => {
        delete process.env.ENKRYPTIFY_TOKEN;
        expect(() => new EnvAuthProvider()).toThrow(EnkryptifyError);
        expect(() => new EnvAuthProvider()).toThrow("ENKRYPTIFY_TOKEN environment variable is not set");
    });

    it("throws when ENKRYPTIFY_TOKEN is empty string", () => {
        process.env.ENKRYPTIFY_TOKEN = "";
        expect(() => new EnvAuthProvider()).toThrow(EnkryptifyError);
    });

    it("token is not accessible via Object.keys()", () => {
        process.env.ENKRYPTIFY_TOKEN = "ek_test_token";
        const provider = new EnvAuthProvider();
        const keys = Object.keys(provider);
        expect(keys).not.toContain("token");
        for (const key of keys) {
            expect((provider as unknown as Record<string, unknown>)[key]).not.toBe("ek_test_token");
        }
    });

    it("token is not accessible via JSON.stringify()", () => {
        process.env.ENKRYPTIFY_TOKEN = "ek_test_token";
        const provider = new EnvAuthProvider();
        const json = JSON.stringify(provider);
        expect(json).not.toContain("ek_test_token");
    });

    it("token is not accessible via property enumeration", () => {
        process.env.ENKRYPTIFY_TOKEN = "ek_test_token";
        const provider = new EnvAuthProvider();
        const allProps = Object.getOwnPropertyNames(provider);
        const symbols = Object.getOwnPropertySymbols(provider);
        for (const prop of allProps) {
            expect((provider as unknown as Record<string, unknown>)[prop]).not.toBe("ek_test_token");
        }
        for (const sym of symbols) {
            expect((provider as unknown as Record<symbol, unknown>)[sym]).not.toBe("ek_test_token");
        }
    });

    it("has the _brand property", () => {
        process.env.ENKRYPTIFY_TOKEN = "ek_test_token";
        const provider = new EnvAuthProvider();
        expect(provider._brand).toBe("EnkryptifyAuthProvider");
    });
});
