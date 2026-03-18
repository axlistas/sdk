import type { EnkryptifyAuthProvider, TokenExchange, TokenExchangeResponse } from "@/types";
import type { Logger } from "@/logger";
import { storeToken } from "@/internal/token-store";

export class TokenExchangeManager implements TokenExchange {
    #baseUrl: string;
    #staticToken: string;
    #auth: EnkryptifyAuthProvider;
    #logger: Logger;
    #jwt: string | null = null;
    #refreshTimer: ReturnType<typeof setTimeout> | null = null;
    #exchangePromise: Promise<void> | null = null;

    constructor(baseUrl: string, staticToken: string, auth: EnkryptifyAuthProvider, logger: Logger) {
        this.#baseUrl = baseUrl;
        this.#staticToken = staticToken;
        this.#auth = auth;
        this.#logger = logger;
    }

    async ensureToken(): Promise<void> {
        if (this.#jwt) return;

        // Deduplicate concurrent exchange calls
        if (this.#exchangePromise) {
            return this.#exchangePromise;
        }

        this.#exchangePromise = this.#exchange();
        try {
            await this.#exchangePromise;
        } finally {
            this.#exchangePromise = null;
        }
    }

    async #exchange(): Promise<void> {
        try {
            const response = await fetch(`${this.#baseUrl}/v1/auth/exchange`, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${this.#staticToken}`,
                    "Content-Type": "application/json",
                },
            });

            if (!response.ok) {
                throw new Error(`Token exchange failed with HTTP ${response.status}`);
            }

            const data = (await response.json()) as TokenExchangeResponse;
            this.#jwt = data.accessToken;
            storeToken(this.#auth, this.#jwt);
            this.#logger.debug("Token exchanged for short-lived JWT");

            // Refresh 60 seconds before expiry
            const refreshMs = (data.expiresIn - 60) * 1000;
            this.#scheduleRefresh(refreshMs);
        } catch (error) {
            // Fallback to static token
            this.#jwt = null;
            storeToken(this.#auth, this.#staticToken);
            this.#logger.warn(
                `Token exchange failed, falling back to static token: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    #scheduleRefresh(ms: number): void {
        if (this.#refreshTimer) {
            clearTimeout(this.#refreshTimer);
        }
        this.#refreshTimer = setTimeout(() => {
            this.#jwt = null;
            this.#exchange();
        }, ms);
        // Don't keep the process alive just for token refresh
        this.#refreshTimer.unref?.();
    }

    destroy(): void {
        if (this.#refreshTimer) {
            clearTimeout(this.#refreshTimer);
            this.#refreshTimer = null;
        }
        this.#jwt = null;
    }
}
