import { describe, it, expect } from "vitest";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { columnName, columnNames, normalizeResourceConfig } from "@/resource/column-ref";

const todos = sqliteTable("todos", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  secret: text("secret"),
  version: integer("version").default(0),
  deletedAt: text("deleted_at"),
});

describe("column-ref helpers", () => {
  it("resolves a Drizzle column to its name and passes strings through", () => {
    expect(columnName(todos.title)).toBe("title");
    expect(columnName("title")).toBe("title");
    expect(columnNames([todos.id, "title", todos.version])).toEqual(["id", "title", "version"]);
    expect(columnNames(undefined)).toBeUndefined();
  });
});

describe("normalizeResourceConfig", () => {
  it("normalizes every column-reference field to a name (columns or strings)", () => {
    const normalized = normalizeResourceConfig({
      db: {} as any,
      id: todos.id,
      etag: { versionField: todos.version, updatedAtField: "updated_at", idField: todos.id },
      softDelete: { field: todos.deletedAt },
      fields: {
        readable: [todos.id, todos.title],
        writable: ["title"],
        filterable: [todos.title],
        sortable: [todos.version],
        aggregatable: { groupBy: [todos.title], metrics: [todos.version] },
      },
      filter: { allowedFields: [todos.title, "version"] },
      generatedFields: [todos.version],
      search: { fields: [todos.title] },
    });

    expect(normalized.etag).toEqual({ versionField: "version", updatedAtField: "updated_at", idField: "id" });
    expect(normalized.softDelete?.field).toBe("deleted_at");
    expect(normalized.fields).toEqual({
      readable: ["id", "title"],
      writable: ["title"],
      filterable: ["title"],
      sortable: ["version"],
      aggregatable: { groupBy: ["title"], metrics: ["version"] },
    });
    expect(normalized.filter?.allowedFields).toEqual(["title", "version"]);
    expect(normalized.generatedFields).toEqual(["version"]);
    expect(normalized.search?.fields).toEqual(["title"]);
  });

  it("leaves the search record form (keyed by name) untouched and does not mutate input", () => {
    const input = {
      db: {} as any,
      id: todos.id,
      search: { fields: { title: { weight: 2 } } },
      fields: { readable: [todos.id] },
    };
    const normalized = normalizeResourceConfig(input as any);
    expect(normalized.search?.fields).toEqual({ title: { weight: 2 } });
    // input untouched
    expect((input as any).fields.readable[0]).toBe(todos.id);
  });
});
