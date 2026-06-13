import { createRegionContext } from "./context";
import { toHtmlString } from "./render-util";
import type { LiveProps } from "./live";

// A field-recording proxy: every property access returns a sentinel wrapping
// the field name. Rendering the row closure against it yields the row markup
// with sentinels where data would be — i.e. "how a row looks on the server",
// shippable to the client as a {{field}} template so optimistic creates render
// the REAL markup (no ghost). The sentinel uses only [A-Za-z0-9_], so it
// survives HTML text, the domSafeId transform used in element ids, and
// URL-encoding used in hx-* urls — one normalization pass handles all contexts.
const slot = (key: string): string => `__cvslot_${key}__`;

const makeFieldProxy = (): Record<string, unknown> =>
  new Proxy(
    {},
    {
      get(_t, prop) {
        if (typeof prop !== "string") return "";
        if (prop === "toString") return () => "";
        return slot(prop);
      },
    }
  );

export const buildRowTemplate = (region: { regionId: string; props: LiveProps }): string => {
  const c = createRegionContext(region.regionId);
  const html = toHtmlString(region.props.render(makeFieldProxy(), c));
  return html.replace(/__cvslot_(\w+?)__/g, "{{$1}}");
};

// Pure {{field}} substitution with HTML escaping. The client runtime mirrors
// this; kept here so the substitution contract is unit-tested.
export const applyRowTemplate = (
  template: string,
  values: Record<string, unknown>
): string =>
  template.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => {
    const v = values[key];
    if (v === null || v === undefined) return "";
    return String(v)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  });
