import {APP, HOST, REDIRECTED_PATHS} from "./constants";
import {ApiError, AuthExpiredError, CaptchaRequiredError, HTTPError, UnexpectedResponseError} from "./errors";
import {normalize} from "./normalize";
import type {ResponseMap} from "./types/responses";
import {first, isCaptchaCause, isFailure, list, parseJson} from "./util";
import {responseTrace, type PublicationTrace} from "./diagnostics";

/** `as` 옵션에 쓰는 응답 이름입니다. */
export type ResponseName = keyof ResponseMap;

/** 폼/쿼리 필드 값입니다. `null`/`undefined`는 생략하고, boolean은 앱처럼 `"1"`/`"0"`으로 보냅니다. */
export type FieldValue = string | number | boolean | Blob | null | undefined;
export type Fields = Record<string, FieldValue>;

export interface HttpOptions {
    /** 직접 만든 fetch를 씁니다. Node에서 프록시(undici dispatcher)를 쓸 때 여기에 넘기세요. */
    fetch?: typeof fetch;
    /** Bun의 `fetch(…, {proxy})`로 보낼 프록시 URL입니다. */
    proxy?: string;
    /** 요청 제한 시간(ms)입니다. 기본 30초입니다. */
    timeout?: number;
    /** 모든 요청에 덧붙일 헤더입니다. */
    headers?: Record<string, string>;
}

export interface RequestOptions {
    /** 제한된 구조 정보만 전달합니다. 준비 기록 저장 실패는 전송을 중단합니다. */
    onDiagnostic?: (event: PublicationTrace) => Promise<void>;
    /** 비멱등 작업은 false: 인증 갱신 후에도 요청을 자동 재전송하지 않습니다. */
    retryAuth?: boolean;
    /** HTML/문자열/불명확한 JSON을 성공으로 취급하지 않습니다. */
    requireApiResult?: boolean;
    /** 전송 직전 영속 제출 기록을 만들 때 사용합니다. 실패하면 전송하지 않습니다. */
    beforeSend?: () => Promise<void>;
    /** `app_id`를 자동으로 붙일지 여부입니다. 기본값은 app/upload/m 호스트에서 `true`입니다. */
    appId?: boolean;
    /** 응답을 배열로 돌려받습니다. 기본은 첫 객체입니다. */
    list?: boolean;
    /** `result: false`를 에러로 바꾸지 않고 그대로 돌려받습니다. */
    raw?: boolean;
    /** POST 본문을 multipart 대신 urlencoded로 보냅니다. 모바일 웹 엔드포인트용입니다. */
    urlencoded?: boolean;
    /** 이 요청에만 덧붙일 헤더입니다. */
    headers?: Record<string, string>;
    /** 응답 모델 이름입니다. 주면 앱 Gson 규칙으로 값을 정규화하고 그 타입으로 돌려줍니다. */
    as?: ResponseName;
}

type Typed<K extends ResponseName> = RequestOptions & { as: K };

/** HTTP 레이어가 인증 정보를 얻고 갱신하는 통로입니다. `DCInside`가 연결합니다. */
export interface AuthContext {
    appId(): Promise<string>;
    refreshAppId(): Promise<unknown>;
    /** 저장된 로그인 정보로 다시 로그인합니다. 로그인 세션이 없으면 `false`입니다. */
    relogin(): Promise<boolean>;
}

const APP_ID_HOSTS = new Set([HOST.app, HOST.upload, HOST.mobile].map((url) => new URL(url).host));

/**
 * 공식 앱의 `ApiBase`와 같은 규칙으로 요청을 보냅니다.
 *
 * - POST는 항상 multipart/form-data입니다.
 * - 앱이 감싸는 GET은 `redirect.php?hash=`로 보냅니다.
 * - 응답 cause가 `certification`이면 `app_id`를, `certification_login`이면 로그인을 갱신해 한 번 다시 보냅니다.
 */
export class Http {
    context: AuthContext | null = null;
    private readonly fetcher: typeof fetch;

    constructor(private readonly options: HttpOptions = {}) {
        this.fetcher = options.fetch ?? fetch;
    }

    /** 기본 헤더/프록시/타임아웃을 적용한 fetch입니다. 인증 주입과 재시도는 하지 않습니다. */
    fetch(url: string | URL, init: RequestInit = {}): Promise<Response> {
        const headers = new Headers({"User-Agent": APP.userAgent, Referer: APP.referer, ...this.options.headers});
        new Headers(init.headers).forEach((value, key) => headers.set(key, value));
        return this.fetcher(url, {
            ...init,
            headers,
            signal: init.signal ?? AbortSignal.timeout(this.options.timeout ?? 30_000),
            ...(this.options.proxy ? {proxy: this.options.proxy} : {})
        } as RequestInit);
    }

    get<K extends ResponseName>(url: string, query: Fields, options: Typed<K> & { list: true }): Promise<ResponseMap[K][]>;
    get<K extends ResponseName>(url: string, query: Fields, options: Typed<K>): Promise<ResponseMap[K]>;
    get<T = unknown>(url: string, query?: Fields, options?: RequestOptions): Promise<T>;
    get(url: string, query: Fields = {}, options: RequestOptions = {}): Promise<unknown> {
        return this.send("GET", url, query, options);
    }

