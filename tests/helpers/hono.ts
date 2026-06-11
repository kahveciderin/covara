import { Hono, type MiddlewareHandler } from "hono";
import { errorHandler, notFoundHandler } from "@/middleware/error";
import type { UserContext } from "@/resource/types";

export interface TestAppOptions {
  user?: Partial<UserContext> | null;
  middleware?: MiddlewareHandler[];
}

export const testUser = (overrides: Partial<UserContext> = {}): UserContext => ({
  id: "test-user",
  email: "test@test.com",
  name: "Test User",
  image: null,
  emailVerified: null,
  sessionId: "test-session",
  sessionExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
  ...overrides,
});

export const injectUser = (user: Partial<UserContext> | null): MiddlewareHandler => {
  return async (c, next) => {
    if (user !== null) {
      c.set("user", testUser(user));
    }
    await next();
  };
};

export const createTestApp = (options: TestAppOptions = {}): Hono => {
  const app = new Hono();
  app.onError(errorHandler);
  app.notFound(notFoundHandler);
  if (options.user !== undefined) {
    app.use("*", injectUser(options.user));
  }
  for (const mw of options.middleware ?? []) {
    app.use("*", mw);
  }
  return app;
};

export interface JsonResponse<T = any> {
  status: number;
  body: T;
  headers: Headers;
  res: Response;
}

export const request = async <T = any>(
  app: Hono,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<JsonResponse<T>> => {
  const init: RequestInit = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["content-type"] = "application/json";
  }
  const res = await app.request(path, init);
  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: res.status, body: parsed as T, headers: res.headers, res };
};

export const get = <T = any>(app: Hono, path: string, headers?: Record<string, string>) =>
  request<T>(app, "GET", path, undefined, headers);
export const post = <T = any>(app: Hono, path: string, body?: unknown, headers?: Record<string, string>) =>
  request<T>(app, "POST", path, body, headers);
export const patch = <T = any>(app: Hono, path: string, body?: unknown, headers?: Record<string, string>) =>
  request<T>(app, "PATCH", path, body, headers);
export const put = <T = any>(app: Hono, path: string, body?: unknown, headers?: Record<string, string>) =>
  request<T>(app, "PUT", path, body, headers);
export const del = <T = any>(app: Hono, path: string, body?: unknown, headers?: Record<string, string>) =>
  request<T>(app, "DELETE", path, body, headers);

export interface SSEEvent {
  id?: string;
  event?: string;
  data: any;
  raw: string;
}

export class SSECollector {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private decoder = new TextDecoder();
  private buffer = "";
  private queue: SSEEvent[] = [];
  private waiters: ((event: SSEEvent | null) => void)[] = [];
  private done = false;
  private abortController: AbortController;
  readonly events: SSEEvent[] = [];

  private constructor(response: Response, abortController: AbortController) {
    if (!response.body) {
      throw new Error("SSE response has no body");
    }
    this.abortController = abortController;
    this.reader = response.body.getReader();
    void this.pump();
  }

  static async connect(
    app: Hono,
    path: string,
    headers: Record<string, string> = {}
  ): Promise<{ collector: SSECollector; response: Response }> {
    const abortController = new AbortController();
    const response = await app.request(path, {
      method: "GET",
      headers,
      signal: abortController.signal,
    });
    if (response.status !== 200) {
      abortController.abort();
      return { collector: null as unknown as SSECollector, response };
    }
    return { collector: new SSECollector(response, abortController), response };
  }

  private async pump(): Promise<void> {
    try {
      for (;;) {
        const { done, value } = await this.reader.read();
        if (done) break;
        this.buffer += this.decoder.decode(value, { stream: true });
        this.drainBuffer();
      }
    } catch {
      // stream aborted/closed
    } finally {
      this.done = true;
      for (const waiter of this.waiters.splice(0)) {
        waiter(null);
      }
    }
  }

  private drainBuffer(): void {
    let idx: number;
    while ((idx = this.buffer.indexOf("\n\n")) !== -1) {
      const frame = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      const event = this.parseFrame(frame);
      if (event) {
        this.events.push(event);
        const waiter = this.waiters.shift();
        if (waiter) {
          waiter(event);
        } else {
          this.queue.push(event);
        }
      }
    }
  }

  private parseFrame(frame: string): SSEEvent | null {
    const lines = frame.split("\n");
    let id: string | undefined;
    let eventName: string | undefined;
    const dataLines: string[] = [];
    let isComment = true;

    for (const line of lines) {
      if (line.startsWith(":")) continue;
      isComment = false;
      if (line.startsWith("id:")) id = line.slice(3).trim();
      else if (line.startsWith("event:")) eventName = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }

    if (isComment) return null;

    const rawData = dataLines.join("\n");
    let data: any = rawData;
    try {
      data = JSON.parse(rawData);
    } catch {
      // keep as string
    }
    return { id, event: eventName, data, raw: frame };
  }

  async next(timeoutMs = 2000): Promise<SSEEvent | null> {
    const queued = this.queue.shift();
    if (queued) return queued;
    if (this.done) return null;

    return new Promise<SSEEvent | null>((resolve) => {
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i !== -1) this.waiters.splice(i, 1);
        resolve(null);
      }, timeoutMs);
      const waiter = (event: SSEEvent | null) => {
        clearTimeout(timer);
        resolve(event);
      };
      this.waiters.push(waiter);
    });
  }

  async collect(count: number, timeoutMs = 2000): Promise<SSEEvent[]> {
    const collected: SSEEvent[] = [];
    const deadline = Date.now() + timeoutMs;
    while (collected.length < count) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const event = await this.next(remaining);
      if (!event) break;
      collected.push(event);
    }
    return collected;
  }

  async waitFor(
    predicate: (event: SSEEvent) => boolean,
    timeoutMs = 2000
  ): Promise<SSEEvent | null> {
    for (const existing of [...this.queue]) {
      if (predicate(existing)) {
        this.queue.splice(this.queue.indexOf(existing), 1);
        return existing;
      }
    }
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      const event = await this.next(remaining);
      if (!event) return null;
      if (predicate(event)) return event;
    }
  }

  close(): void {
    this.abortController.abort();
    void this.reader.cancel().catch(() => {});
  }
}

export const flushAsync = async (ms = 20): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};
