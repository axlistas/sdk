import { readFileSync } from "node:fs";
import type { EnkryptifyAuthProvider, KubernetesAuthOptions } from "@/types";
import { EnkryptifyError, KubernetesAuthError } from "@/errors";
import { storeToken } from "@/internal/token-store";

export class EnvAuthProvider implements EnkryptifyAuthProvider {
    readonly _brand = "EnkryptifyAuthProvider" as const;

    constructor() {
        const token = process.env.ENKRYPTIFY_TOKEN;
        if (!token) {
            throw new EnkryptifyError(
                "ENKRYPTIFY_TOKEN environment variable is not set. Set it before initializing the SDK:\n" +
                    '  export ENKRYPTIFY_TOKEN="ek_..."\n' +
                    "Docs: https://docs.enkryptify.com/sdk/auth#environment-variables",
            );
        }
        storeToken(this, token);
    }
}

export class TokenAuthProvider implements EnkryptifyAuthProvider {
    readonly _brand = "EnkryptifyAuthProvider" as const;

    constructor(token: string) {
        storeToken(this, token);
    }
}

const DEFAULT_TOKEN_PATH = "/var/run/secrets/tokens/token";

export class KubernetesAuthProvider implements EnkryptifyAuthProvider {
    readonly _brand = "EnkryptifyAuthProvider" as const;
    readonly tokenPath: string;

    constructor(options?: KubernetesAuthOptions) {
        this.tokenPath = process.env.ENKRYPTIFY_TOKEN_PATH ?? options?.tokenPath ?? DEFAULT_TOKEN_PATH;
    }

    readToken(): string {
        let content: string;
        try {
            content = readFileSync(this.tokenPath, "utf-8");
        } catch (error) {
            throw new KubernetesAuthError(
                `Failed to read Kubernetes service account token from "${this.tokenPath}": ${error instanceof Error ? error.message : String(error)}`,
            );
        }

        const token = content.trim();
        if (!token) {
            throw new KubernetesAuthError(`Kubernetes service account token file is empty: "${this.tokenPath}"`);
        }

        return token;
    }
}
