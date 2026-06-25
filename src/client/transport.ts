import {
  TransportConfig,
  TransportRequest,
  TransportResponse,
  ErrorResponse,
} from "./types";
import { reviveDates } from "./dates";
import { solvePowChallenge } from "./pow";
import type { CaptchaSolver } from "./captcha";
import type { PowAlgorithm } from "@/pow/core";

const CHALLENGE_TYPE_HEADER = "Covara-Challenge-Type";
const POW_CHALLENGE_HEADER = "Covara-PoW-Challenge";
const POW_DIFFICULTY_HEADER = "Covara-PoW-Difficulty";
const POW_ALGORITHM_HEADER = "Covara-PoW-Algorithm";
const POW_NONCE_HEADER = "Covara-PoW-Nonce";
const CAPTCHA_PROVIDER_HEADER = "Covara-Captcha-Provider";
const CAPTCHA_SITEKEY_HEADER = "Covara-Captcha-Sitekey";
const CAPTCHA_ACTION_HEADER = "Covara-Captcha-Action";
const CAPTCHA_TOKEN_HEADER = "Covara-Captcha-Token";
const DEFAULT_POW_MAX_ATTEMPTS = 3;
const DEFAULT_CAPTCHA_MAX_ATTEMPTS = 2;

export interface Transport {
  request<T>(req: TransportRequest): Promise<TransportResponse<T>>;
  createEventSource(path: string, params?: Record<string, string>): EventSource;
  setHeader(name: string, value: string): void;
  removeHeader(name: string): void;
  setCaptchaSolver(solver: CaptchaSolver | undefined): void;
}

export class FetchTransport implements Transport {
  private config: TransportConfig;
  private headers: Record<string, string>;
  private captchaSolver?: CaptchaSolver;

  constructor(config: TransportConfig) {
    this.config = config;
    this.headers = { ...config.headers };
    this.captchaSolver = config.captcha?.solve;
  }

  setCaptchaSolver(solver: CaptchaSolver | undefined): void {
    this.captchaSolver = solver;
  }

  setHeader(name: string, value: string): void {
    this.headers[name] = value;
  }

  removeHeader(name: string): void {
    delete this.headers[name];
  }

  private buildUrl(path: string, params?: Record<string, string | number | boolean | string[]>): string {
    const url = new URL(path, this.config.baseUrl);

    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null) continue;

