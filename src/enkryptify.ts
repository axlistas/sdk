import type { EnkryptifyAuthProvider, EnkryptifyConfig, IEnkryptify, Secret } from "@/types";
import { EnkryptifyError, SecretNotFoundError, NotFoundError } from "@/errors";
import { EnvAuthProvider, TokenAuthProvider } from "@/auth";
import { EnkryptifyApi } from "@/api";
import { SecretCache } from "@/cache";
import { Logger } from "@/logger";
import { retrieveToken } from "@/internal/token-store";
import { TokenExchangeManager } from "@/token-exchange";

export class Enkryptify implements IEnkryptify {
    #api: EnkryptifyApi;
    #cache: SecretCache | null;
    #logger: Logger;
    #workspace: string;
    #project: string;
    #environment: string;
    #strict: boolean;
    #usePersonalValues: boolean;
    #cacheEnabled: boolean;
    #eagerCache: boolean;
    #destroyed = false;
    #eagerLoaded = false;
    #tokenExchange: TokenExchangeManager | null = null;

    constructor(config: EnkryptifyConfig) {
        if (!config.workspace) {
            throw new EnkryptifyError(
                'Missing required config field "workspace". Provide a workspace slug or ID.\n' +
                    "Docs: https://docs.enkryptify.com/sdk/configuration",
            );
        }
        if (!config.project) {
            throw new EnkryptifyError(
                'Missing required config field "project". Provide a project slug or ID.\n' +
                    "Docs: https://docs.enkryptify.com/sdk/configuration",
            );
        }
        if (!config.environment) {
            throw new EnkryptifyError(
                'Missing required config field "environment". Provide an environment ID.\n' +
                    "Docs: https://docs.enkryptify.com/sdk/configuration",
            );
        }

        // Resolve auth provider: token option → auth option → env var
        let auth: EnkryptifyAuthProvider;
        if (config.token) {
            Enkryptify.#validateTokenFormat(config.token);
            auth = new TokenAuthProvider(config.token);
        } else if (config.auth) {
            if (config.auth._brand !== "EnkryptifyAuthProvider") {
                throw new EnkryptifyError(
                    "Invalid auth provider. Use Enkryptify.fromEnv() or pass a token option.\n" +
                        "Docs: https://docs.enkryptify.com/sdk/auth",
                );
            }
            auth = config.auth;
        } else {
            const envToken = process.env.ENKRYPTIFY_TOKEN;
            if (!envToken) {
                throw new EnkryptifyError(
                    "No token provided. Set ENKRYPTIFY_TOKEN or pass token in options.\n" +
                        "Docs: https://docs.enkryptify.com/sdk/auth",
                );
            }
            Enkryptify.#validateTokenFormat(envToken);
            auth = new TokenAuthProvider(envToken);
        }

        // Validate that the auth provider has a token in the store
        retrieveToken(auth);

        this.#workspace = config.workspace;
        this.#project = config.project;
        this.#environment = config.environment;
        this.#strict = config.options?.strict ?? true;
        this.#usePersonalValues = config.options?.usePersonalValues ?? true;

        this.#cacheEnabled = config.cache?.enabled ?? true;
        this.#eagerCache = config.cache?.eager ?? true;
        const cacheTtl = config.cache?.ttl ?? -1;

        this.#logger = new Logger(config.logger?.level ?? "info");
        this.#cache = this.#cacheEnabled ? new SecretCache(cacheTtl) : null;

        const baseUrl = config.baseUrl ?? "https://api.enkryptify.com";
        this.#api = new EnkryptifyApi(baseUrl, auth);

        if (config.useTokenExchange) {
            const staticToken = retrieveToken(auth);
            this.#tokenExchange = new TokenExchangeManager(baseUrl, staticToken, auth, this.#logger);
        }

        this.#logger.info(
            `Initialized for workspace "${this.#workspace}", project "${this.#project}", environment "${this.#environment}"`,
        );
    }

    static fromEnv(): EnkryptifyAuthProvider {
        return new EnvAuthProvider();
    }

    static #validateTokenFormat(token: string): void {
        if (!token) {
            throw new EnkryptifyError("Token must be a non-empty string.\nDocs: https://docs.enkryptify.com/sdk/auth");
        }

        // Accept ek_live_ API tokens
        if (token.startsWith("ek_live_")) return;

        // Accept JWTs (three base64 segments separated by dots)
        const dotCount = token.split(".").length - 1;
        if (dotCount === 2) return;

        throw new EnkryptifyError(
            "Invalid token format. Expected an ek_live_ token or JWT.\n" +
                "Docs: https://docs.enkryptify.com/sdk/auth#token-format",
        );
    }

    async get(key: string, options?: { cache?: boolean }): Promise<string> {
        this.#guardDestroyed();

        const useCache = this.#cacheEnabled && options?.cache !== false;

        if (useCache && this.#cache) {
            const cached = this.#cache.get(key);
            if (cached !== undefined) {
                this.#logger.debug(`Cache hit for secret "${key}"`);
                return cached;
            }
            this.#logger.debug(`Cache miss for secret "${key}", fetching from API`);
        }

        await this.#tokenExchange?.ensureToken();

        if (useCache && this.#eagerCache && !this.#eagerLoaded) {
            return this.#fetchAndCacheAll(key);
        }

        return this.#fetchAndCacheSingle(key);
    }

    getFromCache(key: string): string {
        this.#guardDestroyed();

        if (!this.#cacheEnabled || !this.#cache) {
            throw new EnkryptifyError(
                "Cache is disabled. Enable caching in the config or use get() to fetch from the API.\n" +
                    "Docs: https://docs.enkryptify.com/sdk/configuration#caching",
            );
        }

        const value = this.#cache.get(key);
        if (value === undefined) {
            throw new SecretNotFoundError(key, this.#workspace, this.#environment);
        }

        return value;
    }

    async preload(): Promise<void> {
        this.#guardDestroyed();

        if (!this.#cacheEnabled || !this.#cache) {
            throw new EnkryptifyError(
                "Cannot preload: caching is disabled. Enable caching in the config.\n" +
                    "Docs: https://docs.enkryptify.com/sdk/configuration#caching",
            );
        }

        await this.#tokenExchange?.ensureToken();

        const secrets = await this.#api.fetchAllSecrets(this.#workspace, this.#project, this.#environment);

        let count = 0;
        for (const secret of secrets) {
            const value = this.#resolveValue(secret);
            if (value !== undefined) {
                this.#cache.set(secret.name, value);
                count++;
            }
        }

        this.#eagerLoaded = true;
        this.#logger.info(`Preloaded ${count} secrets into cache`);
    }

    destroy(): void {
        if (this.#destroyed) return;
        this.#tokenExchange?.destroy();
        this.#cache?.clear();
        this.#destroyed = true;
        this.#logger.info("Client destroyed, all cached secrets cleared");
    }

    #guardDestroyed(): void {
        if (this.#destroyed) {
            throw new EnkryptifyError(
                "This Enkryptify client has been destroyed. Create a new instance to continue.\n" +
                    "Docs: https://docs.enkryptify.com/sdk/lifecycle",
            );
        }
    }

    async #fetchAndCacheAll(key: string): Promise<string> {
        this.#logger.debug(
            `Fetching secret(s) from API: GET /v1/workspace/${this.#workspace}/project/${this.#project}/secret`,
        );
        const start = Date.now();
        const secrets = await this.#api.fetchAllSecrets(this.#workspace, this.#project, this.#environment);
        this.#logger.debug(`API responded with ${secrets.length} secret(s) in ${Date.now() - start}ms`);

        let found: string | undefined;

        for (const secret of secrets) {
            const value = this.#resolveValue(secret);
            if (value !== undefined && this.#cache) {
                this.#cache.set(secret.name, value);
                this.#logger.debug(
                    `Cached secret "${secret.name}" (${this.#cache ? "TTL: cache configured" : "no expiry"})`,
                );
            }
            if (secret.name === key) {
                found = value;
            }
        }

        this.#eagerLoaded = true;

        if (found !== undefined) {
            return found;
        }

        return this.#handleNotFound(key);
    }

    async #fetchAndCacheSingle(key: string): Promise<string> {
        this.#logger.debug(
            `Fetching secret(s) from API: GET /v1/workspace/${this.#workspace}/project/${this.#project}/secret/${key}`,
        );
        let secret: Secret;
        try {
            const start = Date.now();
            secret = await this.#api.fetchSecret(this.#workspace, this.#project, key, this.#environment);
            this.#logger.debug(`API responded with 1 secret(s) in ${Date.now() - start}ms`);
        } catch (error) {
            // NotFoundError is imported at the module level via @/errors
            if (error instanceof NotFoundError) {
                return this.#handleNotFound(key);
            }
            throw error;
        }

        const value = this.#resolveValue(secret);
        if (value === undefined) {
            return this.#handleNotFound(key);
        }

        if (this.#cacheEnabled && this.#cache) {
            this.#cache.set(key, value);
        }

        return value;
    }

    #handleNotFound(key: string): string {
        if (this.#strict) {
            throw new SecretNotFoundError(key, this.#workspace, this.#environment);
        }
        this.#logger.warn(`Secret "${key}" not found (strict mode disabled, returning empty string)`);
        return "";
    }

    #resolveValue(secret: Secret): string | undefined {
        const envValues = secret.values.filter((v) => v.environmentId === this.#environment);

        if (this.#usePersonalValues) {
            const personal = envValues.find((v) => v.isPersonal);
            if (personal) return personal.value;

            const shared = envValues.find((v) => !v.isPersonal);
            if (shared) {
                this.#logger.warn(`No personal value for "${secret.name}", falling back to shared value`);
                return shared.value;
            }
        } else {
            const shared = envValues.find((v) => !v.isPersonal);
            if (shared) return shared.value;
        }

        return undefined;
    }
}
