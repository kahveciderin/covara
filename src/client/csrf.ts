// Double-submit CSRF, matching the server's `createCsrfMiddleware`: the server
// sets a JS-readable token cookie and requires unsafe requests to echo it in a
// header. Only readable in a browser, and only for a same-site cookie.
export interface CsrfConfig {
  cookieName?: string;
  headerName?: string;
}

export const DEFAULT_CSRF_COOKIE = "csrf_token";
export const DEFAULT_CSRF_HEADER = "X-CSRF-Token";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export const readCookie = (name: string): string | null => {
  if (typeof document === "undefined" || typeof document.cookie !== "string") return null;
  for (const part of document.cookie.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
};

export const readCsrfToken = (config?: CsrfConfig | false): string | null =>
  config === false ? null : readCookie(config?.cookieName ?? DEFAULT_CSRF_COOKIE);

export const csrfHeaders = (
  method: string,
  config?: CsrfConfig | false
): Record<string, string> => {
  if (config === false || !UNSAFE_METHODS.has(method.toUpperCase())) return {};
  const token = readCsrfToken(config);
  return token ? { [config?.headerName ?? DEFAULT_CSRF_HEADER]: token } : {};
};

// True when a browser could send a CSRF header but has no token cookie yet, i.e.
// a safe request to the server should be made first to have one issued.
export const needsCsrfToken = (config?: CsrfConfig | false): boolean =>
  config !== false && typeof document !== "undefined" && readCsrfToken(config) === null;