        if (Array.isArray(value)) {
          url.searchParams.set(key, value.join(","));
        } else {
          url.searchParams.set(key, String(value));
        }
      }
    }

    return url.toString();
  }

  async request<T>(req: TransportRequest): Promise<TransportResponse<T>> {
    let current = req;
    let didRefresh = false;
    let powAttempts = 0;
    let captchaAttempts = 0;
    const powEnabled = this.config.pow?.enabled !== false;
    const powMaxAttempts = this.config.pow?.maxAttempts ?? DEFAULT_POW_MAX_ATTEMPTS;
    const captchaMaxAttempts = this.config.captcha?.maxAttempts ?? DEFAULT_CAPTCHA_MAX_ATTEMPTS;

    // Loop so a single request can transparently recover from a 401 (auth
    // refresh, once) and one or more 428 challenges (proof-of-work, solved by
    // CPU; or CAPTCHA, solved via the registered solver). Callers never observe
    // these — the request just takes longer.
    while (true) {
      try {
        return await this.executeRequest<T>(current);
      } catch (error) {
        if (
          error instanceof TransportError &&
          error.status === 401 &&
          this.config.refreshAuth &&
          !didRefresh &&
          !current.headers?.["X-Covara-Retried"]
        ) {
          didRefresh = true;
          await this.config.refreshAuth();
          current = {
            ...current,
            headers: { ...current.headers, "X-Covara-Retried": "1" },
          };
          continue;
        }

        if (error instanceof TransportError && error.status === 428) {
          const type = challengeType(error);

          if (type === "pow" && powEnabled && powAttempts < powMaxAttempts) {
            const solved = await this.solvePow(error, current);
            if (solved) {
              powAttempts++;
              current = solved;
              continue;
            }
          }

          if (type === "captcha" && this.captchaSolver && captchaAttempts < captchaMaxAttempts) {
            const solved = await this.solveCaptcha(error, current);
            if (solved) {
              captchaAttempts++;
              current = solved;
              continue;
            }
          }
        }

        throw error;
      }
    }
  }

  private async solveCaptcha(
    error: TransportError,
    req: TransportRequest
  ): Promise<TransportRequest | null> {
    const provider = error.headers?.get(CAPTCHA_PROVIDER_HEADER);
    if (!provider || !this.captchaSolver) return null;
    const token = await this.captchaSolver({
      provider,
      siteKey: error.headers?.get(CAPTCHA_SITEKEY_HEADER) ?? undefined,
      action: error.headers?.get(CAPTCHA_ACTION_HEADER) ?? undefined,
    });
    if (!token) return null;
    return {
      ...req,
      headers: { ...req.headers, [CAPTCHA_TOKEN_HEADER]: token },
    };
  }

  private async solvePow(
    error: TransportError,
    req: TransportRequest
  ): Promise<TransportRequest | null> {
    const challenge = error.headers?.get(POW_CHALLENGE_HEADER);
    const difficulty = Number(error.headers?.get(POW_DIFFICULTY_HEADER));
    const algorithm = (error.headers?.get(POW_ALGORITHM_HEADER) ?? "sha256") as PowAlgorithm;
    if (!challenge || !Number.isFinite(difficulty) || difficulty <= 0) {
      return null;
    }
    const nonce = await solvePowChallenge(challenge, difficulty, algorithm);
    return {
      ...req,
      headers: {
        ...req.headers,
        [POW_CHALLENGE_HEADER]: challenge,
        [POW_NONCE_HEADER]: nonce,
      },
    };
  }

  private async executeRequest<T>(req: TransportRequest): Promise<TransportResponse<T>> {
    const url = this.buildUrl(req.path, req.params);

    const controller = new AbortController();
    const timeout = req.timeoutMs ?? this.config.timeout;
    const timeoutId =
      timeout && timeout > 0
        ? setTimeout(() => controller.abort(), timeout)
        : null;

    const signal = this.combineSignals(controller.signal, req.signal);

    const headers = {
      "Content-Type": "application/json",
      ...this.headers,
      ...req.headers,
    };
    delete (headers as Record<string, string>)["X-Covara-Retried"];

    try {
      const response = await fetch(url, {
        method: req.method,
        headers,
        body: req.body ? JSON.stringify(req.body) : undefined,
        credentials: this.config.credentials,
        signal,
      });

      const parsed = await this.parseResponse<T>(response);
      const data = response.ok ? this.maybeReviveDates(req, parsed) : parsed;

      if (!response.ok) {
        const errorData = data as unknown as ErrorResponse;
        throw new TransportError(
          errorData?.error?.message ?? `HTTP ${response.status}`,
          response.status,
          errorData?.error?.code ?? "HTTP_ERROR",
          errorData?.error?.details,
          response.headers
        );
      }

      return {
        data,
        status: response.status,
        headers: response.headers,
      };
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  private combineSignals(
    internal: AbortSignal,
    external?: AbortSignal
  ): AbortSignal {
    if (!external) return internal;

    const anyFn = (AbortSignal as unknown as {
      any?: (signals: AbortSignal[]) => AbortSignal;
    }).any;
    if (typeof anyFn === "function") {
      return anyFn([internal, external]);
    }

    const combined = new AbortController();
    const onAbort = (source: AbortSignal) => () => {
      combined.abort((source as { reason?: unknown }).reason);
    };

    if (external.aborted) {
      combined.abort((external as { reason?: unknown }).reason);
    } else if (internal.aborted) {
      combined.abort((internal as { reason?: unknown }).reason);
    } else {
      external.addEventListener("abort", onAbort(external), { once: true });
      internal.addEventListener("abort", onAbort(internal), { once: true });
    }

    return combined.signal;
  }

  private maybeReviveDates<T>(req: TransportRequest, data: T): T {
    const setting = this.config.parseDates;
    if (!setting || data == null || typeof data !== "object") {
      return data;
    }
    if (setting === true) {
      return reviveDates(data, req.dateFields);
    }
    const fields = req.dateFields ?? setting[req.path];
    if (!fields) {
      return data;
    }
    return reviveDates(data, fields);
  }

  private async parseResponse<T>(response: Response): Promise<T> {
    const contentType = response.headers.get("content-type");

    if (contentType?.includes("application/json")) {
      return response.json();
    }

    if (response.status === 204) {
      return undefined as T;
    }

    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      return text as unknown as T;
    }
  }

  /**
   * Create an EventSource for server-sent events.
   * Note: EventSource is not available in React Native by default.
   * For React Native, use a polyfill like 'react-native-sse' or
   * configure a custom EventSource via setEventSourceConstructor().
   */
  createEventSource(path: string, params?: Record<string, string>): EventSource {
    const url = this.buildUrl(path, params);

    const EventSourceImpl = this.getEventSourceConstructor();
    if (!EventSourceImpl) {
      throw new Error(
        "EventSource is not available. For React Native, install a polyfill like " +
        "'react-native-sse' and call transport.setEventSourceConstructor(EventSource)."
      );
    }

    return new EventSourceImpl(url, {
      withCredentials: this.config.credentials === "include",
    });
  }

  private eventSourceConstructor?: typeof EventSource;

  /**
   * Set a custom EventSource constructor. Useful for React Native with polyfills.
   * @example
   * import EventSource from 'react-native-sse';
   * transport.setEventSourceConstructor(EventSource);
   */
  setEventSourceConstructor(constructor: typeof EventSource): void {
    this.eventSourceConstructor = constructor;
  }

  private getEventSourceConstructor(): typeof EventSource | undefined {
    if (this.eventSourceConstructor) {
      return this.eventSourceConstructor;
    }
    if (typeof EventSource !== "undefined") {
      return EventSource;
    }
    return undefined;
  }
}

