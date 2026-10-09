import type { Hono } from "hono";

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Headers;
  status: number;
}

// A browser-like fetch into a Hono app: keeps a cookie jar, sends it on every
// request, and mirrors non-HttpOnly cookies into document.cookie so client code
// reads them exactly as it would in a browser.
export const createCookieFetch = (app: Hono) => {
  const jar = new Map<string, { value: string; httpOnly: boolean }>();
  const requests: RecordedRequest[] = [];

  const syncDocument = (name: string, value: string | null) => {
    if (typeof document === "undefined") return;
    document.cookie =
      value === null
        ? `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`
        : `${name}=${value}; path=/`;
  };

  const storeSetCookie = (header: string) => {
    const [pair, ...attrs] = header.split(";").map((p) => p.trim());
    const eq = pair.indexOf("=");
    const name = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    const lower = attrs.map((a) => a.toLowerCase());
    const httpOnly = lower.includes("httponly");
    const expired =
      value === "" ||
      lower.some((a) => a === "max-age=0" || a.startsWith("expires=thu, 01 jan 1970"));
    if (expired) {
      jar.delete(name);
      if (!httpOnly) syncDocument(name, null);
      return;
    }
    jar.set(name, { value, httpOnly });
    if (!httpOnly) syncDocument(name, value);
  };

  const fetchImpl = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init.headers);
    if (jar.size > 0) {
      headers.set(
        "cookie",
        [...jar.entries()].map(([name, { value }]) => `${name}=${value}`).join("; ")
      );
    }
    const method = (init.method ?? "GET").toUpperCase();
    const res = await app.request(url.pathname + url.search, {
      method,
      headers,
      body: init.body,
    });
    for (const header of res.headers.getSetCookie()) storeSetCookie(header);
    requests.push({ method, path: url.pathname, headers, status: res.status });
    return res;
  };

  const reset = () => {
    for (const [name, { httpOnly }] of jar) if (!httpOnly) syncDocument(name, null);
    jar.clear();
    requests.length = 0;
  };

  return { fetch: fetchImpl as typeof fetch, jar, requests, reset };
};
