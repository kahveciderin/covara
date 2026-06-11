export const escapeHtml = (value: string): string => {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
};

const ALG_TO_HASH: Record<string, string> = {
  RS256: "sha256",
  ES256: "sha256",
  PS256: "sha256",
  RS384: "sha384",
  ES384: "sha384",
  PS384: "sha384",
  RS512: "sha512",
  ES512: "sha512",
  PS512: "sha512",
};

export const algorithmToHash = (algorithm: string): string => {
  return ALG_TO_HASH[algorithm] ?? "sha256";
};

const normalizePath = (pathname: string): string => {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname || "/";
};

export const redirectUriMatches = (registered: string, requested: string): boolean => {
  if (registered === requested) {
    return true;
  }

  let registeredUrl: URL;
  let requestedUrl: URL;
  try {
    registeredUrl = new URL(registered);
    requestedUrl = new URL(requested);
  } catch {
    return false;
  }

  if (registeredUrl.protocol !== requestedUrl.protocol) {
    return false;
  }

  if (registeredUrl.hostname.toLowerCase() !== requestedUrl.hostname.toLowerCase()) {
    return false;
  }

  if (registeredUrl.port !== requestedUrl.port) {
    return false;
  }

  if (normalizePath(registeredUrl.pathname) !== normalizePath(requestedUrl.pathname)) {
    return false;
  }

  const registeredHasQuery = registeredUrl.search.length > 0;
  if (registeredHasQuery && registeredUrl.search !== requestedUrl.search) {
    return false;
  }

  const registeredHasFragment = registeredUrl.hash.length > 0;
  if (registeredHasFragment && registeredUrl.hash !== requestedUrl.hash) {
    return false;
  }

  return true;
};

export const redirectUriAllowed = (registeredUris: string[], requested: string): boolean => {
  return registeredUris.some((registered) => redirectUriMatches(registered, requested));
};
