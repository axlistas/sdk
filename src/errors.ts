export class EnkryptifyError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "EnkryptifyError";
    }
}

export class SecretNotFoundError extends EnkryptifyError {
    constructor(key: string, workspace: string, environment: string) {
        super(
            `Secret "${key}" not found in workspace "${workspace}" (environment: "${environment}"). ` +
                `Verify the secret exists in your Enkryptify dashboard.\n` +
                `Docs: https://docs.enkryptify.com/sdk/troubleshooting#secret-not-found`,
        );
        this.name = "SecretNotFoundError";
    }
}

export class AuthenticationError extends EnkryptifyError {
    constructor() {
        super(
            "Authentication failed (HTTP 401). Token is invalid, expired, or revoked. " +
                "Generate a new token in your Enkryptify dashboard.\n" +
                "Docs: https://docs.enkryptify.com/sdk/auth#token-issues",
        );
        this.name = "AuthenticationError";
    }
}

export class AuthorizationError extends EnkryptifyError {
    constructor() {
        super(
            "Authorization failed (HTTP 403). Token does not have access to this resource. " +
                "Check that your token has the required permissions.\n" +
                "Docs: https://docs.enkryptify.com/sdk/auth#permissions",
        );
        this.name = "AuthorizationError";
    }
}

export class NotFoundError extends EnkryptifyError {
    constructor(method: string, endpoint: string) {
        super(
            `Resource not found (HTTP 404) for ${method} ${endpoint}. ` +
                "Workspace, project, or environment not found. Verify your configuration.\n" +
                "Docs: https://docs.enkryptify.com/sdk/troubleshooting#not-found",
        );
        this.name = "NotFoundError";
    }
}

export class RateLimitError extends EnkryptifyError {
    public readonly retryAfter: number | null;

    constructor(retryAfter?: string | null) {
        const parsed = retryAfter ? parseInt(retryAfter, 10) : null;
        const retrySeconds = parsed !== null && !Number.isNaN(parsed) ? parsed : null;
        super(
            `Rate limited (HTTP 429). ` +
                `${retrySeconds ? `Retry after ${retrySeconds} seconds.` : "Please retry later."}\n` +
                "Docs: https://docs.enkryptify.com/sdk/troubleshooting#rate-limiting",
        );
        this.name = "RateLimitError";
        this.retryAfter = retrySeconds;
    }
}

export class KubernetesAuthError extends EnkryptifyError {
    constructor(message: string) {
        super(`${message}\nDocs: https://docs.enkryptify.com/sdk/auth#kubernetes`);
        this.name = "KubernetesAuthError";
    }
}

export class ApiError extends EnkryptifyError {
    public readonly status: number;

    constructor(status: number, statusText: string, method: string, endpoint: string) {
        super(
            `API request failed (HTTP ${status}) for ${method} ${endpoint}. ` +
                `${statusText ? statusText + ". " : ""}` +
                `This may be a temporary server issue — retry in a few moments.\n` +
                `Docs: https://docs.enkryptify.com/sdk/troubleshooting#api-errors`,
        );
        this.name = "ApiError";
        this.status = status;
    }
}

function formatDetail(detail: unknown): string {
    if (detail === undefined || detail === null) return "";
    if (typeof detail === "string") return detail;
    try {
        return JSON.stringify(detail);
    } catch {
        return String(detail);
    }
}

export class ProxyError extends EnkryptifyError {
    public readonly status: number;
    public readonly detail?: unknown;

    constructor(status: number, statusText: string, detail?: unknown) {
        const detailStr = formatDetail(detail);
        super(
            `Proxy request failed (HTTP ${status}). ` +
                `${statusText ? statusText + ". " : ""}` +
                `${detailStr ? `Detail: ${detailStr}. ` : ""}` +
                `This may be a temporary proxy issue — retry in a few moments.\n` +
                `Docs: https://docs.enkryptify.com/sdk/proxy#errors`,
        );
        this.name = "ProxyError";
        this.status = status;
        this.detail = detail;
    }
}

export class ProxyValidationError extends EnkryptifyError {
    public readonly detail?: unknown;

    constructor(detail?: unknown) {
        const detailStr = formatDetail(detail);
        super(
            `Proxy rejected the request (HTTP 400). ` +
                `${detailStr ? `Detail: ${detailStr}. ` : ""}` +
                `Check your URL, method, headers, body, and proxy config.\n` +
                `Docs: https://docs.enkryptify.com/sdk/proxy#errors`,
        );
        this.name = "ProxyValidationError";
        this.detail = detail;
    }
}

export class InterceptorError extends EnkryptifyError {
    constructor(message: string) {
        super(`${message}\nDocs: https://docs.enkryptify.com/sdk/interceptor`);
        this.name = "InterceptorError";
    }
}
