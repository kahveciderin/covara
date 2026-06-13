import { escapeAttr } from "@/shared/escape";
import {
  containerDomId,
  regionBaseUrl,
  regionItemUrl,
  regionSubscribeUrl,
  rowDomId,
  templateDomId,
} from "./ids";

export type Attrs = Record<string, string>;
export type LiveMode = "live" | "page";

// Render an attribute object to an HTML attribute string (leading space when
// non-empty). Values are attribute-escaped; used when the framework builds a
// default container/element rather than the developer's JSX.
export const attrsToHtml = (attrs: Attrs): string =>
  Object.entries(attrs)
    .map(([k, v]) => ` ${k}="${escapeAttr(v)}"`)
    .join("");

// The cursor-driven "load more" control for a paginated ("page" mode) region.
// It replaces itself (outerHTML) with the next page's rows + the following
// control, so the list grows in order; it vanishes when there is no next page.
export const loadMoreButtonHtml = (
  region: string,
  cursor: string,
  label = "Load more"
): string => {
  const attrs: Attrs = {
    type: "button",
    "data-cv-more": "",
    "hx-get": `${regionBaseUrl(region)}?cursor=${encodeURIComponent(cursor)}`,
    "hx-target": "this",
    "hx-swap": "outerHTML",
  };
  return `<button${attrsToHtml(attrs)}>${escapeAttr(label)}</button>`;
};

// The boring attribute-spread helpers handed to a page's create/container/row
// closures. Covara generates the live wiring; the developer spreads these onto
// their own plain JSX/HTML elements. No per-interaction components.
export interface RegionContext {
  readonly regionId: string;
  // The list container: stable id + the htmx SSE connection for live updates.
  container(extra?: Attrs): Attrs;
  // A row wrapper: stable DOM id (so OOB swaps target it) + the raw id.
  row(id: string | number, extra?: Attrs): Attrs;
  // A create control (usually a <form>): posts to the region, appends the row.
  create(extra?: Attrs): Attrs;
  // An update control (usually a <form>): patches the row, replaces it in place.
  update(id: string | number, extra?: Attrs): Attrs;
  // A delete control (usually a <button>): deletes the row, removes it.
  delete(id: string | number, extra?: Attrs): Attrs;
}

const merge = (base: Attrs, extra?: Attrs): Attrs =>
  extra ? { ...base, ...extra } : base;

export const createRegionContext = (
  region: string,
  opts: { mode?: LiveMode } = {}
): RegionContext => ({
  regionId: region,
  container: (extra) =>
    merge(
      {
        id: containerDomId(region),
        "data-cv-region": region,
        "data-cv-sse": regionSubscribeUrl(region),
        "data-cv-list": regionBaseUrl(region),
        "data-cv-template": templateDomId(region),
        "data-cv-mode": opts.mode ?? "live",
      },
      extra
    ),
  row: (id, extra) =>
    merge({ id: rowDomId(region, id), "data-covara-id": String(id) }, extra),
  create: (extra) =>
    merge(
      {
        "hx-post": regionBaseUrl(region),
        // The new row is inserted once, by the region's live SSE "added" event
        // (the same path every connected client uses) — so the create response
        // itself is not swapped in. This avoids a duplicate/phantom row.
        "hx-swap": "none",
      },
      extra
    ),
  update: (id, extra) =>
    merge(
      {
        "hx-patch": regionItemUrl(region, id),
        "hx-target": `#${rowDomId(region, id)}`,
        "hx-swap": "outerHTML",
      },
      extra
    ),
  delete: (id, extra) =>
    merge(
      {
        "hx-delete": regionItemUrl(region, id),
        "hx-target": `#${rowDomId(region, id)}`,
        "hx-swap": "outerHTML",
      },
      extra
    ),
});
