import {
  TransportConfig,
  TransportRequest,
  TransportResponse,
  ErrorResponse,
} from "./types";
import { reviveDates } from "./dates";

export interface Transport {
  request<T>(req: TransportRequest): Promise<TransportResponse<T>>;
  createEventSource(path: string, params?: Record<string, string>): EventSource;
  setHeader(name: string, value: string): void;
  removeHeader(name: string): void;
}

export class FetchTransport implements Transport {
  private config: TransportConfig;
  private headers: Record<string, string>;

  constructor(config: TransportConfig) {
    this.config = config;
    this.headers = { ...config.headers };
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
    try {
      return await this.executeRequest<T>(req);
    } catch (error) {
      if (
        error instanceof TransportError &&
        error.status === 401 &&
        this.config.refreshAuth &&
        !req.headers?.["X-Concave-Retried"]
      ) {
        await this.config.refreshAuth();
        return this.executeRequest<T>({
          ...req,
          headers: { ...req.headers, "X-Concave-Retried": "1" },
        });
      }
      throw error;
    }
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
    delete (headers as Record<string, string>)["X-Concave-Retried"];

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
          errorData?.error?.details
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
    public details?: unknown
  ) {
    super(message);
    this.name = "TransportError";
  }

  isNotFound(): boolean {
    return this.status === 404;
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

export const createTransport = (config: TransportConfig): Transport => {
  return new FetchTransport(config);
};
