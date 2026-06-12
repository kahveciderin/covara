import { describe, it, expect, vi } from "vitest";
import { createPassportAdapter } from "@/auth/adapters/passport";
import { InMemorySessionStore, SessionData, SessionStore } from "@/auth/types";

const makeAdapter = (sessionStore: SessionStore) =>
  createPassportAdapter({
    getUserById: async (id) => ({ id, email: `${id}@test.com` }),
    sessionStore,
  });

const session = (id: string, userId: string): SessionData => ({
  id,
  userId,
  createdAt: new Date(),
  expiresAt: new Date(Date.now() + 60_000),
});

describe("invalidateUserSessions", () => {
  it("uses the store's deleteByUser index instead of scanning all sessions", async () => {
    const deleteByUser = vi.fn(async () => 2);
    const getAll = vi.fn(async () => []);
    const store: SessionStore = {
      get: async () => null,
      set: async () => {},
      delete: async () => {},
      touch: async () => {},
      getAll,
      deleteByUser,
    };

    await makeAdapter(store).invalidateUserSessions!("user-1");

    expect(deleteByUser).toHaveBeenCalledWith("user-1");
    expect(getAll).not.toHaveBeenCalled();
  });

  it("uses getByUser when keeping the current session alive", async () => {
    const deleted: string[] = [];
    const getByUser = vi.fn(async (userId: string) => [
      session("keep-me", userId),
      session("kill-me", userId),
    ]);
    const getAll = vi.fn(async () => []);
    const store: SessionStore = {
      get: async () => null,
      set: async () => {},
      delete: async (id) => {
        deleted.push(id);
      },
      touch: async () => {},
      getAll,
      getByUser,
    };

    await makeAdapter(store).invalidateUserSessions!("user-1", "keep-me");

    expect(getByUser).toHaveBeenCalledWith("user-1");
    expect(deleted).toEqual(["kill-me"]);
    expect(getAll).not.toHaveBeenCalled();
  });

  it("falls back to getAll for stores without a per-user index", async () => {
    const deleted: string[] = [];
    const store: SessionStore = {
      get: async () => null,
      set: async () => {},
      delete: async (id) => {
        deleted.push(id);
      },
      touch: async () => {},
      getAll: async () => [session("a", "user-1"), session("b", "user-2")],
    };

    await makeAdapter(store).invalidateUserSessions!("user-1");

    expect(deleted).toEqual(["a"]);
  });

  it("InMemorySessionStore implements the per-user index", async () => {
    const store = new InMemorySessionStore();
    await store.set("s1", session("s1", "u1"), 60_000);
    await store.set("s2", session("s2", "u1"), 60_000);
    await store.set("s3", session("s3", "u2"), 60_000);

    expect((await store.getByUser("u1")).map((s) => s.id).sort()).toEqual(["s1", "s2"]);
    expect(await store.deleteByUser("u1")).toBe(2);
    expect(await store.get("s1")).toBeNull();
    expect(await store.get("s3")).not.toBeNull();
  });
});
