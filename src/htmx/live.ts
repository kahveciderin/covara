import { raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import { regionId } from "./ids";
import type { RegionContext } from "./context";

// A renderable returned by a page's closures: a string, a hono/jsx node, or
// anything with a sync toString(). The page renderer coerces via String().
export type Renderable = unknown;

export interface LiveQuery {
  filter?: string;
  orderBy?: string;
  limit?: number;
}

export interface LiveProps<Row extends Record<string, unknown> = Record<string, unknown>> {
  // The mounted resource: a Drizzle table (resolved to its name/mount by the
  // page renderer) or an explicit resource name/path string.
  resource: unknown;
  // Display query for this region. NOTE: this is a UX refinement, not a
  // security boundary — row-level access must come from the resource's `auth`
  // scope (enforced on every generated endpoint).
  query?: LiveQuery;
  // "live" (default): the window is unbounded; new rows entering scope are
  //   appended live, and `query.limit` just caps the first render.
  // "page": paginated/strict; renders a "load more" control (cursor-driven) and
  //   live updates only patch/remove rows already loaded — new rows are not
  //   auto-injected (they appear when you load their page). Use with `limit`.
  mode?: "live" | "page";
  // Label for the generated load-more control in "page" mode (default "Load more").
  moreLabel?: string;
  // The resource's id field (default "id").
  idField?: string;
  // Optional create control (usually a <form> spreading c.create()).
  create?: (c: RegionContext) => Renderable;
  // Optional container wrapping the rows (spreads c.container()). When omitted
  // the renderer emits a default <div> with the container attributes.
  container?: (rows: Renderable, c: RegionContext) => Renderable;
  // Required per-row renderer (spreads c.row(id)).
  render: (row: Row, c: RegionContext) => Renderable;
  // Optional empty-state when the region has no rows.
  empty?: (c: RegionContext) => Renderable;
}

export interface LiveAggregateProps {
  resource: unknown;
  query?: LiveQuery;
  groupBy?: string[];
  render: (data: unknown, c: RegionContext) => Renderable;
}

export interface CollectedRegion {
  index: number;
  regionId: string;
  kind: "live" | "aggregate";
  token: string;
  props: LiveProps | LiveAggregateProps;
}

interface Collector {
  pagePath: string;
  regions: CollectedRegion[];
}

// Render-scoped collector. Safe as a module global because a page render is
// SYNCHRONOUS: <Live> returns a token string immediately (data fetching happens
// later, outside JSX), so toString() never yields and no two renders interleave
// while the collector is set.
let activeCollector: Collector | null = null;

export const collectRegions = (
  pagePath: string,
  renderSync: () => string
): { html: string; regions: CollectedRegion[] } => {
  const collector: Collector = { pagePath, regions: [] };
  const previous = activeCollector;
  activeCollector = collector;
  try {
    const html = renderSync();
    return { html, regions: collector.regions };
  } finally {
    activeCollector = previous;
  }
};

const registerRegion = (
  kind: CollectedRegion["kind"],
  props: LiveProps | LiveAggregateProps
): HtmlEscapedString => {
  const collector = activeCollector;
  if (!collector) {
    // Rendered outside a page render (e.g. a stray <Live> in a fragment); emit
    // nothing rather than throwing.
    return raw("");
  }
  const index = collector.regions.length;
  const rid = regionId(collector.pagePath, index);
  const token = `<!--cv-region:${rid}-->`;
  collector.regions.push({ index, regionId: rid, kind, token, props });
  return raw(token);
};

// hono/jsx function components. Returned token is replaced with the region's
// rendered HTML in the assemble phase (see renderPage).
export const Live = <Row extends Record<string, unknown> = Record<string, unknown>>(
  props: LiveProps<Row>
): HtmlEscapedString => registerRegion("live", props as LiveProps);

export const LiveAggregate = (props: LiveAggregateProps): HtmlEscapedString =>
  registerRegion("aggregate", props);
