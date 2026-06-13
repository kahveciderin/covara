// Framework-internal namespace for the htmx endpoints Covara generates from a
// page's <Live> regions. Mounted alongside the admin UI / OpenAPI under
// `/__covara`, so it never collides with a user's own routes or a page path.
export const LIVE_PREFIX = "/__covara/live";

// Turn a page path into a stable, URL/DOM-safe slug used to build region ids.
// "/" -> "root", "/todos" -> "todos", "/admin/users" -> "admin-users".
export const slugifyPath = (path: string): string => {
  const slug = path
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "root";
};

// Deterministic region id: page slug + structural position. Stable across
// requests/deploys as long as the page's regions keep their order.
export const regionId = (pagePath: string, index: number): string =>
  `${slugifyPath(pagePath)}-${index}`;

// Make an arbitrary resource id safe to embed in a DOM id / CSS selector while
// staying collision-free (unsafe chars are hex-escaped, not flattened).
export const domSafeId = (id: string | number): string =>
  String(id).replace(/[^A-Za-z0-9_-]/g, (ch) => `-x${ch.charCodeAt(0).toString(16)}-`);

export const containerDomId = (region: string): string => `cv-${region}-list`;

export const templateDomId = (region: string): string => `cv-${region}-tmpl`;

export const rowDomId = (region: string, id: string | number): string =>
  `cv-${region}-${domSafeId(id)}`;

// Generated endpoint URLs (what the c.* attribute helpers point at).
export const regionBaseUrl = (region: string): string => `${LIVE_PREFIX}/${region}`;

export const regionItemUrl = (region: string, id: string | number): string =>
  `${LIVE_PREFIX}/${region}/${encodeURIComponent(String(id))}`;

export const regionSubscribeUrl = (region: string): string =>
  `${LIVE_PREFIX}/${region}/subscribe`;