    post<K extends ResponseName>(url: string, fields: Fields, options: Typed<K> & { list: true }): Promise<ResponseMap[K][]>;
    post<K extends ResponseName>(url: string, fields: Fields, options: Typed<K>): Promise<ResponseMap[K]>;
    post<T = unknown>(url: string, fields?: Fields, options?: RequestOptions): Promise<T>;
    post(url: string, fields: Fields = {}, options: RequestOptions = {}): Promise<unknown> {
        return this.send("POST", url, fields, options);
    }

    private async send(method: "GET" | "POST", url: string, fields: Fields, options: RequestOptions, retried = false): Promise<unknown> {
        const target = new URL(url);
        const all: Fields = {...fields};
        if (this.context && (options.appId ?? APP_ID_HOSTS.has(target.host)) && all["app_id"] === undefined) {
            all["app_id"] = await this.context.appId();
        }

        if (options.onDiagnostic) {
            const images = Object.entries(all).filter(([key,value]) => /^upload\[\d+\]$/.test(key) && value instanceof Blob);
            await options.onDiagnostic({stage:"prepared",imageCount:images.length,
                imageBytes:images.reduce((sum,[,v])=>sum+(v as Blob).size,0),
                blockCount:Object.keys(all).filter(key=>/^memo_block\[\d+\]$/.test(key)).length,
                hasAppId:typeof all.app_id === "string" && all.app_id.length > 0,
                hasClientToken:typeof all.client_token === "string" && all.client_token.length > 0,
                hasUserId:typeof all.user_id === "string" && all.user_id.length > 0});
        }
        await options.beforeSend?.();

        let response: Response | undefined;
        let text: string;
        try {
        response = method === "GET"
            ? await this.fetch(this.buildGetUrl(target, all), {headers: options.headers})
            : await this.fetch(target, {method, headers: options.headers, redirect: options.requireApiResult ? "error" : undefined,
                body: options.urlencoded ? toSearchParams(all) : toFormData(all)});
        text = await response.text();
        } catch (error) {
            await options.onDiagnostic?.({stage:"transport-error",responseReceived:response !== undefined});
            throw error;
        }
        const json = parseJson(text);
        await options.onDiagnostic?.(responseTrace(response.status,json));
        if (json === undefined) {
            if (!response.ok) throw new HTTPError(response.status, text);
            if (options.requireApiResult) throw new UnexpectedResponseError(response.status, "non-json");
            return text;
        }

        const object = first(json);
        const cause = typeof object["cause"] === "string" ? object["cause"] : "";
        const expired = cause === "certification" || String(object["refresh_join"]) === "true" ? "appId"
            : cause === "certification_login" ? "login" : null;
        if (expired && this.context) {
            if (retried || options.retryAuth === false) throw new AuthExpiredError(expired, cause, json);
            if (expired === "appId") await this.context.refreshAppId();
            else if (!(await this.context.relogin())) throw new AuthExpiredError("login", cause, json);
            // 원래 필드로 다시 보내야 새 app_id가 주입됩니다.
            return this.send(method, url, fields, options, true);
        }

        if (!options.raw && isFailure(object)) {
            const message = cause || (typeof object["msg"] === "string" ? object["msg"] : "");
            throw isCaptchaCause(message) ? new CaptchaRequiredError(message, json, response.status) : new ApiError(message, json, response.status);
        }
        if (!response.ok) throw new HTTPError(response.status, text);
        if (options.requireApiResult && ![true, "true", 1, "1"].includes(object["result"] as boolean | string | number)) {
            throw new UnexpectedResponseError(response.status, "unconfirmed-result");
        }
        // 배열/숫자 키 객체는 앱처럼 첫 객체를 꺼냅니다. 보통 객체는 그대로입니다.
        const result = options.list ? list(json) : json && typeof json === "object" ? first(json) : json;
        if (!options.as) return result;
        return options.list ? (result as unknown[]).map((item) => normalize(item, options.as!)) : normalize(result, options.as);
    }

    private buildGetUrl(target: URL, query: Fields): URL {
        for (const [key, value] of Object.entries(query)) {
            if (value != null && !(value instanceof Blob)) target.searchParams.set(key, scalar(value));
        }
        if (target.origin !== HOST.app || !REDIRECTED_PATHS.has(target.pathname)) return target;
        const redirect = new URL("/api/redirect.php", HOST.app);
        // URL 문자열은 퍼센트 인코딩된 ASCII라 btoa로 충분합니다.
        redirect.searchParams.set("hash", btoa(target.toString()));
        return redirect;
    }
}

const scalar = (value: string | number | boolean) => (typeof value === "boolean" ? (value ? "1" : "0") : String(value));

function toSearchParams(fields: Fields): URLSearchParams {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(fields)) {
        if (value != null && !(value instanceof Blob)) params.set(key, scalar(value));
    }
    return params;
}

export function toFormData(fields: Fields): FormData {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
        if (value == null) continue;
        if (value instanceof Blob) form.append(key, value, value instanceof File ? value.name : "blob");
        else form.append(key, scalar(value));
    }
    return form;
}
