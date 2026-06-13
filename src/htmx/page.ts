import { raw } from "hono/html";
import { attrsToHtml, createRegionContext, loadMoreButtonHtml } from "./context";
import { templateDomId } from "./ids";
import { toHtmlString } from "./render-util";
import { buildRowTemplate } from "./template-gen";
import {
  collectRegions,
  type CollectedRegion,
  type LiveAggregateProps,
  type LiveProps,
  type Renderable,
} from "./live";

export interface PageResult {
  items: Record<string, unknown>[];
  nextCursor?: string | null;
  hasMore?: boolean;
}

export interface RenderPageOptions {
  pagePath: string;
  ctx: unknown;
  // Fetch a page of rows for a live region (already scoped/masked by the
  // resource), plus the pagination cursor so "page" mode can render load-more.
  fetchRows: (region: CollectedRegion) => Promise<PageResult>;
  // Fetch the aggregate payload for an aggregate region.
  fetchAggregate?: (region: CollectedRegion) => Promise<unknown>;
}

const renderLiveRegion = async (
  region: CollectedRegion,
  options: RenderPageOptions
): Promise<string> => {
  const props = region.props as LiveProps;
  const mode = props.mode ?? "live";
  const c = createRegionContext(region.regionId, { mode });

  const { items, nextCursor, hasMore } = await options.fetchRows(region);
  let body =
    items.length > 0
      ? items.map((row) => toHtmlString(props.render(row, c))).join("")
      : props.empty
        ? toHtmlString(props.empty(c))
        : "";

  // In "page" mode, append the cursor-driven load-more control inside the
  // container so it grows in order and the control advances itself.
  if (mode === "page" && hasMore && nextCursor) {
    body += loadMoreButtonHtml(region.regionId, nextCursor, props.moreLabel);
  }

  const container = props.container
    ? toHtmlString(props.container(raw(body), c))
    : `<div${attrsToHtml(c.container())}>${body}</div>`;

  const create = props.create ? toHtmlString(props.create(c)) : "";
  // Ship the server-derived row template so the client can render optimistic
  // rows that match the server's markup (no ghost). Inert until the runtime
  // uses it; <template> content is not executed by htmx.
  const template = `<template id="${templateDomId(region.regionId)}">${buildRowTemplate({
    regionId: region.regionId,
    props,
  })}</template>`;
  return create + container + template;
};

const renderAggregateRegion = async (
  region: CollectedRegion,
  options: RenderPageOptions
): Promise<string> => {
  const props = region.props as LiveAggregateProps;
  const c = createRegionContext(region.regionId);
  const data = options.fetchAggregate ? await options.fetchAggregate(region) : null;
  // Wrap in a live container: the client connects its SSE and replaces the
  // inner aggregate fragment whenever the resource changes.
  return `<div${attrsToHtml(c.container())}>${toHtmlString(props.render(data, c))}</div>`;
};

// Render a registered page: a synchronous collect pass gathers the <Live>
// regions (each leaves a placeholder token), then an async assemble pass fetches
// each region's data, renders it via the page's own closures, and substitutes
// the token. Live updates/optimism use the same closures via the generated
// endpoints, so the markup has a single source of truth.
export const renderPage = async (
  component: (ctx: any) => Renderable,
  options: RenderPageOptions
): Promise<string> => {
  const { html, regions } = collectRegions(options.pagePath, () =>
    toHtmlString(component(options.ctx))
  );

  let output = html;
  for (const region of regions) {
    const replacement =
      region.kind === "aggregate"
        ? await renderAggregateRegion(region, options)
        : await renderLiveRegion(region, options);
    output = output.replace(region.token, () => replacement);
  }
  return output;
};
