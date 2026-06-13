import { describe, it, expect } from "vitest";
import { jsx } from "hono/jsx";
import { renderPage } from "@/htmx/page";
import { Live } from "@/htmx/live";
import type { RegionContext } from "@/htmx/context";

type Todo = { id: string; title: string };

const todoPage = () =>
  jsx("div", null, [
    jsx("h1", null, "Todos"),
    jsx(Live, {
      resource: "todos",
      create: (c: RegionContext) =>
        jsx("form", c.create(), [jsx("input", { name: "title" }), jsx("button", null, "Add")]),
      container: (rows: unknown, c: RegionContext) => jsx("ul", c.container(), rows),
      render: (t: Todo, c: RegionContext) => jsx("li", c.row(t.id), t.title),
      empty: (c: RegionContext) => jsx("li", { class: "muted" }, "No todos"),
    }),
  ]);

describe("renderPage", () => {
  it("SSRs the shell + region with rows rendered via the page's own closures", async () => {
    const html = await renderPage(todoPage, {
      pagePath: "/todos",
      ctx: {},
      fetchRows: async () => ({
        items: [
          { id: "1", title: "a" },
          { id: "2", title: "b" },
        ],
      }),
    });

    expect(html).toContain("<h1>Todos</h1>");
    // create form points at the generated region endpoint; the row is inserted
    // by the live SSE (no swap of the response → no duplicate/phantom row).
    expect(html).toContain('hx-post="/__covara/live/todos-0"');
    expect(html).toContain('hx-swap="none"');
    // container has the stable id + SSE wiring
    expect(html).toContain('id="cv-todos-0-list"');
    expect(html).toContain('data-cv-sse="/__covara/live/todos-0/subscribe"');
    // rows rendered with stable dom ids + raw id
    expect(html).toContain('<li id="cv-todos-0-1" data-covara-id="1">a</li>');
    expect(html).toContain('<li id="cv-todos-0-2" data-covara-id="2">b</li>');
    // no leftover region placeholder
    expect(html).not.toContain("cv-region:");
  });

  it("renders the empty closure when there are no rows", async () => {
    const html = await renderPage(todoPage, {
      pagePath: "/todos",
      ctx: {},
      fetchRows: async () => ({ items: [] }),
    });
    expect(html).toContain('<li class="muted">No todos</li>');
    // the only data-covara-id present is the inert template placeholder
    expect(html).not.toMatch(/data-covara-id="(?!\{\{)/);
  });

  it("falls back to a default container when none is provided", async () => {
    const page = () =>
      jsx(Live, {
        resource: "todos",
        render: (t: Todo, c: RegionContext) => jsx("li", c.row(t.id), t.title),
      });
    const html = await renderPage(page, {
      pagePath: "/todos",
      ctx: {},
      fetchRows: async () => ({ items: [{ id: "9", title: "z" }] }),
    });
    expect(html).toContain('<div id="cv-todos-0-list"');
    expect(html).toContain('data-cv-sse="/__covara/live/todos-0/subscribe"');
    expect(html).toContain('<li id="cv-todos-0-9" data-covara-id="9">z</li>');
  });
});
