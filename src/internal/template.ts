import type { InterceptorRule, JsonValue } from "@/types";
import { InterceptorError } from "@/errors";

/**
 * Apply a rule's URL template to the intercepted URL. The template may contain
 * simple tokens resolved from the original URL — `{origin}`, `{host}`,
 * `{path}`, `{search}` — plus arbitrary `%VARIABLE%` placeholders which are
 * passed through to the proxy verbatim.
 *
 * When `template` is undefined, the original URL is returned unchanged.
 *
 * This function performs NO secret resolution. Secrets are resolved
 * server-side by the proxy.
 */
export function templateUrl(originalUrl: string, template: string | undefined): string {
    if (template === undefined) return originalUrl;

    let parsed: URL;
    try {
        parsed = new URL(originalUrl);
    } catch {
        // If the intercepted URL isn't parseable (rare — mswjs gives absolute URLs),
        // we can still substitute any non-URL tokens so the rule author gets a
        // useful error message downstream. Fall back to empty tokens.
        return template.replace(/\{origin\}|\{host\}|\{path\}|\{search\}/g, "");
    }

    return template
        .replace(/\{origin\}/g, parsed.origin)
        .replace(/\{host\}/g, parsed.host)
        .replace(/\{path\}/g, parsed.pathname)
        .replace(/\{search\}/g, parsed.search);
}

/**
 * Case-insensitive header merge. Returns a fresh record with the intercepted
 * headers as the base and the rule overrides layered on top. Override values
 * of `undefined` delete the header entirely.
 *
 * Hop-by-hop and request-size headers that would be invalid after the proxy
 * rewrites the request are dropped: `host`, `connection`, `content-length`,
 * `transfer-encoding`.
 */
export function mergeHeaders(
    intercepted: Record<string, string>,
    overrides: Record<string, string | undefined> | undefined,
): Record<string, string> | undefined {
    const HOP_BY_HOP = new Set(["host", "connection", "content-length", "transfer-encoding"]);

    // Normalise all keys to lowercase so overrides reliably replace existing
    // headers regardless of original casing.
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(intercepted)) {
        const lower = key.toLowerCase();
        if (HOP_BY_HOP.has(lower)) continue;
        out[lower] = value;
    }

    if (overrides) {
        for (const [key, value] of Object.entries(overrides)) {
            const lower = key.toLowerCase();
            if (value === undefined) {
                delete out[lower];
            } else {
                out[lower] = value;
            }
        }
    }

    return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Resolve the body to send to the proxy, based on the rule's `body` override
 * and the intercepted body (which may be `undefined` when the request had no
 * body or a non-JSON body).
 *
 * No secret resolution happens here — any `%VARIABLE%` tokens in strings are
 * preserved verbatim for the proxy to substitute.
 */
export function resolveBody(
    intercepted: JsonValue | undefined,
    override: InterceptorRule["body"],
): JsonValue | undefined {
    if (override === undefined) return intercepted;

    if (typeof override === "function") {
        return override(intercepted);
    }

    if (typeof override === "string") {
        try {
            return JSON.parse(override) as JsonValue;
        } catch {
            throw new InterceptorError(
                "Rule `body` override must be JSON-serialisable. Received a non-JSON string; " +
                    "pass an object/array/primitive directly or JSON.stringify first.",
            );
        }
    }

    // Already a JsonValue (object/array/primitive).
    return override;
}
