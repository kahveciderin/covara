import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono, type Context } from "hono";
import {
  BaseAuthAdapter,
  CompositeAuthAdapter,
  NullAuthAdapter,
  createUserContext,
} from "@/auth/adapter";
import {
  createAuthMiddleware,
  requireAuth,
  optionalAuth,
  requirePermission,
  requireRole,
  requireOwnership,
  getUser,
  getSession,
  rateByUser,
} from "@/auth/middleware";
import {
  ScopeResolver,
  createScopeResolver,
  combineScopes,
  checkObjectAccess,
  scopePatterns,
} from "@/auth/scope";
import {
  rsql,
  eq,
  ne,
  gt,
  gte,
  lt,
  lte,
  inList,
  notIn,
  like,
  notLike,
  isNull,
  isNotNull,
  and,
  or,
  ownerScope,
  publicScope,
  ownerOrPublic,
  emptyScope,
  allScope,
  isCompiledScope,
  scopeFromString,
} from "@/auth/rsql";
import { AuthCredentials, AuthResult, SessionData } from "@/auth/types";
import { UserContext } from "@/resource/types";

const makeContext = async (
  headers: Record<string, string> = {}
): Promise<Context> => {
  let captured: Context | undefined;
  const probe = new Hono();
  probe.get("*", (c) => {
    captured = c;
    return c.text("ok");
  });
  await probe.request("/", { headers });
  if (!captured) throw new Error("Failed to capture context");
  return captured;
};

