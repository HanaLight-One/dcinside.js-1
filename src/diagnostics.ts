import {ApiError, AuthExpiredError, CaptchaRequiredError, HTTPError, UnexpectedResponseError} from "./errors";

/** Safe structured diagnostics: never emits raw response, message, URL, headers or credentials. */
export function publicationDiagnostic(error: unknown) {
    if (error instanceof UnexpectedResponseError) return {kind: "unverified-response", status: error.status, reason: error.reason, retryable: false} as const;
    if (error instanceof AuthExpiredError) return {kind: "authentication-expired", reason: error.kind, retryable: false} as const;
    if (error instanceof CaptchaRequiredError) return {kind: "human-required", retryable: false} as const;
    if (error instanceof HTTPError) return {kind: "http-error", status: error.status, retryable: false} as const;
    if (error instanceof ApiError) {
        // Exact known messages only; unknown cause strings may contain private data.
        const reason = error.cause === "잠시후 다시 이용해주세요." ? "try-later-unspecified" : "unspecified-rejection";
        return {kind: "api-rejected", reason, status: error.status, retryable: false} as const;
    }
    return {kind: "unknown", retryable: false} as const;
}
