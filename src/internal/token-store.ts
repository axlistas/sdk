import { EnkryptifyError } from "@/errors";

const store = new WeakMap<object, string>();

export function storeToken(provider: object, token: string): void {
    store.set(provider, token);
}

export function retrieveToken(provider: object): string {
    const token = store.get(provider);
    if (!token) {
        throw new EnkryptifyError(
            "Invalid or destroyed auth provider. Create a new one via Enkryptify.fromEnv().\n" +
                "Docs: https://docs.enkryptify.com/sdk/auth",
        );
    }
    return token;
}
