import { describe, it, expect } from "vitest";
import { jsx } from "hono/jsx";
import { buildRowTemplate, applyRowTemplate } from "@/htmx/template-gen";
import type { RegionContext } from "@/htmx/context";
import type { LiveProps } from "@/htmx/live";

const props: LiveProps = {
  resource: "todos",
  render: (t: Record<string, unknown>, c: RegionContext) =>
    jsx("li", c.row(t.id as string), [
      t.title,
      jsx("button", c.delete(t.id as string), "x"),
    ]) as unknown as string,
};

describe("field-recording row template", () => {
  const tmpl = buildRowTemplate({ regionId: "todos-0", props });

  it("derives a {{field}} template across text, ids, and urls", () => {
    expect(tmpl).toContain('id="cv-todos-0-{{id}}"');
    expect(tmpl).toContain('data-covara-id="{{id}}"');
    expect(tmpl).toContain("{{title}}");
    expect(tmpl).toContain('hx-delete="/__covara/live/todos-0/{{id}}"');
    expect(tmpl).not.toContain("__cvslot_");
  });

  it("substitutes values and escapes them", () => {
    const html = applyRowTemplate(tmpl, { id: "42", title: "<b>x</b>" });
    expect(html).toContain('id="cv-todos-0-42"');
    expect(html).toContain('data-covara-id="42"');
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain('hx-delete="/__covara/live/todos-0/42"');
  });
});
