import { describe, it, expect } from "vitest";
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
  and,
  or,
  emptyScope,
  allScope,
  isNull,
  isNotNull,
  ownerScope,
  publicScope,
  ownerOrPublic,
  scopeFromString,
} from "@/auth/rsql";

describe("RSQL Template Helper", () => {
  describe("rsql template literal", () => {
    it("should create scope expression from template", () => {
      const userId = "user-123";
      const scope = rsql`userId==${userId}`;

      expect(scope.toString()).toBe('userId=="user-123"');
    });

    it("should escape string values", () => {
      const name = 'John "Johnny" Doe';
      const scope = rsql`name==${name}`;

      expect(scope.toString()).toBe('name=="John \\"Johnny\\" Doe"');
    });

    it("should handle numbers", () => {
      const age = 25;
      const scope = rsql`age==${age}`;

      expect(scope.toString()).toBe("age==25");
    });

    it("should handle booleans", () => {
      const active = true;
      const scope = rsql`active==${active}`;

      expect(scope.toString()).toBe("active==true");
    });

    it("should handle dates", () => {
      const date = new Date("2024-01-01T00:00:00Z");
      const scope = rsql`createdAt=gt=${date}`;

      expect(scope.toString()).toBe('createdAt=gt="2024-01-01T00:00:00.000Z"');
    });

    it("should handle arrays", () => {
      const roles = ["admin", "user"];
      const scope = rsql`role=in=${roles}`;

      expect(scope.toString()).toBe('role=in=("admin","user")');
    });

    it("should handle null", () => {
      const value = null;
      const scope = rsql`deletedAt==${value}`;

      expect(scope.toString()).toBe("deletedAt==null");
    });
  });

  describe("Helper functions", () => {
    it("should create equality expression", () => {
      expect(eq("userId", "123").toString()).toBe('userId=="123"');
    });

    it("should create not-equal expression", () => {
      expect(ne("status", "deleted").toString()).toBe('status!="deleted"');
    });

    it("should create comparison expressions", () => {
      expect(gt("age", 18).toString()).toBe("age=gt=18");
      expect(gte("age", 18).toString()).toBe("age=ge=18");
      expect(lt("age", 65).toString()).toBe("age=lt=65");
      expect(lte("age", 65).toString()).toBe("age=le=65");
    });

    it("should create list expressions", () => {
      expect(inList("role", ["admin", "user"]).toString()).toBe(
        'role=in=("admin","user")'
      );
      expect(notIn("status", ["deleted", "banned"]).toString()).toBe(
        'status=out=("deleted","banned")'
      );
    });

    it("should create null check expressions", () => {
      expect(isNull("deletedAt").toString()).toBe("deletedAt=isnull=true");
      expect(isNotNull("email").toString()).toBe("email=isnull=false");
    });
  });

  describe("Scope combinators", () => {
    it("should combine scopes with AND", () => {
      const scope1 = eq("status", "active");
      const scope2 = gt("age", 18);
      const combined = and(scope1, scope2);

      expect(combined.toString()).toBe('(status=="active");(age=gt=18)');
    });

    it("should combine scopes with OR", () => {
      const scope1 = eq("role", "admin");
      const scope2 = eq("role", "moderator");
      const combined = or(scope1, scope2);

      expect(combined.toString()).toBe('(role=="admin"),(role=="moderator")');
    });

    it("should chain AND and OR", () => {
      const adminOrMod = or(eq("role", "admin"), eq("role", "moderator"));
      const activeAndPrivileged = and(eq("status", "active"), adminOrMod);

      expect(activeAndPrivileged.toString()).toContain("status");
      expect(activeAndPrivileged.toString()).toContain("role");
    });

    it("should skip empty scopes in AND", () => {
      const scope = and(emptyScope(), eq("userId", "123"));
      expect(scope.toString()).toBe('userId=="123"');
    });

    it("should skip empty scopes in OR", () => {
      const scope = or(emptyScope(), eq("userId", "123"));
      expect(scope.toString()).toBe('userId=="123"');
    });
  });

  describe("Special scopes", () => {
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
  });

  describe("Scope methods", () => {
    it("should chain with and method", () => {
      const scope = eq("userId", "123").and(eq("status", "active"));
      expect(scope.toString()).toContain("userId");
      expect(scope.toString()).toContain("status");
    });

    it("should chain with or method", () => {
      const scope = eq("role", "admin").or(eq("role", "user"));
      expect(scope.toString()).toContain("admin");
      expect(scope.toString()).toContain("user");
    });
  });

  describe("Common patterns", () => {
    it("should create owner scope", () => {
      const scope = ownerScope("user-123");
      expect(scope.toString()).toBe('userId=="user-123"');
    });

    it("should create owner scope with custom field", () => {
      const scope = ownerScope("user-123", "authorId");
      expect(scope.toString()).toBe('authorId=="user-123"');
    });

    it("should create public scope", () => {
      const scope = publicScope();
      expect(scope.toString()).toBe("public==true");
    });

    it("should create owner or public scope", () => {
      const scope = ownerOrPublic("user-123");
      expect(scope.toString()).toContain("userId");
      expect(scope.toString()).toContain("public");
    });
  });

  describe("scopeFromString", () => {
    it("should create scope from string", () => {
      const scope = scopeFromString('status=="active"');
      expect(scope.toString()).toBe('status=="active"');
    });
  });

  // A CompiledScope interpolated into an rsql`` template (or any escaped value)
  // is embedded as a parenthesized sub-expression — so scopes compose, rather
  // than being stringified into a quoted string literal.
  describe("composing scopes via interpolation", () => {
    it("embeds an interpolated scope as a parenthesized sub-expression", () => {
      const scope = rsql`status=="active";${eq("userId", "u-1")}`;
      expect(scope.toString()).toBe('status=="active";(userId=="u-1")');
    });

    it("does NOT stringify an interpolated scope into a quoted literal", () => {
      const scope = rsql`${eq("a", 1)};name==${"bob"}`;
      // The scope is parenthesized; the plain string value is still quoted.
      expect(scope.toString()).toBe('(a==1);name=="bob"');
      // Guard against the previous behavior, which quoted the whole sub-scope.
      expect(scope.toString()).not.toContain('"a==1"');
    });

    it("interpolating two scopes matches the `and` combinator", () => {
      const a = eq("a", 1);
      const b = eq("b", 2);
      expect(rsql`${a};${b}`.toString()).toBe(and(a, b).toString());
      expect(rsql`${a};${b}`.toString()).toBe("(a==1);(b==2)");
    });

    it("embeds a composite (or) scope, preserving its grouping", () => {
      const roles = or(eq("role", "admin"), eq("role", "moderator"));
      const scope = rsql`tenantId==${"t1"};${roles}`;
      expect(scope.toString()).toBe(
        'tenantId=="t1";((role=="admin"),(role=="moderator"))'
      );
    });

    it("supports nested interpolation (scope in a template in a template)", () => {
      const inner = eq("a", 1);
      const mid = rsql`${inner};b==${2}`;
      expect(mid.toString()).toBe("(a==1);b==2");
      const outer = rsql`${mid},c==${3}`;
      expect(outer.toString()).toBe("((a==1);b==2),c==3");
    });

    it("embeds helper-built and ownerScope expressions", () => {
      const scope = rsql`${ownerScope("user-123")},${publicScope()}`;
      expect(scope.toString()).toBe('(userId=="user-123"),(public==true)');
    });

    it("embeds the all-scope as a sub-expression", () => {
      expect(rsql`x==${1};${allScope()}`.toString()).toBe("x==1;(*)");
    });
  });
});
