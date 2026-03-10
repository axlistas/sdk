import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SecretCache } from "@/cache";

describe("SecretCache", () => {
    it("set() and get() round-trip correctly", () => {
        const cache = new SecretCache(-1);
        cache.set("key1", "value1");
        expect(cache.get("key1")).toBe("value1");
    });

    it("returns undefined for unknown keys", () => {
        const cache = new SecretCache(-1);
        expect(cache.get("nonexistent")).toBeUndefined();
    });

    describe("TTL expiry", () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it("returns value before TTL expires", () => {
            const cache = new SecretCache(1000);
            cache.set("key", "value");
            vi.advanceTimersByTime(500);
            expect(cache.get("key")).toBe("value");
        });

        it("returns undefined after TTL expires", () => {
            const cache = new SecretCache(1000);
            cache.set("key", "value");
            vi.advanceTimersByTime(1001);
            expect(cache.get("key")).toBeUndefined();
        });
    });

    it("TTL=-1 never expires", () => {
        vi.useFakeTimers();
        const cache = new SecretCache(-1);
        cache.set("key", "value");
        vi.advanceTimersByTime(999_999_999);
        expect(cache.get("key")).toBe("value");
        vi.useRealTimers();
    });

    it("has() reflects state correctly", () => {
        const cache = new SecretCache(-1);
        expect(cache.has("key")).toBe(false);
        cache.set("key", "value");
        expect(cache.has("key")).toBe(true);
    });

    it("clear() empties cache completely", () => {
        const cache = new SecretCache(-1);
        cache.set("a", "1");
        cache.set("b", "2");
        cache.clear();
        expect(cache.get("a")).toBeUndefined();
        expect(cache.get("b")).toBeUndefined();
        expect(cache.size).toBe(0);
    });

    it("size returns correct count", () => {
        const cache = new SecretCache(-1);
        expect(cache.size).toBe(0);
        cache.set("a", "1");
        expect(cache.size).toBe(1);
        cache.set("b", "2");
        expect(cache.size).toBe(2);
    });
});
