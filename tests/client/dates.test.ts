import { describe, it, expect, vi, beforeEach } from "vitest";
import { FetchTransport } from "../../src/client/transport";
import {
  toDate,
  toDateOrNull,
  isISODateString,
  reviveDates,
} from "../../src/client/dates";
import { f, createTypedFilter } from "../../src/client/query-builder";

interface Todo {
  id: string;
  title: string;
  completed: boolean;
  position: number;
  note: string | null;
  createdAt: string;
}

describe("date helpers", () => {
  it("toDate parses an ISO string", () => {
    const d = toDate("2026-01-02T03:04:05.000Z");
    expect(d).toBeInstanceOf(Date);
    expect(d.toISOString()).toBe("2026-01-02T03:04:05.000Z");
  });

  it("toDateOrNull handles null/undefined", () => {
    expect(toDateOrNull(null)).toBeNull();
    expect(toDateOrNull(undefined)).toBeNull();
    expect(toDateOrNull("2026-01-02T00:00:00.000Z")).toBeInstanceOf(Date);
  });

  it("isISODateString recognises ISO strings only", () => {
    expect(isISODateString("2026-01-02T03:04:05Z")).toBe(true);
    expect(isISODateString("2026-01-02")).toBe(true);
    expect(isISODateString("not a date")).toBe(false);
    expect(isISODateString("12345")).toBe(false);
    expect(isISODateString(42)).toBe(false);
  });

  describe("reviveDates", () => {
    it("converts all ISO strings when no field list given", () => {
      const result = reviveDates({ id: "1", createdAt: "2026-01-02T00:00:00.000Z", title: "x" });
      expect(result.createdAt).toBeInstanceOf(Date);
      expect(result.title).toBe("x");
    });

    it("converts only listed fields when given", () => {
      const result = reviveDates(
        { id: "1", createdAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-02-02T00:00:00.000Z" },
        ["createdAt"]
      );
      expect(result.createdAt).toBeInstanceOf(Date);
      expect(result.updatedAt).toBe("2026-02-02T00:00:00.000Z");
    });

    it("revives items inside an { items: [] } envelope", () => {
      const result = reviveDates({
        items: [{ id: "1", createdAt: "2026-01-02T00:00:00.000Z" }],
        hasMore: false,
        nextCursor: null,
      });
      expect(result.items[0].createdAt).toBeInstanceOf(Date);
    });

    it("revives items inside a bare array", () => {
      const result = reviveDates([{ id: "1", createdAt: "2026-01-02T00:00:00.000Z" }]);
      expect(result[0].createdAt).toBeInstanceOf(Date);
    });
  });
});

describe("transport parseDates", () => {
  const makeResponse = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("does not parse dates by default", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeResponse({ id: "1", createdAt: "2026-01-02T00:00:00.000Z" }))
    );
    const transport = new FetchTransport({ baseUrl: "http://localhost" });
    const res = await transport.request<{ id: string; createdAt: unknown }>({
      method: "GET",
      path: "/todos/1",
    });
    expect(res.data.createdAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("parses every ISO string when parseDates is true", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeResponse({ id: "1", createdAt: "2026-01-02T00:00:00.000Z" }))
    );
    const transport = new FetchTransport({ baseUrl: "http://localhost", parseDates: true });
    const res = await transport.request<{ id: string; createdAt: unknown }>({
      method: "GET",
      path: "/todos/1",
    });
    expect(res.data.createdAt).toBeInstanceOf(Date);
  });

  it("parses only registered fields per path", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        makeResponse({
          id: "1",
          createdAt: "2026-01-02T00:00:00.000Z",
          label: "2026-05-05",
        })
      )
    );
    const transport = new FetchTransport({
      baseUrl: "http://localhost",
      parseDates: { "/todos/1": ["createdAt"] },
    });
    const res = await transport.request<{ createdAt: unknown; label: unknown }>({
      method: "GET",
      path: "/todos/1",
    });
    expect(res.data.createdAt).toBeInstanceOf(Date);
    expect(res.data.label).toBe("2026-05-05");
  });

  it("honors per-request dateFields override", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeResponse({ a: "2026-01-02T00:00:00.000Z", b: "2026-03-03T00:00:00.000Z" }))
    );
    const transport = new FetchTransport({ baseUrl: "http://localhost", parseDates: true });
    const res = await transport.request<{ a: unknown; b: unknown }>({
      method: "GET",
      path: "/x",
      dateFields: ["a"],
    });
    expect(res.data.a).toBeInstanceOf(Date);
    expect(res.data.b).toBe("2026-03-03T00:00:00.000Z");
  });
});

describe("typed filter builder runtime", () => {
  it("produces the same RSQL as the untyped builder", () => {
    const filter = f<Todo>();
    expect(filter.eq("completed", true)).toBe("completed==true");
    expect(filter.gt("position", 3)).toBe("position>3");
    expect(filter.in("title", ["a", "b"])).toBe('title=in=("a","b")');
    expect(filter.isNull("note")).toBe("note=isnull=true");
    expect(filter.contains("title", "abc")).toBe('title=contains="abc"');
    expect(filter.raw("custom==1")).toBe("custom==1");
  });

  it("combines conditions with and/or", () => {
    const filter = createTypedFilter<Todo>();
    expect(filter.and(filter.eq("completed", true), filter.gt("position", 1))).toBe(
      "(completed==true);(position>1)"
    );
    expect(filter.or(filter.eq("completed", true), filter.eq("completed", false))).toBe(
      "(completed==true),(completed==false)"
    );
  });
});
