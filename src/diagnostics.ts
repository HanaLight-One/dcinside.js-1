import {ApiError, AuthExpiredError, CaptchaRequiredError, HTTPError, UnexpectedResponseError} from "./errors";
import {first, isFailure} from "./util";

export type PublicationTrace =
    | {stage: "prepared"; imageCount: number; imageBytes: number; blockCount: number;
        hasAppId: boolean; hasClientToken: boolean; hasUserId: boolean}
    | {stage: "response"; status: number; format: "json" | "non-json";
        result: "accepted" | "rejected" | "unknown"; reason: string; refreshRequested: boolean}
    | {stage: "transport-error"; responseReceived: boolean};

/** Only fixed classifications are emitted, never arbitrary server text. */
export function responseTrace(status: number, json: unknown): PublicationTrace {
    const object = first(json);
    const message = typeof object.cause === "string" ? object.cause : object.msg;
    const reason = message === "잠시후 다시 이용해주세요." ? "try-later-unspecified"
        : message === "certification" ? "app-auth-expired"
        : message === "certification_login" ? "login-expired" : "unspecified";
    return {stage:"response",status,format:json === undefined ? "non-json" : "json",
        result:isFailure(object) ? "rejected" : [true,"true",1,"1"].includes(object.result as boolean | string | number) ? "accepted" : "unknown",
        reason,refreshRequested:object.refresh_join === true || object.refresh_join === "true"};
}

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
