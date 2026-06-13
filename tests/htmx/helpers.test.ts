import { describe, it, expect } from "vitest";
import {
  LIVE_PREFIX,
  slugifyPath,
  regionId,
  domSafeId,
  containerDomId,
  rowDomId,
  regionBaseUrl,
  regionItemUrl,
  regionSubscribeUrl,
  createRegionContext,
} from "@/htmx";

describe("htmx id/url helpers", () => {
  it("slugifies page paths deterministically", () => {
    expect(slugifyPath("/todos")).toBe("todos");
    expect(slugifyPath("/")).toBe("root");
    expect(slugifyPath("/admin/users")).toBe("admin-users");
    expect(slugifyPath("/Foo_Bar/")).toBe("foo-bar");
  });

  it("builds region ids from page + position", () => {
    expect(regionId("/todos", 0)).toBe("todos-0");
    expect(regionId("/admin/users", 2)).toBe("admin-users-2");
  });

  it("makes ids DOM/CSS safe without collisions", () => {
    expect(domSafeId("42")).toBe("42");
    expect(domSafeId("a_b-c")).toBe("a_b-c");
    const a = domSafeId("a/b");
    const b = domSafeId("a:b");
    expect(a).not.toBe(b); // distinct unsafe chars stay distinct
    expect(/^[A-Za-z0-9_-]+$/.test(a)).toBe(true);
  });

  it("derives dom ids and urls under the internal prefix", () => {
    const r = regionId("/todos", 0);
    expect(containerDomId(r)).toBe("cv-todos-0-list");
    expect(rowDomId(r, "42")).toBe("cv-todos-0-42");
    expect(regionBaseUrl(r)).toBe(`${LIVE_PREFIX}/todos-0`);
    expect(regionItemUrl(r, "42")).toBe(`${LIVE_PREFIX}/todos-0/42`);
    expect(regionItemUrl(r, "a b")).toBe(`${LIVE_PREFIX}/todos-0/a%20b`);
    expect(regionSubscribeUrl(r)).toBe(`${LIVE_PREFIX}/todos-0/subscribe`);
  });
});

describe("region attribute-helper context", () => {
  const r = regionId("/todos", 0);
  const c = createRegionContext(r);

  it("container wires the SSE connection + stable id", () => {
    expect(c.container()).toEqual({
      id: "cv-todos-0-list",
      "data-cv-region": "todos-0",
      "data-cv-sse": `${LIVE_PREFIX}/todos-0/subscribe`,
      "data-cv-list": `${LIVE_PREFIX}/todos-0`,
      "data-cv-template": "cv-todos-0-tmpl",
      "data-cv-mode": "live",
    });
  });

  it("row gives a stable dom id + raw id", () => {
    expect(c.row(42)).toEqual({ id: "cv-todos-0-42", "data-covara-id": "42" });
  });

  it("create posts to the region; the row is inserted by the live SSE (no swap)", () => {
    expect(c.create()).toEqual({
      "hx-post": `${LIVE_PREFIX}/todos-0`,
      "hx-swap": "none",
    });
  });

  it("update patches the item and replaces the row in place", () => {
    expect(c.update(42)).toEqual({
      "hx-patch": `${LIVE_PREFIX}/todos-0/42`,
      "hx-target": "#cv-todos-0-42",
      "hx-swap": "outerHTML",
    });
  });

  it("delete deletes the item and removes the row", () => {
    expect(c.delete(42)).toEqual({
      "hx-delete": `${LIVE_PREFIX}/todos-0/42`,
      "hx-target": "#cv-todos-0-42",
      "hx-swap": "outerHTML",
    });
  });

  it("merges caller-supplied extra attributes", () => {
    expect(c.delete(42, { "hx-confirm": "Sure?" })["hx-confirm"]).toBe("Sure?");
    expect(c.create({ class: "f" }).class).toBe("f");
  });
});
