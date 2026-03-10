import type { EnkryptifyAuthProvider } from "@/types";
import { EnkryptifyError } from "@/errors";
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
