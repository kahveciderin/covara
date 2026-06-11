import { describe, it, expectTypeOf } from "vitest";
import { useLiveList, useAuth } from "@/client/react";
import { createRepository } from "@/client/repository";
import { createTransport, Transport, TransportError } from "@/client/transport";
import {
  q,
  createTypedQueryBuilder,
  createFieldBuilder,
} from "@/client/query-builder";
import { ResourceQueryBuilder } from "@/client/resource-query-builder";
import { createLiveQuery } from "@/client/live-store";
import type { LiveQueryMutations } from "@/client/live-store";
import { createClient } from "@/client";
import type {
  SubscriptionEvent,
  EventMeta,
  PaginatedResponse,
  ResourceClient,
  CovaraClient,
  SubscriptionCallbacks,
  Subscription,
  LiveQueryLike,
  AggregationResponse,
  SearchResponse,
  CheckAuthResult,
} from "@/client/types";
import type { TypedPaginatedResponse } from "@/client/query-types";
import type { JWTAuthState, JWTUser, JWTClient } from "@/client/jwt";
import type { OfflineManager } from "@/client/offline";
import type { AuthManager } from "@/client/auth";

interface Todo {
  id: string;
  title: string;
  completed: boolean;
  position: number;
  note: string | null;
  createdAt: string;
}

interface Category {
  id: string;
  name: string;
}

declare const transport: Transport;
declare const repo: ResourceClient<Todo>;

describe("repository CRUD generics", () => {
  it("flows the item type through every method", () => {
    const created = createRepository<Todo>({
      transport: createTransport({ baseUrl: "http://localhost" }),
      resourcePath: "/api/todos",
    });
    expectTypeOf(created).toEqualTypeOf<ResourceClient<Todo>>();

    expectTypeOf(repo.list()).resolves.toEqualTypeOf<PaginatedResponse<Todo>>();
    expectTypeOf(repo.get("1")).resolves.toEqualTypeOf<Todo>();
    expectTypeOf(repo.count).returns.resolves.toBeNumber();
    expectTypeOf(repo.aggregate).returns.resolves.toEqualTypeOf<AggregationResponse>();
    expectTypeOf(repo.search).returns.resolves.toEqualTypeOf<SearchResponse<Todo>>();
    expectTypeOf(repo.create).parameter(0).toEqualTypeOf<Partial<Omit<Todo, "id">>>();
    expectTypeOf(repo.create).returns.resolves.toEqualTypeOf<Todo>();
    expectTypeOf(repo.update).parameter(1).toEqualTypeOf<Partial<Todo>>();
    expectTypeOf(repo.update).returns.resolves.toEqualTypeOf<Todo>();
    expectTypeOf(repo.replace).parameter(1).toEqualTypeOf<Omit<Todo, "id">>();
    expectTypeOf(repo.delete).returns.resolves.toBeVoid();
    expectTypeOf(repo.batchCreate).returns.resolves.toEqualTypeOf<Todo[]>();
    expectTypeOf(repo.batchUpdate).parameter(1).toEqualTypeOf<Partial<Todo>>();
    expectTypeOf(repo.batchDelete).returns.resolves.toEqualTypeOf<{ count: number }>();

    // @ts-expect-error - unknown properties are rejected on create
    void repo.create({ nope: true });

    // @ts-expect-error - wrong value type is rejected on update
    void repo.update("1", { completed: "yes" });
  });

  it("types rpc input and output", () => {
    expectTypeOf(
      repo.rpc<{ id: string }, { success: boolean }>
    ).returns.resolves.toEqualTypeOf<{ success: boolean }>();
  });
});

