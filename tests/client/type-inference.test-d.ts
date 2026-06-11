import { describe, it, expectTypeOf } from "vitest";
import type { ResourceClient, PaginatedResponse } from "@/client/types";
import { f, createTypedFilter } from "@/client/query-builder";
import { toDate, toDateOrNull } from "@/client/dates";
import type { ISODateString } from "@/client/dates";

interface Todo {
  id: string;
  title: string;
  completed: boolean;
  position: number;
  note: string | null;
  createdAt: ISODateString;
}

interface Category {
  id: string;
  name: string;
}

interface TodoProcedures {
  publish: { input: { id: string }; output: { success: boolean } };
  archive: { input: { id: string; reason?: string }; output: { archivedAt: string } };
}

declare const repo: ResourceClient<Todo>;
declare const typedRepo: ResourceClient<Todo, TodoProcedures>;

describe("select projection narrowing", () => {
  it("narrows list to Pick<T, K>[] with a const select tuple", () => {
    const res = repo.list({ select: ["id", "title"] as const });
    expectTypeOf(res).resolves.toEqualTypeOf<PaginatedResponse<Pick<Todo, "id" | "title">>>();
  });

  it("narrows list with a plain (inferred) select array", () => {
    const res = repo.list({ select: ["id", "completed"] });
    expectTypeOf(res).resolves.toEqualTypeOf<PaginatedResponse<Pick<Todo, "id" | "completed">>>();
  });

  it("narrows get to Pick<T, K>", () => {
    const res = repo.get("1", { select: ["id", "note"] as const });
    expectTypeOf(res).resolves.toEqualTypeOf<Pick<Todo, "id" | "note">>();
  });

  it("returns the full row when no select is given", () => {
    expectTypeOf(repo.list()).resolves.toEqualTypeOf<PaginatedResponse<Todo>>();
    expectTypeOf(repo.get("1")).resolves.toEqualTypeOf<Todo>();
  });

  // Note: a select of *valid* keys narrows to Pick<T, K>. A select that is a
  // plain dynamic `string[]` (the documented escape hatch) falls back to the
  // full-row overload rather than erroring, so unknown literal keys are not a
  // compile error here. Use the typed `f<T>()` / query builder for strict
  // field validation. The ResourceQueryBuilder.select() path *does* reject
  // unknown keys (covered in types.test-d.ts).
});

describe("typed procedures (rpc)", () => {
  it("checks name + input and infers output", () => {
    expectTypeOf(typedRepo.rpc("publish", { id: "1" })).resolves.toEqualTypeOf<{
      success: boolean;
    }>();
    expectTypeOf(typedRepo.rpc("archive", { id: "1" })).resolves.toEqualTypeOf<{
      archivedAt: string;
    }>();
  });

  it("rejects unknown procedure names", () => {
    // @ts-expect-error - 'frobnicate' is not a declared procedure
    void typedRepo.rpc("frobnicate", { id: "1" });
  });

  it("rejects wrong input shapes", () => {
    // @ts-expect-error - publish expects { id: string }, not { wrong: number }
    void typedRepo.rpc("publish", { wrong: 1 });
  });

  it("keeps the loose escape hatch when no procedures map is supplied", () => {
    expectTypeOf(
      repo.rpc<{ id: string }, { success: boolean }>("publish", { id: "1" })
    ).resolves.toEqualTypeOf<{ success: boolean }>();
  });
});

describe("typed filter builder", () => {
  it("validates field names and value types", () => {
    const filter = f<Todo>();
    expectTypeOf(filter.eq("completed", true)).toBeString();
    expectTypeOf(filter.eq).parameter(0).toEqualTypeOf<keyof Todo>();
    expectTypeOf(createTypedFilter<Todo>().raw("x==1")).toBeString();
  });

  it("rejects unknown field names", () => {
    const filter = f<Todo>();
    // @ts-expect-error - 'missing' is not a field of Todo
    filter.eq("missing", true);
  });

  it("rejects mismatched value types", () => {
    const filter = f<Todo>();
    // @ts-expect-error - position is a number, not a string
    filter.eq("position", "high");
    // @ts-expect-error - in() values must match the field type
    filter.in("completed", ["yes"]);
  });
});

describe("date helpers", () => {
  it("converts ISO date strings to Date", () => {
    const todo = {} as Todo;
    expectTypeOf(toDate(todo.createdAt)).toEqualTypeOf<Date>();
    expectTypeOf(toDateOrNull(todo.note)).toEqualTypeOf<Date | null>();
    // ISODateString remains assignable to/from plain string
    const s: string = todo.createdAt;
    expectTypeOf(s).toBeString();
  });
});