describe("Authentication System", () => {
  describe("BaseAuthAdapter", () => {
    class TestAdapter extends BaseAuthAdapter {
      name = "test";

      extractCredentials(c: Context): AuthCredentials | null {
        const token = c.req.header("authorization")?.replace("Bearer ", "");
        if (token) return { type: "bearer", token };
        return null;
      }

      async validateCredentials(
        credentials: AuthCredentials
      ): Promise<AuthResult> {
        if (credentials.token === "valid-token") {
          return {
            success: true,
            user: {
              id: "user-123",
              email: "test@test.com",
              name: "Test User",
              image: null,
              emailVerified: null,
              sessionId: "session-1",
              sessionExpiresAt: new Date(Date.now() + 3600000),
            },
            expiresAt: new Date(Date.now() + 3600000),
          };
        }
        return { success: false, error: "Invalid token" };
      }

      getRoutes(): Hono {
        return new Hono();
      }
    }

    let adapter: TestAdapter;

    beforeEach(() => {
      adapter = new TestAdapter({});
    });

    it("should extract credentials from request", async () => {
      const c = await makeContext({ authorization: "Bearer valid-token" });

      const credentials = adapter.extractCredentials(c);
      expect(credentials?.type).toBe("bearer");
      expect(credentials?.token).toBe("valid-token");
    });

    it("should return null when no credentials", async () => {
      const c = await makeContext();
      const credentials = adapter.extractCredentials(c);
      expect(credentials).toBeNull();
    });

    it("should validate valid credentials", async () => {
      const result = await adapter.validateCredentials({
        type: "bearer",
        token: "valid-token",
      });

      expect(result.success).toBe(true);
      expect(result.user?.id).toBe("user-123");
    });

    it("should reject invalid credentials", async () => {
      const result = await adapter.validateCredentials({
        type: "bearer",
        token: "invalid-token",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Invalid token");
    });

    it("should create and retrieve sessions", async () => {
      const session = await adapter.createSession("user-123");

      expect(session.userId).toBe("user-123");
      expect(session.id).toBeDefined();

      const retrieved = await adapter.getSession(session.id);
      expect(retrieved?.userId).toBe("user-123");
    });

    it("should invalidate sessions", async () => {
      const session = await adapter.createSession("user-123");
      await adapter.invalidateSession(session.id);

      const retrieved = await adapter.getSession(session.id);
      expect(retrieved).toBeNull();
    });

    it("should refresh sessions", async () => {
      const session = await adapter.createSession("user-123");
      const originalExpiry = session.expiresAt;

      await new Promise((r) => setTimeout(r, 10));

      const refreshed = await adapter.refreshSession(session.id);
      expect(refreshed?.expiresAt.getTime()).toBeGreaterThan(
        originalExpiry.getTime()
      );
    });
  });

  describe("CompositeAuthAdapter", () => {
    class Adapter1 extends BaseAuthAdapter {
      name = "adapter1";
      extractCredentials(c: Context): AuthCredentials | null {
        if (c.req.header("x-api-key") === "key1") {
          return { type: "apiKey", apiKey: "key1" };
        }
        return null;
      }
      async validateCredentials(
        credentials: AuthCredentials
      ): Promise<AuthResult> {
        if (credentials.apiKey === "key1") {
          return {
            success: true,
            user: {
              id: "user-1",
              email: "user1@test.com",
              name: "User 1",
              image: null,
              emailVerified: null,
              sessionId: "s1",
              sessionExpiresAt: new Date(),
            },
          };
        }
        return { success: false, error: "Invalid" };
      }
      getRoutes(): Hono {
        return new Hono();
      }
    }

    class Adapter2 extends BaseAuthAdapter {
      name = "adapter2";
      extractCredentials(c: Context): AuthCredentials | null {
        const token = c.req.header("authorization")?.replace("Bearer ", "");
        if (token) return { type: "bearer", token };
        return null;
      }
      async validateCredentials(
        credentials: AuthCredentials
      ): Promise<AuthResult> {
        if (credentials.token === "token2") {
          return {
            success: true,
            user: {
              id: "user-2",
              email: "user2@test.com",
              name: "User 2",
              image: null,
              emailVerified: null,
              sessionId: "s2",
              sessionExpiresAt: new Date(),
            },
          };
        }
        return { success: false, error: "Invalid" };
      }
      getRoutes(): Hono {
        return new Hono();
      }
    }

    it("should try adapters in order", async () => {
      const composite = new CompositeAuthAdapter([new Adapter1(), new Adapter2()]);

      const c1 = await makeContext({ "x-api-key": "key1" });
      expect(composite.extractCredentials(c1)?.type).toBe("apiKey");

      const c2 = await makeContext({ authorization: "Bearer token2" });
      expect(composite.extractCredentials(c2)?.type).toBe("bearer");
    });

    it("should validate using matching adapter", async () => {
      const composite = new CompositeAuthAdapter([new Adapter1(), new Adapter2()]);

      const result1 = await composite.validateCredentials({
        type: "apiKey",
        apiKey: "key1",
      });
      expect(result1.success).toBe(true);
      expect(result1.user?.id).toBe("user-1");

      const result2 = await composite.validateCredentials({
        type: "bearer",
        token: "token2",
      });
      expect(result2.success).toBe(true);
      expect(result2.user?.id).toBe("user-2");
    });
  });

  describe("NullAuthAdapter", () => {
    it("should always return null credentials", async () => {
      const adapter = new NullAuthAdapter();
      const c = await makeContext({ authorization: "Bearer token" });

      expect(adapter.extractCredentials(c)).toBeNull();
    });

    it("should always fail validation", async () => {
      const adapter = new NullAuthAdapter();
      const result = await adapter.validateCredentials({
        type: "bearer",
        token: "any",
      });

      expect(result.success).toBe(false);
    });
  });

  describe("createUserContext", () => {
    it("should create user context from user and session", () => {
      const user = {
        id: "user-123",
        email: "test@test.com",
        name: "Test User",
        image: "https://example.com/avatar.png",
        emailVerified: new Date(),
        metadata: { role: "admin" },
      };

      const session: SessionData = {
        id: "session-456",
        userId: "user-123",
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 3600000),
        data: { extra: "data" },
      };

      const context = createUserContext(user, session);

      expect(context.id).toBe("user-123");
      expect(context.email).toBe("test@test.com");
      expect(context.name).toBe("Test User");
      expect(context.sessionId).toBe("session-456");
      expect(context.metadata?.role).toBe("admin");
    });
  });
});

describe("Auth Middleware", () => {
  const createMockContext = async (
    user?: UserContext,
    session?: SessionData
  ): Promise<Context> => {
    const c = await makeContext();
    if (user) c.set("user", user);
    if (session) c.set("session", session);
    return c;
  };

  describe("getUser", () => {
    it("should return user from request", async () => {
      const mockUser: UserContext = {
        id: "user-123",
        email: "test@test.com",
        name: "Test",
        image: null,
        emailVerified: null,
        sessionId: "s1",
        sessionExpiresAt: new Date(),
      };

      const c = await createMockContext(mockUser);
      expect(getUser(c)).toEqual(mockUser);
    });

    it("should return undefined when no user", async () => {
      const c = await createMockContext();
      expect(getUser(c)).toBeUndefined();
    });
  });

  describe("requireAuth", () => {
    it("should call next when user exists", async () => {
      const mockUser: UserContext = {
        id: "user-123",
        email: "test@test.com",
        name: "Test",
        image: null,
        emailVerified: null,
        sessionId: "s1",
        sessionExpiresAt: new Date(),
      };

      const c = await createMockContext(mockUser);
      const next = vi.fn();

      await requireAuth()(c, next);

      expect(next).toHaveBeenCalled();
    });

    it("should throw error when no user", async () => {
      const c = await createMockContext();
      const next = vi.fn();

      await expect(requireAuth()(c, next)).rejects.toThrow(
        /Authentication required/
      );
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe("requireRole", () => {
    it("should allow user with matching role", async () => {
      const mockUser: UserContext = {
        id: "user-123",
        email: "test@test.com",
        name: "Test",
        image: null,
        emailVerified: null,
        sessionId: "s1",
        sessionExpiresAt: new Date(),
        metadata: { role: "admin" },
      };

      const c = await createMockContext(mockUser);
      const next = vi.fn();

      await requireRole("admin")(c, next);

      expect(next).toHaveBeenCalled();
    });

    it("should throw error when user lacks role", async () => {
      const mockUser: UserContext = {
        id: "user-123",
        email: "test@test.com",
        name: "Test",
        image: null,
        emailVerified: null,
        sessionId: "s1",
        sessionExpiresAt: new Date(),
        metadata: { role: "user" },
      };

      const c = await createMockContext(mockUser);
      const next = vi.fn();

      await expect(requireRole("admin")(c, next)).rejects.toThrow(/admin/);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe("rateByUser", () => {
    it("should return user id for authenticated requests", async () => {
      const mockUser: UserContext = {
        id: "user-123",
        email: "test@test.com",
        name: "Test",
        image: null,
        emailVerified: null,
        sessionId: "s1",
        sessionExpiresAt: new Date(),
      };

      const c = await createMockContext(mockUser);
      expect(rateByUser(c)).toBe("user-123");
    });

    it("should return ip for unauthenticated requests", async () => {
      const c = await makeContext({ "x-forwarded-for": "127.0.0.1" });

      expect(rateByUser(c)).toBe("127.0.0.1");
    });
  });
});

describe("Scope Resolution", () => {
  describe("ScopeResolver", () => {
    it("should resolve public read operations", async () => {
      const resolver = new ScopeResolver(
        { public: { read: true } },
        "users"
      );

      const scope = await resolver.resolve("read", null);
      expect(scope.toString()).toBe("*");
    });

    it("should require auth for non-public operations", async () => {
      const resolver = new ScopeResolver(
        { public: { read: true } },
        "users"
      );

      await expect(resolver.resolve("create", null)).rejects.toThrow();
    });

    it("should resolve scope from scope function", async () => {
      const resolver = new ScopeResolver(
        {
          scope: async (user) => eq("userId", user.id),
        },
        "users"
      );

      const mockUser: UserContext = {
        id: "user-123",
        email: "test@test.com",
        name: "Test",
        image: null,
        emailVerified: null,
        sessionId: "s1",
        sessionExpiresAt: new Date(),
      };

      const scope = await resolver.resolve("read", mockUser);
      expect(scope.toString()).toContain("user-123");
    });

    it("should use operation-specific scope", async () => {
      const resolver = new ScopeResolver(
        {
          read: async () => allScope(),
          update: async (user) => eq("userId", user.id),
        },
        "users"
      );

      const mockUser: UserContext = {
        id: "user-123",
        email: "test@test.com",
        name: "Test",
        image: null,
        emailVerified: null,
        sessionId: "s1",
        sessionExpiresAt: new Date(),
      };

      const readScope = await resolver.resolve("read", mockUser);
      expect(readScope.toString()).toBe("*");

      const updateScope = await resolver.resolve("update", mockUser);
      expect(updateScope.toString()).toContain("userId");
    });

    it("should check if operation can be performed", async () => {
      const resolver = new ScopeResolver(
        { public: { read: true } },
        "users"
      );

      expect(await resolver.canPerform("read", null)).toBe(true);
      expect(await resolver.canPerform("create", null)).toBe(false);
    });
  });

  describe("Scope Patterns", () => {
    const mockUser: UserContext = {
      id: "user-123",
      email: "test@test.com",
      name: "Test",
      image: null,
      emailVerified: null,
      sessionId: "s1",
      sessionExpiresAt: new Date(),
    };

    it("should create owner-only scope", async () => {
      const config = scopePatterns.ownerOnly("ownerId");
      const resolver = createScopeResolver(config, "items");

      const scope = await resolver.resolve("read", mockUser);
      expect(scope.toString()).toContain("ownerId");
      expect(scope.toString()).toContain("user-123");
    });

    it("should create public-read-owner-write scope", async () => {
      const config = scopePatterns.publicReadOwnerWrite("authorId");
      const resolver = createScopeResolver(config, "posts");

      const readScope = await resolver.resolve("read", null);
      expect(readScope.toString()).toBe("*");

      const updateScope = await resolver.resolve("update", mockUser);
      expect(updateScope.toString()).toContain("authorId");
    });

    it("should create org-based scope", async () => {
      const userWithOrg: UserContext = {
        ...mockUser,
        metadata: { organizationId: "org-456" },
      };

      const config = scopePatterns.orgBased("orgId");
      const resolver = createScopeResolver(config, "documents");

      const scope = await resolver.resolve("read", userWithOrg);
      expect(scope.toString()).toContain("org-456");
    });

    it("should create fully public scope", async () => {
      const config = scopePatterns.fullyPublic();
      const resolver = createScopeResolver(config, "public-items");

      expect(await resolver.canPerform("read", null)).toBe(true);
      expect(await resolver.canPerform("create", mockUser)).toBe(true);
    });
  });

  describe("combineScopes", () => {
    it("should combine user scope with additional filter", () => {
      const userScope = eq("userId", "user-123");
      const combined = combineScopes(userScope, 'status=="active"');

      expect(combined).toContain("userId");
      expect(combined).toContain("status");
    });

    it("should return filter when scope is all", () => {
      const combined = combineScopes(allScope(), 'status=="active"');
      expect(combined).toBe('status=="active"');
    });

    it("should return scope string when no additional filter", () => {
      const userScope = eq("userId", "user-123");
      const combined = combineScopes(userScope);

      expect(combined).toContain("userId");
    });
  });
});

describe("RSQL Builder", () => {
  describe("Basic Operators", () => {
    it("should build equality expression", () => {
      const scope = eq("status", "active");
      expect(scope.toString()).toBe('status=="active"');
    });

    it("should build inequality expression", () => {
      const scope = ne("status", "deleted");
      expect(scope.toString()).toBe('status!="deleted"');
    });

    it("should build comparison expressions", () => {
      expect(gt("age", 18).toString()).toBe('age=gt=18');
      expect(gte("age", 18).toString()).toBe('age=ge=18');
      expect(lt("age", 65).toString()).toBe('age=lt=65');
      expect(lte("age", 65).toString()).toBe('age=le=65');
    });

    it("should build set membership expressions", () => {
      expect(inList("status", ["active", "pending"]).toString()).toBe(
        'status=in=("active","pending")'
      );
      expect(notIn("status", ["deleted"]).toString()).toBe(
        'status=out=("deleted")'
      );
    });

    it("should build like expression", () => {
      expect(like("name", "%john%").toString()).toBe('name%="%john%"');
    });

    it("should build not-like expression", () => {
      expect(notLike("name", "%john%").toString()).toBe('name!%="%john%"');
    });

    it("should build null check expressions", () => {
      expect(isNull("deletedAt").toString()).toBe("deletedAt=isnull=true");
      expect(isNotNull("email").toString()).toBe("email=isnull=false");
    });
  });

  describe("Logical Operators", () => {
    it("should build AND expression", () => {
      const scope = and(eq("status", "active"), gt("age", 18));
      expect(scope.toString()).toContain("status");
      expect(scope.toString()).toContain("age");
      expect(scope.toString()).toContain(";");
    });

    it("should build OR expression", () => {
      const scope = or(eq("status", "active"), eq("status", "pending"));
      expect(scope.toString()).toContain("active");
      expect(scope.toString()).toContain("pending");
      expect(scope.toString()).toContain(",");
    });

    it("should handle empty scopes in logical ops", () => {
      const empty = emptyScope();
      const active = eq("status", "active");

      expect(and(empty, active).toString()).toBe(active.toString());
      expect(or(empty, active).toString()).toBe(active.toString());
    });
  });

  describe("Template String Builder", () => {
    it("should build expression from template", () => {
      const userId = "user-123";
      const scope = rsql`userId==${userId}`;
      expect(scope.toString()).toBe('userId=="user-123"');
    });

    it("should escape special characters", () => {
      const name = 'John "Johnny" Doe';
      const scope = rsql`name==${name}`;
      expect(scope.toString()).toContain("John");
    });

    it("should handle numbers", () => {
      const age = 25;
      const scope = rsql`age>=${age}`;
      expect(scope.toString()).toContain("25");
    });

    it("should handle dates", () => {
      const date = new Date("2024-01-01");
      const scope = rsql`createdAt>="${date}"`;
      expect(scope.toString()).toContain("2024");
    });

    it("should handle arrays", () => {
      const statuses = ["active", "pending"];
      const scope = rsql`status=in=${statuses}`;
      expect(scope.toString()).toContain("active");
      expect(scope.toString()).toContain("pending");
    });
  });

  describe("Pattern Helpers", () => {
    it("should build owner scope", () => {
      expect(ownerScope("user-123").toString()).toBe('userId=="user-123"');
      expect(ownerScope("user-123", "authorId").toString()).toBe(
        'authorId=="user-123"'
      );
    });

    it("should build public scope", () => {
      expect(publicScope().toString()).toBe('public==true');
      expect(publicScope("isPublic").toString()).toBe('isPublic==true');
    });

    it("should build owner or public scope", () => {
      const scope = ownerOrPublic("user-123");
      expect(scope.toString()).toContain("userId");
      expect(scope.toString()).toContain("public");
    });
  });

  describe("Scope Composition", () => {
    it("should compose scopes with and", () => {
      const s1 = eq("status", "active");
      const s2 = gt("age", 18);
      const composed = s1.and(s2);

      expect(composed.toString()).toContain("status");
      expect(composed.toString()).toContain("age");
    });

    it("should compose scopes with or", () => {
      const s1 = eq("role", "admin");
      const s2 = eq("role", "moderator");
      const composed = s1.or(s2);

      expect(composed.toString()).toContain("admin");
      expect(composed.toString()).toContain("moderator");
    });

    it("should chain multiple compositions", () => {
      const scope = eq("status", "active")
        .and(gt("age", 18))
        .and(lt("age", 65));

      expect(scope.toString()).toContain("status");
      expect(scope.toString()).toContain("age");
    });
  });

  describe("Special Scopes", () => {
    it("should create empty scope", () => {
      const scope = emptyScope();
      expect(scope.isEmpty()).toBe(true);
      expect(scope.toString()).toBe("");
    });

    it("should create all scope", () => {
      const scope = allScope();
      expect(scope.isEmpty()).toBe(false);
      expect(scope.toString()).toBe("*");
    });

    it("should create scope from string", () => {
      const scope = scopeFromString('status=="active";age>18');
      expect(scope.toString()).toBe('status=="active";age>18');
    });
  });

  describe("Type Guards", () => {
    it("should identify compiled scopes", () => {
      expect(isCompiledScope(eq("a", "b"))).toBe(true);
      expect(isCompiledScope(allScope())).toBe(true);
      expect(isCompiledScope(emptyScope())).toBe(true);
      expect(isCompiledScope("string")).toBe(false);
      expect(isCompiledScope(null)).toBe(false);
      expect(isCompiledScope({})).toBe(false);
    });
  });
});
