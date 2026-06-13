import type { Context } from "hono";
import { htmxScript } from "@/ui/html/client/htmx-vendor";
import { covaraRuntimeScript } from "./client/runtime";

export { escapeHtml, escapeAttr } from "@/shared/escape";
export {
  LIVE_PREFIX,
  slugifyPath,
  regionId,
  domSafeId,
  containerDomId,
  rowDomId,
  regionBaseUrl,
  regionItemUrl,
  regionSubscribeUrl,
} from "./ids";
export { createRegionContext, attrsToHtml } from "./context";
export type { RegionContext, Attrs } from "./context";
export { Live, LiveAggregate } from "./live";
export type {
  LiveProps,
  LiveAggregateProps,
  LiveQuery,
  Renderable,
} from "./live";
export type { PageComponent, PageContext } from "./server";

// The full client bundle (vendored htmx core + the covara live runtime). Served
// automatically at `/__covara/live/_runtime.js` once a page is registered; this
// helper lets you serve/inline it yourself if needed.
export const htmxBundle = (): string => `${htmxScript}\n${covaraRuntimeScript}`;

export const serveHtmxBundle = () => (c: Context) => {
  c.header("Content-Type", "application/javascript; charset=utf-8");
  return c.body(htmxBundle());
};
