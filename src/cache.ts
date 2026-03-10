interface CacheEntry {
    value: string;
    expiresAt: number | null;
}

export class SecretCache {
    #store = new Map<string, CacheEntry>();
    #ttl: number;

    constructor(ttl: number) {
        this.#ttl = ttl;
    }

    get(key: string): string | undefined {
        const entry = this.#store.get(key);
        if (!entry) return undefined;

        if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
            this.#store.delete(key);
            return undefined;
        }

        return entry.value;
    }

    set(key: string, value: string): void {
        this.#store.set(key, {
            value,
            expiresAt: this.#ttl === -1 ? null : Date.now() + this.#ttl,
        });
    }

    has(key: string): boolean {
        return this.get(key) !== undefined;
    }

    clear(): void {
        this.#store.clear();
        this.#store = new Map();
    }

    get size(): number {
        return this.#store.size;
    }
}