export class TransportError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string,
    public details?: unknown,
    public headers?: Headers
  ) {
    super(message);
    this.name = "TransportError";
  }

  isNotFound(): boolean {
    return this.status === 404;
  }

  isProofOfWorkRequired(): boolean {
    return this.status === 428 && challengeType(this) === "pow";
  }

  isCaptchaRequired(): boolean {
    return this.status === 428 && challengeType(this) === "captcha";
  }

  get captchaProvider(): string | undefined {
    return this.headers?.get(CAPTCHA_PROVIDER_HEADER) ?? undefined;
  }

  get captchaSiteKey(): string | undefined {
    return this.headers?.get(CAPTCHA_SITEKEY_HEADER) ?? undefined;
  }

  get captchaAction(): string | undefined {
    return this.headers?.get(CAPTCHA_ACTION_HEADER) ?? undefined;
  }

  isUnauthorized(): boolean {
    return this.status === 401;
  }

  isForbidden(): boolean {
    return this.status === 403;
  }

  isValidationError(): boolean {
    return this.status === 400;
  }

  isRateLimited(): boolean {
    return this.status === 429;
  }

  isServerError(): boolean {
    return this.status >= 500;
  }
}

/**
 * Determine which kind of 428 challenge a response carries: the explicit
 * `Covara-Challenge-Type` header, falling back to which challenge headers are
 * present.
 */
const challengeType = (error: TransportError): "pow" | "captcha" | null => {
  const declared = error.headers?.get(CHALLENGE_TYPE_HEADER);
  if (declared === "pow" || declared === "captcha") return declared;
  if (error.headers?.get(CAPTCHA_PROVIDER_HEADER)) return "captcha";
  if (error.headers?.get(POW_CHALLENGE_HEADER)) return "pow";
  return null;
};

export const createTransport = (config: TransportConfig): Transport => {
  return new FetchTransport(config);
};
