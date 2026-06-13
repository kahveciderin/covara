import { formatSSE } from "@/server/sse";
import type { EventRenderer } from "@/resource/subscription";
import { createRegionContext } from "./context";
import { rowDomId } from "./ids";
import { toHtmlString } from "./render-util";
import type { LiveProps } from "./live";

export interface RegionRenderTarget {
  regionId: string;
  idField: string;
  props: LiveProps;
}

// Builds the per-handler renderer that turns subscription events into named SSE
// frames the covara client runtime applies to the DOM:
//   added/existing -> "added" event, data = the rendered row HTML (upsert by id)
//   changed        -> "changed" event, data = the rendered row HTML (replace by id)
//   removed        -> "removed" event, data = the row's DOM id (remove)
//   invalidate     -> "invalidate" event (client refetches the list)
// Rows are rendered through the page's own row closure, so the live markup is
// identical to the SSR markup.
// For aggregate regions: every row change emits a single "invalidate" so the
// client refetches the (recomputed) aggregate fragment. Reuses the row
// subscribe + renderer hook — no aggregate-specific server change needed.
export const makeInvalidateRenderer = (): EventRenderer => () =>
  formatSSE({ event: "invalidate", data: "" });

export const makeRegionEventRenderer = (region: RegionRenderTarget): EventRenderer => {
  const c = createRegionContext(region.regionId);
  const renderRow = (row: Record<string, unknown>): string =>
    toHtmlString(region.props.render(row, c));

  return (event) => {
    switch (event.type) {
      case "existing":
      case "added":
        return formatSSE({ event: "added", id: event.seq, data: renderRow(event.object) });
      case "changed":
        return formatSSE({ event: "changed", id: event.seq, data: renderRow(event.object) });
      case "removed":
        return formatSSE({
          event: "removed",
          id: event.seq,
          data: rowDomId(region.regionId, event.objectId),
        });
      case "invalidate":
        return formatSSE({ event: "invalidate", data: event.reason ?? "" });
      default:
        return "";
    }
  };
};