describe("subscription event payload typing", () => {
  it("narrows SubscriptionEvent<T> by event type", () => {
    const handle = (event: SubscriptionEvent<Todo>) => {
      if (event.type === "existing" || event.type === "added" || event.type === "changed") {
        expectTypeOf(event.object).toEqualTypeOf<Todo>();
      }
      if (event.type === "added") {
        expectTypeOf(event.meta).toEqualTypeOf<EventMeta | undefined>();
      }
      if (event.type === "changed") {
        expectTypeOf(event.previousObjectId).toEqualTypeOf<string | undefined>();
      }
      if (event.type === "removed") {
        expectTypeOf(event.objectId).toBeString();
      }
      if (event.type === "invalidate") {
        expectTypeOf(event.reason).toEqualTypeOf<string | undefined>();
      }
      expectTypeOf(event.seq).toBeNumber();
    };
    expectTypeOf(handle).toBeFunction();
  });

  it("types subscription callbacks and state", () => {
    const callbacks: SubscriptionCallbacks<Todo> = {
      onAdded: (item, meta) => {
        expectTypeOf(item).toEqualTypeOf<Todo>();
        expectTypeOf(meta).toEqualTypeOf<EventMeta | undefined>();
      },
      onExisting: (item) => expectTypeOf(item).toEqualTypeOf<Todo>(),
      onChanged: (item, previousId) => {
        expectTypeOf(item).toEqualTypeOf<Todo>();
        expectTypeOf(previousId).toEqualTypeOf<string | undefined>();
      },
      onRemoved: (id) => expectTypeOf(id).toBeString(),
    };

    const sub = repo.subscribe({}, callbacks);
    expectTypeOf(sub).toEqualTypeOf<Subscription<Todo>>();
    expectTypeOf(sub.items).toEqualTypeOf<Todo[]>();
    expectTypeOf(sub.state.items).toEqualTypeOf<Map<string, Todo>>();
  });
});

describe("useLiveList generic flow", () => {
  it("infers items and mutations from a path string with explicit T", () => {
    const result = useLiveList<Todo>("/api/todos");
    expectTypeOf(result.items).toEqualTypeOf<Pick<Todo, keyof Todo>[]>();
    expectTypeOf(result.items[0]!.title).toBeString();
    expectTypeOf(result.items[0]!.note).toEqualTypeOf<string | null>();
    expectTypeOf(result.mutate).toEqualTypeOf<LiveQueryMutations<Todo>>();
    expectTypeOf(result.mutate.create).parameter(0).toEqualTypeOf<Partial<Omit<Todo, "id">>>();
    expectTypeOf(result.mutate.create).returns.toBeString();
    expectTypeOf(result.mutate.update).parameter(1).toEqualTypeOf<Partial<Todo>>();
    expectTypeOf(result.error).toEqualTypeOf<Error | null>();
    expectTypeOf(result.status).toEqualTypeOf<"loading" | "live" | "reconnecting" | "offline" | "error">();
    expectTypeOf(result.refresh).returns.resolves.toBeVoid();

    // @ts-expect-error - unknown properties are rejected on optimistic create
    result.mutate.create({ nope: true });
  });

  it("narrows item type with select projections", () => {
    const result = useLiveList<Todo, "title">("/api/todos", { select: ["title"] });
    expectTypeOf(result.items).toEqualTypeOf<Pick<Todo, "title" | "id">[]>();

    // @ts-expect-error - select only accepts field names of T
    useLiveList<Todo, "title">("/api/todos", { select: ["nope"] });
  });

  it("infers from a LiveQueryLike with includes and selection", () => {
    const query = {} as LiveQueryLike<Todo, { category?: Category | null }, "id" | "title">;
    const result = useLiveList(query);
    expectTypeOf(result.items).toEqualTypeOf<
      (Pick<Todo, "id" | "title"> & { category?: Category | null })[]
    >();
    expectTypeOf(result.mutate.create).parameter(0).toEqualTypeOf<Partial<Omit<Todo, "id">>>();
  });

  it("infers from a resource client instance", () => {
    const result = useLiveList(repo);
    expectTypeOf(result.items[0]!.completed).toBeBoolean();
  });
});

describe("useAuth typing", () => {
  it("types the user and helpers", () => {
    interface User {
      id: string;
      email: string;
    }
    const auth = useAuth<User>();
    expectTypeOf(auth.user).toEqualTypeOf<User | null>();
    expectTypeOf(auth.isAuthenticated).toBeBoolean();
    expectTypeOf(auth.accessToken).toEqualTypeOf<string | null>();
    expectTypeOf(auth.logout).returns.resolves.toBeVoid();
    expectTypeOf(auth.refetch).returns.resolves.toBeVoid();
  });
});

