// Coerce a closure return value (string / hono-jsx node / anything with a sync
// toString) into an HTML string. Throws on async shells — page shells must be
// synchronous; async data fetching is handled per <Live> region.
export const toHtmlString = (value: unknown): string => {
  if (value === null || value === undefined || value === false) return "";
  if (typeof value === "string") return value;
  const out = (value as { toString(): unknown }).toString();
  if (out instanceof Promise) {
    throw new Error(
      "covara/htmx: page components must render synchronously (no async components in the page shell); data fetching is handled per <Live> region"
    );
  }
  return String(out);
};
