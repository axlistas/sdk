import type { TokenExchange, TokenExchangeResponse } from "@/types";
import type { Logger } from "@/logger";
import type { KubernetesAuthProvider } from "@/auth";
import { KubernetesAuthError } from "@/errors";
import { storeToken } from "@/internal/token-store";

export class KubernetesExchangeManager implements TokenExchange {
    #baseUrl: string;
    #auth: KubernetesAuthProvider;
    #workspaceId: string;
    #logger: Logger;
    #jwt: string | null = null;
    #refreshTimer: ReturnType<typeof setTimeout> | null = null;
    #exchangePromise: Promise<void> | null = null;

    constructor(baseUrl: string, auth: KubernetesAuthProvider, workspaceId: string, logger: Logger) {
        this.#baseUrl = baseUrl;
        this.#auth = auth;
        this.#workspaceId = workspaceId;
        this.#logger = logger;
    }

    async ensureToken(): Promise<void> {
        if (this.#jwt) return;

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
        const k8sToken = this.#auth.readToken();

        const response = await fetch(`${this.#baseUrl}/v1/auth/oidc/exchange`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: k8sToken, workspaceId: this.#workspaceId }),
        });

        if (!response.ok) {
            throw new KubernetesAuthError(`OIDC token exchange failed with HTTP ${response.status}`);
        }

        const data = (await response.json()) as TokenExchangeResponse;
        this.#jwt = data.accessToken;
        storeToken(this.#auth, this.#jwt);
        this.#logger.debug("Kubernetes OIDC token exchanged for short-lived JWT");

        const refreshMs = (data.expiresIn - 60) * 1000;
        this.#scheduleRefresh(refreshMs);
    }

    #scheduleRefresh(ms: number): void {
        if (this.#refreshTimer) {
            clearTimeout(this.#refreshTimer);
        }
        this.#refreshTimer = setTimeout(() => {
            this.#jwt = null;
            this.#exchange().catch((error) => {
                this.#logger.warn(
                    `Background Kubernetes token refresh failed: ${error instanceof Error ? error.message : String(error)}`,
                );
            });
        }, ms);
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