describe("CovaraClient typing", () => {
  it("exposes typed transport, offline, auth and jwt", () => {
    const client = createClient({ baseUrl: "http://localhost" });
    expectTypeOf(client).toEqualTypeOf<CovaraClient>();
    expectTypeOf(client.transport).toEqualTypeOf<Transport>();
    expectTypeOf(client.offline).toEqualTypeOf<OfflineManager | undefined>();
    expectTypeOf(client.auth).toEqualTypeOf<AuthManager>();
    expectTypeOf(client.auth.getAccessToken).returns.toEqualTypeOf<string | null>();
    expectTypeOf(client.jwt).toEqualTypeOf<JWTClient | undefined>();

    const jwtState = client.jwt!.getState();
    expectTypeOf(jwtState).toEqualTypeOf<JWTAuthState>();
    expectTypeOf(jwtState.user).toEqualTypeOf<JWTUser | null>();

    expectTypeOf(client.resource<Todo>("/api/todos")).toEqualTypeOf<ResourceClient<Todo>>();
    expectTypeOf(client.checkAuth<{ id: string }>()).resolves.toEqualTypeOf<
      CheckAuthResult<{ id: string }>
    >();
    expectTypeOf(client.getPendingCount).returns.resolves.toBeNumber();
  });

  it("types transport request and errors", () => {
    expectTypeOf(
      transport.request<{ ok: boolean }>
    ).returns.resolves.toMatchTypeOf<{ data: { ok: boolean }; status: number }>();

    const error = new TransportError("nope", 404, "NOT_FOUND");
    expectTypeOf(error.isNotFound).returns.toBeBoolean();
  });
});

describe("query builder filter types", () => {
  it("types the typed query builder per field", () => {
    const todos = createTypedQueryBuilder<Todo>();

    expectTypeOf(todos.title.eq).parameter(0).toEqualTypeOf<string>();
    expectTypeOf(todos.note.eq).parameter(0).toEqualTypeOf<string | null>();
    expectTypeOf(todos.note.gt).parameter(0).toEqualTypeOf<string>();
    expectTypeOf(todos.position.gt).parameter(0).toEqualTypeOf<number>();
    expectTypeOf(todos.completed.eq).parameter(0).toEqualTypeOf<boolean>();
    expectTypeOf(todos.title.contains).returns.toBeString();
    expectTypeOf(todos.note.isNull).returns.toBeString();

    // @ts-expect-error - eq value must match the field type
    todos.position.eq("high");

    // @ts-expect-error - in() values must match the field type
    todos.completed.in(["yes"]);
  });

  it("types field builders including string helpers", () => {
    const age = createFieldBuilder<number>("age");
    expectTypeOf(age.between).parameter(0).toEqualTypeOf<number>();
    // String helpers are always available (no optional members)
    expectTypeOf(age.contains).toBeFunction();
    expectTypeOf(q.like).returns.toBeString();
  });

  it("restricts enum-like literal fields", () => {
    interface WithRole {
      id: string;
      role: "admin" | "user";
    }
    const builder = createTypedQueryBuilder<WithRole>();
    expectTypeOf(builder.role.eq).parameter(0).toEqualTypeOf<"admin" | "user">();

    // @ts-expect-error - literal unions reject other strings
    builder.role.eq("guest");
  });
});

describe("ResourceQueryBuilder generics", () => {
  it("narrows selection and aggregation result types", () => {
    const builder = {} as ResourceQueryBuilder<Todo>;

    const selected = builder.select("id", "title");
    expectTypeOf(selected.list).returns.resolves.toEqualTypeOf<
      TypedPaginatedResponse<Pick<Todo, "id" | "title">>
    >();
    expectTypeOf(selected.get).returns.resolves.toEqualTypeOf<Pick<Todo, "id" | "title">>();
    expectTypeOf(selected.first).returns.resolves.toEqualTypeOf<Pick<Todo, "id" | "title"> | null>();

    const agg = builder.groupBy("completed").sum("position").withCount();
    expectTypeOf(agg.aggregate).returns.resolves.toMatchTypeOf<{
      groups: Array<{
        key: Pick<Todo, "completed">;
        count: number;
        sum: { position: number };
      }>;
    }>();

    // @ts-expect-error - sum only accepts numeric fields
    builder.sum("title");

    // @ts-expect-error - select only accepts fields of T
    builder.select("nope");

    // @ts-expect-error - avg only accepts numeric fields
    builder.avg("createdAt");
  });
});

describe("live query store typing", () => {
  it("types createLiveQuery snapshots and mutations", () => {
    const live = createLiveQuery<Todo>(repo);
    const snapshot = live.getSnapshot();
    expectTypeOf(snapshot.items).toEqualTypeOf<Todo[]>();
    expectTypeOf(snapshot.error).toEqualTypeOf<Error | null>();
    expectTypeOf(live.mutate.create).parameter(0).toEqualTypeOf<Partial<Omit<Todo, "id">>>();
    expectTypeOf(live.mutate.create).returns.toBeString();
    expectTypeOf(live.loadMore).returns.resolves.toBeVoid();
  });
});
