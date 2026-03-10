export interface IEnkryptify {
    /**
     * Gets a secret by key.
     *
     * Uses the cache by default when available. Otherwise, fetches the secret
     * from the API.
     *
     * @param key - The key of the secret to retrieve.
     * @param options - Options for the get operation.
     * @param options.cache - Whether to use the cache when available. Defaults to `true`.
     * @returns The value of the secret.
     */
    get(
        key: string,
        options?: {
            cache?: boolean;
        },
    ): Promise<string>;

    /**
     * Gets a secret by key from the cache.
     *
     * Throws if the secret is not already cached.
     *
     * @param key - The key of the secret to retrieve.
     * @returns The cached value of the secret.
     * @throws {EnkryptifyError} If the secret is not in the cache.
     */
    getFromCache(key: string): string;

    /**
     * Preloads the cache with all secrets.
     *
     * @returns A promise that resolves when the cache has been preloaded.
     */
    preload(): Promise<void>;

    /**
     * Destroys the client, clearing all cached secrets.
     */
    destroy(): void;
}

export interface EnkryptifyConfig {
    auth?: EnkryptifyAuthProvider;
    token?: string;
    workspace: string;
    project: string;
    environment: string;
    baseUrl?: string;
    useTokenExchange?: boolean;
    options?: {
        strict?: boolean;
        usePersonalValues?: boolean;
    };
    cache?: {
        enabled?: boolean;
        ttl?: number;
        eager?: boolean;
    };
    logger?: {
        level?: "debug" | "info" | "warn" | "error";
    };
}

export interface TokenExchangeResponse {
    accessToken: string;
    expiresIn: number;
    tokenType: string;
}

export interface EnkryptifyAuthProvider {
    readonly _brand: "EnkryptifyAuthProvider";
}

export interface SecretValue {
    environmentId: string;
    value: string;
    isPersonal: boolean;
    reminder?: { id: string; type: "one_time" | "recurring"; nextReminderDate: string };
}

export interface Secret {
    id: string;
    name: string;
    note: string;
    type: string;
    dataType: string;
    values: SecretValue[];
    createdAt: string;
    updatedAt: string;
}
