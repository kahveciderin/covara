import { describe, it, expect } from "vitest";
import {
  encodeCursor,
  decodeCursor,
  decodeCursorLegacy,
  parseOrderBy,
  extractCursorValues,
  processPaginatedResults,
  normalizePaginationParams,
} from "@/resource/pagination";

describe("Pagination", () => {
  describe("encodeCursor / decodeCursor", () => {
    it("should encode and decode cursor data correctly", () => {
      const data = { v: "test-value", id: "123" };
      const encoded = encodeCursor(data);
      const decoded = decodeCursorLegacy(encoded);

      expect(decoded).not.toBeNull();
      expect(decoded?.v).toEqual(data.v);
      expect(decoded?.id).toEqual(data.id);
    });

    it("should handle complex cursor values", () => {
      const data = {
        v: { name: "John", age: 30 },
        id: "abc-123",
      };
      const encoded = encodeCursor(data);
      const decoded = decodeCursorLegacy(encoded);

      expect(decoded).not.toBeNull();
      expect(decoded?.v).toEqual(data.v);
      expect(decoded?.id).toEqual(data.id);
    });

    it("should return null for invalid cursor", () => {
      expect(decodeCursorLegacy("invalid-base64")).toBeNull();
      expect(decodeCursorLegacy("")).toBeNull();
    });

    it("should return null for cursor without required fields", () => {
      const invalidData = Buffer.from(JSON.stringify({ foo: "bar" })).toString(
        "base64url"
      );
      expect(decodeCursorLegacy(invalidData)).toBeNull();
    });

    it("should return structured result with new decodeCursor", () => {
      const data = { v: "test-value", id: "123" };
      const encoded = encodeCursor(data);
      const result = decodeCursor(encoded);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.v).toEqual(data.v);
        expect(result.data.id).toEqual(data.id);
      }
    });
  });

  describe("parseOrderBy", () => {
    it("should parse single field ordering", () => {
      expect(parseOrderBy("name:asc")).toEqual([
        { field: "name", direction: "asc" },
      ]);
      expect(parseOrderBy("age:desc")).toEqual([
        { field: "age", direction: "desc" },
      ]);
    });

    it("should parse multiple field ordering", () => {
      expect(parseOrderBy("name:asc,age:desc")).toEqual([
        { field: "name", direction: "asc" },
        { field: "age", direction: "desc" },
      ]);
    });

    it("should default to asc direction", () => {
      expect(parseOrderBy("name")).toEqual([{ field: "name", direction: "asc" }]);
    });

    it("should return empty array for undefined input", () => {
      expect(parseOrderBy(undefined)).toEqual([]);
      expect(parseOrderBy("")).toEqual([]);
    });

    it("should support the leading '-' descending convention", () => {
      expect(parseOrderBy("-name")).toEqual([{ field: "name", direction: "desc" }]);
      expect(parseOrderBy("+name")).toEqual([{ field: "name", direction: "asc" }]);
    });

    it("should mix '-field' and 'field:dir' syntaxes across fields", () => {
      expect(parseOrderBy("-createdAt,name:asc,age")).toEqual([
        { field: "createdAt", direction: "desc" },
        { field: "name", direction: "asc" },
        { field: "age", direction: "asc" },
      ]);
    });

    it("should error when both syntaxes target the same field", () => {
      expect(() => parseOrderBy("-name:desc")).toThrow(/Conflicting sort direction/);
      expect(() => parseOrderBy("-name:asc")).toThrow(/Conflicting sort direction/);
      expect(() => parseOrderBy("+age:desc")).toThrow(/Conflicting sort direction/);
    });

    it("should error on an invalid direction suffix", () => {
      expect(() => parseOrderBy("name:sideways")).toThrow(/Invalid sort direction/);
    });

    it("should tolerate whitespace and empty segments", () => {
      expect(parseOrderBy(" -name , , age:desc ")).toEqual([
        { field: "name", direction: "desc" },
        { field: "age", direction: "desc" },
      ]);
    });
  });

  describe("extractCursorValues", () => {
    it("should extract cursor values from item", () => {
      const item = { id: "123", name: "John", age: 30 };
      const orderByFields = [{ field: "name", direction: "asc" as const }];

      const cursor = extractCursorValues(item, "id", orderByFields);

      expect(cursor).toEqual({
        v: { name: "John" },
        id: "123",
      });
    });

    it("should handle multiple orderBy fields", () => {
      const item = { id: "123", name: "John", age: 30, score: 100 };
      const orderByFields = [
        { field: "name", direction: "asc" as const },
        { field: "age", direction: "desc" as const },
      ];

      const cursor = extractCursorValues(item, "id", orderByFields);

      expect(cursor).toEqual({
        v: { name: "John", age: 30 },
        id: "123",
      });
    });

    it("should handle no orderBy fields", () => {
      const item = { id: "123", name: "John" };
      const cursor = extractCursorValues(item, "id", []);

      expect(cursor).toEqual({
        v: "123",
        id: "123",
      });
    });
  });

  describe("processPaginatedResults", () => {
    it("should detect hasMore correctly", () => {
      const items = [
        { id: "1", name: "A" },
        { id: "2", name: "B" },
        { id: "3", name: "C" },
      ];

      const result = processPaginatedResults(items, 2, "id", []);

      expect(result.hasMore).toBe(true);
      expect(result.items).toHaveLength(2);
      expect(result.nextCursor).not.toBeNull();
    });

    it("should return hasMore false when no more items", () => {
      const items = [
        { id: "1", name: "A" },
        { id: "2", name: "B" },
      ];

      const result = processPaginatedResults(items, 5, "id", []);

      expect(result.hasMore).toBe(false);
      expect(result.items).toHaveLength(2);
      expect(result.nextCursor).toBeNull();
    });

    it("should include totalCount when provided", () => {
      const items = [{ id: "1", name: "A" }];
      const result = processPaginatedResults(items, 10, "id", [], 100);

      expect(result.totalCount).toBe(100);
    });
  });

  describe("normalizePaginationParams", () => {
    it("should apply default limit", () => {
      const params = normalizePaginationParams({});
      expect(params.limit).toBe(20);
    });

    it("should respect provided limit", () => {
      const params = normalizePaginationParams({ limit: 50 });
      expect(params.limit).toBe(50);
    });

    it("should cap limit at maxLimit", () => {
      const params = normalizePaginationParams({ limit: 500 });
      expect(params.limit).toBe(100);
    });

    it("should enforce minimum limit of 1", () => {
      const params = normalizePaginationParams({ limit: 0 });
      expect(params.limit).toBe(1);

      const params2 = normalizePaginationParams({ limit: -5 });
      expect(params2.limit).toBe(1);
    });
  });
});
