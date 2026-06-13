import { Hono, type Context } from "hono";
import { getTableName, type Table } from "drizzle-orm";
import { getUser } from "@/server/context";
import { stashRenderer } from "@/resource/subscription";
import { createResourceFilter } from "@/resource/filter";
import { renderPage } from "./page";
import {
  collectRegions,
  type CollectedRegion,
  type LiveAggregateProps,
  type LiveProps,
} from "./live";
import { createRegionContext, loadMoreButtonHtml } from "./context";
import { toHtmlString } from "./render-util";
import { coerceFormBody } from "./forms";
import { makeInvalidateRenderer, makeRegionEventRenderer } from "./sse-render";
import { LIVE_PREFIX, slugifyPath } from "./ids";

export interface PageContext {
  user: unknown;
  req: Context["req"];
  c: Context;
}

export type PageComponent = (ctx: PageContext) => unknown;

export interface ResourceInfo {
  mountPath: string;
  idField: string;
}

export interface LiveSupport {
  registerResource(tableName: string, info: ResourceInfo): void;
  registerPage(path: string, component: PageComponent): void;
}

type AppLike = Hono & { request: Hono["request"] };

interface ResolvedRegion {
  region: CollectedRegion;
  props: LiveProps | LiveAggregateProps;
  info: ResourceInfo;
  idField: string;
  table: Table | null;
  isAggregate: boolean;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const installLiveSupport = (app: AppLike): LiveSupport => {
  const resources = new Map<string, ResourceInfo>();
  const pages = new Map<string, PageComponent>();
  let routesMounted = false;

  const buildCtx = (c: Context): PageContext => ({
    user: getUser(c) ?? null,
    req: c.req,
    c,
  });

  const forwardHeaders = (c: Context): Record<string, string> => {
    const headers: Record<string, string> = {};
    const cookie = c.req.header("cookie");
    if (cookie) headers.cookie = cookie;
    const auth = c.req.header("authorization");
    if (auth) headers.authorization = auth;
    return headers;
  };

  const resolveResourceInfo = (resource: unknown): ResourceInfo | undefined => {
    if (typeof resource === "string") {
      return (
        resources.get(resource) ?? {
          mountPath: resource.startsWith("/") ? resource : `/${resource}`,
          idField: "id",
        }
      );
    }
    try {
      return resources.get(getTableName(resource as Table));
    } catch {
      return undefined;
    }
  };

  const resolveRegion = (
    regionParam: string,
    ctx: PageContext
  ): ResolvedRegion | undefined => {
    for (const [path, component] of pages) {
      const match = new RegExp(`^${escapeRe(slugifyPath(path))}-(\\d+)$`).exec(
        regionParam
      );
      if (!match) continue;
      const index = Number(match[1]);
      const { regions } = collectRegions(path, () => toHtmlString(component(ctx)));
      const region = regions[index];
      if (!region || region.regionId !== regionParam) continue;
      const props = region.props as LiveProps & LiveAggregateProps;
      const info = resolveResourceInfo(props.resource);
      if (!info) return undefined;
      return {
        region,
        props,
        info,
        idField: props.idField ?? info.idField ?? "id",
        table: typeof props.resource === "object" ? (props.resource as Table) : null,
        isAggregate: region.kind === "aggregate",
      };
    }
    return undefined;
  };

  const listQuery = (props: LiveProps, cursor?: string | null): string => {
    const params = new URLSearchParams();
    const q = props.query ?? {};
    if (q.filter) params.set("filter", q.filter);
    if (q.orderBy) params.set("orderBy", q.orderBy);
    if (q.limit != null) params.set("limit", String(q.limit));
    if (cursor) params.set("cursor", cursor);
    const s = params.toString();
    return s ? `?${s}` : "";
  };

  const fetchRows = async (
    c: Context,
    props: LiveProps,
    cursor?: string | null
  ): Promise<{ items: Record<string, unknown>[]; nextCursor?: string | null; hasMore?: boolean }> => {
    const info = resolveResourceInfo(props.resource);
    if (!info) return { items: [] };
    const res = await app.request(`${info.mountPath}${listQuery(props, cursor)}`, {
      headers: forwardHeaders(c),
    });
    if (!res.ok) return { items: [] };
    const data = (await res.json()) as
      | { items?: Record<string, unknown>[]; nextCursor?: string | null; hasMore?: boolean }
      | Record<string, unknown>[];
    if (Array.isArray(data)) return { items: data };
    return { items: data.items ?? [], nextCursor: data.nextCursor, hasMore: data.hasMore };
  };

  const aggregateQuery = (props: LiveAggregateProps): string => {
    const params = new URLSearchParams();
    if (props.query?.filter) params.set("filter", props.query.filter);
    if (props.groupBy?.length) params.set("groupBy", props.groupBy.join(","));
    params.set("count", "true");
    return `?${params.toString()}`;
  };

  const fetchAggregate = async (c: Context, props: LiveAggregateProps): Promise<unknown> => {
    const info = resolveResourceInfo(props.resource);
    if (!info) return null;
    const res = await app.request(`${info.mountPath}/aggregate${aggregateQuery(props)}`, {
      headers: forwardHeaders(c),
    });
    if (!res.ok) return null;
    return res.json();
  };

  const renderRows = (props: LiveProps, regionId: string, rows: Record<string, unknown>[]): string => {
    const rc = createRegionContext(regionId);
    if (rows.length === 0) return props.empty ? toHtmlString(props.empty(rc)) : "";
    return rows.map((row) => toHtmlString(props.render(row, rc))).join("");
  };

  const ssrHandler = (path: string) => async (c: Context) => {
    const component = pages.get(path);
    if (!component) return c.notFound();
    const ctx = buildCtx(c);
    const html = await renderPage(component, {
      pagePath: path,
      ctx,
      fetchRows: (region) => fetchRows(c, region.props as LiveProps),
      fetchAggregate: (region) => fetchAggregate(c, region.props as LiveAggregateProps),
    });
    return c.html(`${html}\n<script src="${LIVE_PREFIX}/_runtime.js"></script>`);
  };

  const mountRoutes = () => {
    if (routesMounted) return;
    routesMounted = true;
    const live = new Hono();

    live.get("/_runtime.js", async (c) => {
      // Loaded on demand so apps that don't serve htmx pages never pull the
      // vendored htmx core string into memory.
      const [{ htmxScript }, { covaraRuntimeScript }] = await Promise.all([
        import("@/ui/html/client/htmx-vendor"),
        import("./client/runtime"),
      ]);
      c.header("Content-Type", "application/javascript; charset=utf-8");
      return c.body(`${htmxScript}\n${covaraRuntimeScript}`);
    });

    // Live SSE: inject an HTML renderer into the resource's own /subscribe via a
    // one-shot token, forward auth, and stream the result straight back.
    live.get("/:region/subscribe", async (c) => {
      const resolved = resolveRegion(c.req.param("region"), buildCtx(c));
      if (!resolved) return c.notFound();
      const renderer = resolved.isAggregate
        ? makeInvalidateRenderer()
        : makeRegionEventRenderer({
            regionId: resolved.region.regionId,
            idField: resolved.idField,
            props: resolved.props as LiveProps,
          });
      const token = stashRenderer(renderer);
      const params = new URLSearchParams();
      const filter = resolved.props.query?.filter;
      if (filter) params.set("filter", filter);
      params.set("__cvRenderer", token);
      params.set("skipExisting", "true");
      return app.request(`${resolved.info.mountPath}/subscribe?${params.toString()}`, {
        headers: { ...forwardHeaders(c), accept: "text/event-stream" },
        signal: c.req.raw.signal,
      });
    });

    // List / pagination fragment.
    live.get("/:region", async (c) => {
      const resolved = resolveRegion(c.req.param("region"), buildCtx(c));
      if (!resolved) return c.notFound();
      const rc = createRegionContext(resolved.region.regionId);
      if (resolved.isAggregate) {
        const props = resolved.props as LiveAggregateProps;
        const data = await fetchAggregate(c, props);
        return c.html(toHtmlString(props.render(data, rc)));
      }
      const props = resolved.props as LiveProps;
      const { items, nextCursor, hasMore } = await fetchRows(c, props, c.req.query("cursor"));
      let html = renderRows(props, resolved.region.regionId, items);
      // In "page" mode, append the next load-more control so the button (which
      // swapped itself out) is replaced by the next page + the following button.
      if ((props.mode ?? "live") === "page" && hasMore && nextCursor) {
        html += loadMoreButtonHtml(resolved.region.regionId, nextCursor, props.moreLabel);
      }
      return c.html(html);
    });

    // Create -> render the new row via the region's row closure.
    live.post("/:region", async (c) => {
      const resolved = resolveRegion(c.req.param("region"), buildCtx(c));
      if (!resolved || resolved.isAggregate) return c.notFound();
      const props = resolved.props as LiveProps;
      const body = (await c.req.parseBody()) as Record<string, unknown>;
      const payload = resolved.table ? coerceFormBody(body, resolved.table) : body;
      const res = await app.request(resolved.info.mountPath, {
        method: "POST",
        headers: { ...forwardHeaders(c), "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) return c.html(await errorFragment(res), res.status as 400);
      const row = (await res.json()) as Record<string, unknown>;
      const rc = createRegionContext(resolved.region.regionId);
      return c.html(toHtmlString(props.render(row, rc)), 201);
    });

    // Update -> render the row, or an empty body (which removes it) when the
    // updated row no longer matches the region's display filter.
    live.patch("/:region/:id", async (c) => {
      const resolved = resolveRegion(c.req.param("region"), buildCtx(c));
      if (!resolved || resolved.isAggregate) return c.notFound();
      const props = resolved.props as LiveProps;
      const id = c.req.param("id");
      const body = (await c.req.parseBody()) as Record<string, unknown>;
      const payload = resolved.table ? coerceFormBody(body, resolved.table) : body;
      const res = await app.request(
        `${resolved.info.mountPath}/${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          headers: { ...forwardHeaders(c), "content-type": "application/json" },
          body: JSON.stringify(payload),
        }
      );
      if (!res.ok) return c.html(await errorFragment(res), res.status as 400);
      const row = (await res.json()) as Record<string, unknown>;
      const filter = props.query?.filter;
      if (filter && resolved.table && !matchesFilter(resolved.table, filter, row)) {
        return c.html("");
      }
      const rc = createRegionContext(resolved.region.regionId);
      return c.html(toHtmlString(props.render(row, rc)));
    });

    // Delete -> empty body (outerHTML swap removes the targeted row).
    live.delete("/:region/:id", async (c) => {
      const resolved = resolveRegion(c.req.param("region"), buildCtx(c));
      if (!resolved) return c.notFound();
      const id = c.req.param("id");
      const res = await app.request(
        `${resolved.info.mountPath}/${encodeURIComponent(id)}`,
        { method: "DELETE", headers: forwardHeaders(c) }
      );
      return c.html("", (res.ok ? 200 : (res.status as 400)));
    });

    app.route(LIVE_PREFIX, live);
  };

  return {
    registerResource: (tableName, info) => resources.set(tableName, info),
    registerPage: (path, component) => {
      pages.set(path, component);
      mountRoutes();
      app.get(path, ssrHandler(path));
    },
  };
};

const matchesFilter = (table: Table, filter: string, row: Record<string, unknown>): boolean => {
  try {
    return createResourceFilter(table).compile(filter).execute(row);
  } catch {
    return true;
  }
};

const errorFragment = async (res: Response): Promise<string> => {
  let detail = `Request failed (${res.status})`;
  try {
    const body = (await res.json()) as { detail?: string; title?: string };
    detail = body.detail ?? body.title ?? detail;
  } catch {
    // non-JSON error
  }
  return `<div class="cv-error" role="alert">${detail
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")}</div>`;
};
