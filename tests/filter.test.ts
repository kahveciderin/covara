import { describe, it, expect, beforeEach } from "vitest";
import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { createResourceFilter, DENY_ALL_FILTER } from "@/resource/filter";
import { FilterParseError } from "@/resource/error";

const testTable = sqliteTable("test_items", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  age: integer("age").notNull(),
  score: real("score"),
  status: text("status"),
  category: text("category"),
  isActive: integer("is_active"),
});

type TestItem = {
  id: number;
  name: string;
  email: string;
  age: number;
  score: number | null;
  status: string | null;
  category: string | null;
  isActive: number | null;
};

describe("Filter System", () => {
  let filter: ReturnType<typeof createResourceFilter>;

  beforeEach(() => {
    filter = createResourceFilter(testTable);
    filter.clearCache();
  });

  describe("Deny sentinel (DENY_ALL_FILTER)", () => {
    it("executes to false for any row", () => {
      expect(filter.execute(DENY_ALL_FILTER, { id: 1, name: "x" } as any)).toBe(false);
      expect(filter.execute(DENY_ALL_FILTER, {} as any)).toBe(false);
    });

    it("converts to a SQL contradiction without throwing", () => {
      const compiled = filter.compile(DENY_ALL_FILTER);
      expect(() => compiled.convert()).not.toThrow();
      expect(compiled.requiresJoin()).toBe(false);
    });

    it("is not confused with an empty filter (which matches all)", () => {
      expect(filter.execute("", { id: 1 } as any)).toBe(true);
      expect(filter.execute(DENY_ALL_FILTER, { id: 1 } as any)).toBe(false);
    });
  });

  describe("Basic Equality Operators", () => {
    const testItem: TestItem = {
      id: 1,
      name: "John Doe",
      email: "john@example.com",
      age: 30,
      score: 85.5,
      status: "active",
      category: "premium",
      isActive: 1,
    };

    it("should match equality with ==", () => {
      expect(filter.execute('name=="John Doe"', testItem)).toBe(true);
      expect(filter.execute('name=="Jane Doe"', testItem)).toBe(false);
    });

    it("should match inequality with !=", () => {
      expect(filter.execute('name!="Jane Doe"', testItem)).toBe(true);
      expect(filter.execute('name!="John Doe"', testItem)).toBe(false);
    });

    it("should match numeric equality", () => {
      expect(filter.execute("age==30", testItem)).toBe(true);
      expect(filter.execute("age==25", testItem)).toBe(false);
    });

    it("should handle string-to-number comparison", () => {
      expect(filter.execute('age=="30"', testItem)).toBe(true);
    });
  });

  describe("Comparison Operators", () => {
    const testItem: TestItem = {
      id: 1,
      name: "John",
      email: "john@test.com",
      age: 30,
      score: 85.5,
      status: "active",
      category: null,
      isActive: 1,
    };

    it("should match greater than with >", () => {
      expect(filter.execute("age>25", testItem)).toBe(true);
      expect(filter.execute("age>30", testItem)).toBe(false);
      expect(filter.execute("age>35", testItem)).toBe(false);
    });

    it("should match less than with <", () => {
      expect(filter.execute("age<35", testItem)).toBe(true);
      expect(filter.execute("age<30", testItem)).toBe(false);
      expect(filter.execute("age<25", testItem)).toBe(false);
    });

    it("should match greater than or equal with >=", () => {
      expect(filter.execute("age>=30", testItem)).toBe(true);
      expect(filter.execute("age>=25", testItem)).toBe(true);
      expect(filter.execute("age>=35", testItem)).toBe(false);
    });

    it("should match less than or equal with <=", () => {
      expect(filter.execute("age<=30", testItem)).toBe(true);
      expect(filter.execute("age<=35", testItem)).toBe(true);
      expect(filter.execute("age<=25", testItem)).toBe(false);
    });

    it("should handle decimal comparisons", () => {
      expect(filter.execute("score>80", testItem)).toBe(true);
      expect(filter.execute("score>85.5", testItem)).toBe(false);
      expect(filter.execute("score>=85.5", testItem)).toBe(true);
      expect(filter.execute("score<90", testItem)).toBe(true);
    });

    it("should handle negative numbers", () => {
      const itemWithNegative = { ...testItem, score: -10.5 };
      expect(filter.execute("score<0", itemWithNegative)).toBe(true);
      expect(filter.execute("score>-20", itemWithNegative)).toBe(true);
      expect(filter.execute("score==-10.5", itemWithNegative)).toBe(true);
    });
  });

  describe("LIKE Pattern Matching", () => {
    const testItem: TestItem = {
      id: 1,
      name: "John Doe",
      email: "john.doe@example.com",
      age: 30,
      score: 85,
      status: "active",
      category: "premium_user",
      isActive: 1,
    };

    it("should match prefix with %=", () => {
      expect(filter.execute('name%="John%"', testItem)).toBe(true);
      expect(filter.execute('name%="Jane%"', testItem)).toBe(false);
    });

    it("should match suffix with %=", () => {
      expect(filter.execute('name%="%Doe"', testItem)).toBe(true);
      expect(filter.execute('name%="%Smith"', testItem)).toBe(false);
    });

    it("should match contains with %=", () => {
      expect(filter.execute('email%="%@example%"', testItem)).toBe(true);
      expect(filter.execute('email%="%@gmail%"', testItem)).toBe(false);
    });

    it("should match single character wildcard with _", () => {
      expect(filter.execute('name%="John_Doe"', testItem)).toBe(true);
      expect(filter.execute('name%="John__Doe"', testItem)).toBe(false);
    });

    it("should match NOT LIKE with !%=", () => {
      expect(filter.execute('name!%="Jane%"', testItem)).toBe(true);
      expect(filter.execute('name!%="John%"', testItem)).toBe(false);
    });

    it("should handle complex patterns", () => {
      expect(filter.execute('email%="%.%@%.%"', testItem)).toBe(true);
      expect(filter.execute('category%="%_user"', testItem)).toBe(true);
    });
  });

  describe("Logical AND Operations", () => {
    const testItem: TestItem = {
      id: 1,
      name: "John",
      email: "john@test.com",
      age: 30,
      score: 85,
      status: "active",
      category: "premium",
      isActive: 1,
    };

    it("should combine conditions with ; (semicolon)", () => {
      expect(filter.execute('name=="John";age==30', testItem)).toBe(true);
      expect(filter.execute('name=="John";age==25', testItem)).toBe(false);
      expect(filter.execute('name=="Jane";age==30', testItem)).toBe(false);
    });

    it("should combine conditions with && operator", () => {
      expect(filter.execute('name=="John"&&age==30', testItem)).toBe(true);
      expect(filter.execute('name=="John"&&age==25', testItem)).toBe(false);
    });

    it("should combine conditions with AND keyword", () => {
      expect(filter.execute('name=="John" AND age==30', testItem)).toBe(true);
      expect(filter.execute('name=="John" and age==30', testItem)).toBe(true);
    });

    it("should handle multiple AND conditions", () => {
      expect(
        filter.execute('name=="John";age==30;status=="active"', testItem)
      ).toBe(true);
      expect(
        filter.execute('name=="John";age==30;status=="inactive"', testItem)
      ).toBe(false);
    });

    it("should require all conditions to be true", () => {
      expect(
        filter.execute(
          'name=="John";age>25;status=="active";category=="premium"',
          testItem
        )
      ).toBe(true);
      expect(
        filter.execute(
          'name=="John";age>35;status=="active";category=="premium"',
          testItem
        )
      ).toBe(false);
    });
  });

  describe("Logical OR Operations", () => {
    const testItem: TestItem = {
      id: 1,
      name: "John",
      email: "john@test.com",
      age: 30,
      score: 85,
      status: "active",
      category: "premium",
      isActive: 1,
    };

    it("should combine conditions with , (comma)", () => {
      expect(filter.execute('name=="John",name=="Jane"', testItem)).toBe(true);
      expect(filter.execute('name=="Jane",name=="Bob"', testItem)).toBe(false);
    });

    it("should combine conditions with || operator", () => {
      expect(filter.execute('name=="John"||name=="Jane"', testItem)).toBe(true);
      expect(filter.execute('name=="Jane"||name=="Bob"', testItem)).toBe(false);
    });

    it("should combine conditions with OR keyword", () => {
      expect(filter.execute('name=="John" OR name=="Jane"', testItem)).toBe(
        true
      );
      expect(filter.execute('name=="John" or name=="Jane"', testItem)).toBe(
        true
      );
    });

    it("should require at least one condition to be true", () => {
      expect(filter.execute('age==25,age==30,age==35', testItem)).toBe(true);
      expect(filter.execute('age==25,age==35,age==40', testItem)).toBe(false);
    });
  });

  describe("Complex Nested Expressions", () => {
    const testItem: TestItem = {
      id: 1,
      name: "John",
      email: "john@test.com",
      age: 30,
      score: 85,
      status: "active",
      category: "premium",
      isActive: 1,
    };

    it("should handle parenthesized expressions", () => {
      expect(filter.execute('(name=="John")', testItem)).toBe(true);
      expect(filter.execute('(name=="John");(age==30)', testItem)).toBe(true);
    });

    it("should handle nested AND within OR", () => {
      // (name==John AND age==30) OR (name==Jane AND age==25)
      expect(
        filter.execute('(name=="John";age==30),(name=="Jane";age==25)', testItem)
      ).toBe(true);
      expect(
        filter.execute('(name=="Bob";age==30),(name=="Jane";age==25)', testItem)
      ).toBe(false);
    });

    it("should handle nested OR within AND", () => {
      // (name==John OR name==Jane) AND (age==30)
      expect(
        filter.execute('(name=="John",name=="Jane");age==30', testItem)
      ).toBe(true);
      expect(
        filter.execute('(name=="Bob",name=="Jane");age==30', testItem)
      ).toBe(false);
    });

    it("should handle deeply nested expressions", () => {
      expect(
        filter.execute(
          '((name=="John";age>=25),(name=="Jane";age>=20));status=="active"',
          testItem
        )
      ).toBe(true);
    });

    it("should handle complex real-world queries", () => {
      // active premium users aged 25-40 OR any admin
      expect(
        filter.execute(
          '(status=="active";category=="premium";age>=25;age<=40),(category=="admin")',
          testItem
        )
      ).toBe(true);
    });
  });

  describe("Set/Tuple Values", () => {
    const testItem: TestItem = {
      id: 1,
      name: "John",
      email: "john@test.com",
      age: 30,
      score: 85,
      status: "active",
      category: "premium",
      isActive: 1,
    };

    it("should parse set values correctly", () => {
      const compiled = filter.compile('status==("active","inactive","pending")');
      expect(compiled.print()).toContain("active");
    });

    it("should parse numeric sets", () => {
      const compiled = filter.compile("age==(25, 30, 35)");
      expect(compiled.print()).toContain("25");
      expect(compiled.print()).toContain("30");
      expect(compiled.print()).toContain("35");
    });

    it("should parse mixed sets", () => {
      const compiled = filter.compile('score==(80, 85.5, 90)');
      expect(compiled.print()).toContain("80");
      expect(compiled.print()).toContain("85.5");
    });
  });

  describe("Edge Cases and Error Handling", () => {
    const testItem: TestItem = {
      id: 1,
      name: "John",
      email: "john@test.com",
      age: 30,
      score: 85,
      status: "active",
      category: null,
      isActive: 1,
    };

    it("should handle empty filter expression", () => {
      expect(filter.execute("", testItem)).toBe(true);
      expect(filter.execute("   ", testItem)).toBe(true);
    });

    it("should return false for invalid column name in execute", () => {
      // execute doesn't validate columns, it just returns undefined for invalid columns
      // which causes the comparison to fail (undefined == "value" is false)
      expect(filter.execute('invalidColumn=="value"', testItem)).toBe(false);
    });

    it("should throw on invalid column name in convert", () => {
      expect(() => filter.convert('invalidColumn=="value"')).toThrow(
        FilterParseError
      );
    });

    it("should throw on unknown operator", () => {
      expect(() => filter.execute('name=unknown="value"', testItem)).toThrow(
        FilterParseError
      );
    });

    it("should throw on unterminated string", () => {
      expect(() => filter.execute('name=="unterminated', testItem)).toThrow(
        FilterParseError
      );
    });

    it("should throw on unterminated parenthesis", () => {
      expect(() => filter.execute('(name=="John"', testItem)).toThrow(
        FilterParseError
      );
    });

    it("should throw on invalid number format", () => {
      expect(() => filter.execute("age==abc", testItem)).toThrow(FilterParseError);
    });

    it("should handle whitespace variations", () => {
      expect(filter.execute('name == "John"', testItem)).toBe(true);
      expect(filter.execute('  name=="John"  ', testItem)).toBe(true);
      expect(filter.execute('name=="John" ; age==30', testItem)).toBe(true);
    });

    it("should handle escaped quotes in strings", () => {
      const itemWithQuotes = { ...testItem, name: 'John "The Man" Doe' };
      expect(filter.execute('name=="John \\"The Man\\" Doe"', itemWithQuotes)).toBe(
        true
      );
    });

    it("should handle null values", () => {
      expect(filter.execute('category=="premium"', testItem)).toBe(false);
    });
  });

  describe("Filter Caching", () => {
    it("should cache compiled filters", () => {
      const expr = 'name=="John";age==30';
      const compiled1 = filter.compile(expr);
      const compiled2 = filter.compile(expr);
      expect(compiled1).toBe(compiled2);
    });

    it("should clear cache when requested", () => {
      const expr = 'name=="John"';
      filter.compile(expr);
      filter.clearCache();
      const compiled = filter.compile(expr);
      expect(compiled).toBeDefined();
    });

    it("should maintain separate cache entries for different expressions", () => {
      const compiled1 = filter.compile('name=="John"');
      const compiled2 = filter.compile('name=="Jane"');
      expect(compiled1).not.toBe(compiled2);
    });
  });

  describe("Custom Operators", () => {
    it("should support custom operators", () => {
      const customFilter = createResourceFilter(testTable, {
        "=contains=": {
          convert: (lhs, rhs) => {
            const { sql } = require("drizzle-orm");
            return sql`${lhs} LIKE '%' || ${rhs} || '%'`;
          },
          execute: (lhs, rhs) => String(lhs).includes(String(rhs)),
        },
        "=startswith=": {
          convert: (lhs, rhs) => {
            const { sql } = require("drizzle-orm");
            return sql`${lhs} LIKE ${rhs} || '%'`;
          },
          execute: (lhs, rhs) => String(lhs).startsWith(String(rhs)),
        },
        "=endswith=": {
          convert: (lhs, rhs) => {
            const { sql } = require("drizzle-orm");
            return sql`${lhs} LIKE '%' || ${rhs}`;
          },
          execute: (lhs, rhs) => String(lhs).endsWith(String(rhs)),
        },
      });

      const testItem: TestItem = {
        id: 1,
        name: "John Doe",
        email: "john@example.com",
        age: 30,
        score: 85,
        status: "active",
        category: "premium",
        isActive: 1,
      };

      expect(customFilter.execute('name=contains="ohn"', testItem)).toBe(true);
      expect(customFilter.execute('name=contains="xyz"', testItem)).toBe(false);
      expect(customFilter.execute('name=startswith="John"', testItem)).toBe(true);
      expect(customFilter.execute('name=startswith="Jane"', testItem)).toBe(false);
      expect(customFilter.execute('name=endswith="Doe"', testItem)).toBe(true);
      expect(customFilter.execute('name=endswith="Smith"', testItem)).toBe(false);
    });

    it("should combine custom operators with built-in operators", () => {
      const customFilter = createResourceFilter(testTable, {
        "=between=": {
          convert: (lhs, rhs) => {
            const { sql } = require("drizzle-orm");
            return sql`${lhs} BETWEEN 0 AND 100`;
          },
          execute: (lhs, rhs) => {
            const val = Number(lhs);
            const arr = rhs as unknown as number[];
            return val >= arr[0] && val <= arr[1];
          },
        },
      });

      const testItem: TestItem = {
        id: 1,
        name: "John",
        email: "john@test.com",
        age: 30,
        score: 85,
        status: "active",
        category: "premium",
        isActive: 1,
      };

      expect(
        customFilter.execute('name=="John";age=between=(20, 40)', testItem)
      ).toBe(true);
    });
  });

  describe("SQL Conversion", () => {
    it("should convert simple equality to SQL", () => {
      const sql = filter.convert('name=="John"');
      expect(sql).toBeDefined();
    });

    it("should convert comparison operators to SQL", () => {
      const sql = filter.convert("age>=25;age<=40");
      expect(sql).toBeDefined();
    });

    it("should convert LIKE patterns to SQL", () => {
      const sql = filter.convert('email%="%@example.com"');
      expect(sql).toBeDefined();
    });

    it("should convert complex expressions to SQL", () => {
      const sql = filter.convert(
        '(status=="active";category=="premium"),(status=="pending")'
      );
      expect(sql).toBeDefined();
    });
  });

  describe("Print/Debug Output", () => {
    it("should produce readable debug output", () => {
      const compiled = filter.compile('name=="John";age>=25');
      const output = compiled.print();
      expect(output).toContain("name");
      expect(output).toContain("John");
      expect(output).toContain("age");
      expect(output).toContain("25");
    });

    it("should show AND/OR structure in output", () => {
      const compiled = filter.compile('(name=="John"),(name=="Jane")');
      const output = compiled.print();
      expect(output).toContain("OR");
    });
  });

  describe("Performance", () => {
    it("should handle large number of conditions efficiently", () => {
      const conditions: string[] = [];
      for (let i = 0; i < 100; i++) {
        conditions.push(`age==${i}`);
      }
      const expr = conditions.join(",");

      const start = performance.now();
      const compiled = filter.compile(expr);
      const compileTime = performance.now() - start;

      expect(compileTime).toBeLessThan(100);
      expect(compiled).toBeDefined();
    });

    it("should benefit from caching on repeated access", () => {
      const expr = 'name=="John";age>=25;status=="active"';

      const start1 = performance.now();
      filter.compile(expr);
      const firstTime = performance.now() - start1;

      const start2 = performance.now();
      for (let i = 0; i < 1000; i++) {
        filter.compile(expr);
      }
      const cachedTime = (performance.now() - start2) / 1000;

      expect(cachedTime).toBeLessThan(firstTime);
    });

    it("should execute filters quickly on objects", () => {
      const testItem: TestItem = {
        id: 1,
        name: "John",
        email: "john@test.com",
        age: 30,
        score: 85,
        status: "active",
        category: "premium",
        isActive: 1,
      };

      const expr = 'name=="John";age>=25;status=="active"';

      const start = performance.now();
      for (let i = 0; i < 10000; i++) {
        filter.execute(expr, testItem);
      }
      const totalTime = performance.now() - start;
      const avgTime = totalTime / 10000;

      expect(avgTime).toBeLessThan(0.1);
    });
  });

  describe("Boundary Conditions", () => {
    it("should handle very long strings", () => {
      // Use a string that's long but within the default maxLength (4096)
      const longName = "A".repeat(2000);
      const testItem: TestItem = {
        id: 1,
        name: longName,
        email: "test@test.com",
        age: 30,
        score: 85,
        status: "active",
        category: "premium",
        isActive: 1,
      };

      expect(filter.execute(`name=="${longName}"`, testItem)).toBe(true);
    });

    it("should reject filter expressions exceeding max length", () => {
      const veryLongName = "A".repeat(5000);
      expect(() => filter.execute(`name=="${veryLongName}"`, {} as TestItem)).toThrow();
    });

    it("should handle special characters in strings", () => {
      const specialName = "John (Jr.) O'Brien-Smith & Co.";
      const testItem: TestItem = {
        id: 1,
        name: specialName,
        email: "test@test.com",
        age: 30,
        score: 85,
        status: "active",
        category: "premium",
        isActive: 1,
      };

      expect(filter.execute(`name=="${specialName}"`, testItem)).toBe(true);
    });

    it("should handle zero values", () => {
      const testItem: TestItem = {
        id: 0,
        name: "Zero",
        email: "zero@test.com",
        age: 0,
        score: 0,
        status: "active",
        category: "premium",
        isActive: 0,
      };

      expect(filter.execute("id==0", testItem)).toBe(true);
      expect(filter.execute("age==0", testItem)).toBe(true);
      expect(filter.execute("score==0", testItem)).toBe(true);
    });

    it("should handle very large numbers", () => {
      const testItem: TestItem = {
        id: Number.MAX_SAFE_INTEGER,
        name: "Large",
        email: "large@test.com",
        age: 999999999,
        score: 1e20,
        status: "active",
        category: "premium",
        isActive: 1,
      };

      expect(filter.execute(`id==${Number.MAX_SAFE_INTEGER}`, testItem)).toBe(true);
      expect(filter.execute("age>999999998", testItem)).toBe(true);
    });

    it("should handle decimal precision", () => {
      const testItem: TestItem = {
        id: 1,
        name: "Decimal",
        email: "decimal@test.com",
        age: 30,
        score: 85.123456789,
        status: "active",
        category: "premium",
        isActive: 1,
      };

      expect(filter.execute("score==85.123456789", testItem)).toBe(true);
      expect(filter.execute("score>85.123456788", testItem)).toBe(true);
      expect(filter.execute("score<85.12345679", testItem)).toBe(true);
    });
  });

  describe("Date Filtering", () => {
    it("should parse ISO date strings and compare correctly", () => {
      const testItem = { id: 1, createdAt: "2024-06-15T10:30:00.000Z" };

      expect(filter.execute('createdAt=="2024-06-15T10:30:00.000Z"', testItem)).toBe(true);
      expect(filter.execute('createdAt>"2024-06-14T10:30:00.000Z"', testItem)).toBe(true);
      expect(filter.execute('createdAt<"2024-06-16T10:30:00.000Z"', testItem)).toBe(true);
      expect(filter.execute('createdAt>="2024-06-15T10:30:00.000Z"', testItem)).toBe(true);
      expect(filter.execute('createdAt<="2024-06-15T10:30:00.000Z"', testItem)).toBe(true);
    });

    it("should handle date-only format", () => {
      const testItem = { id: 1, createdAt: "2024-06-15" };

      expect(filter.execute('createdAt=="2024-06-15"', testItem)).toBe(true);
      expect(filter.execute('createdAt>"2024-06-14"', testItem)).toBe(true);
      expect(filter.execute('createdAt<"2024-06-16"', testItem)).toBe(true);
    });

    it("should compare dates across formats", () => {
      const testItem = { id: 1, createdAt: "2024-06-15T00:00:00.000Z" };

      // Comparing full ISO with date-only (dates at midnight should match)
      expect(filter.execute('createdAt>="2024-06-15"', testItem)).toBe(true);
    });

    it("should work with =gt=, =lt=, =ge=, =le= operators on dates", () => {
      const testItem = { id: 1, createdAt: "2024-06-15T10:30:00.000Z" };

      expect(filter.execute('createdAt=gt="2024-06-14"', testItem)).toBe(true);
      expect(filter.execute('createdAt=lt="2024-06-16"', testItem)).toBe(true);
      expect(filter.execute('createdAt=ge="2024-06-15"', testItem)).toBe(true);
      expect(filter.execute('createdAt=le="2024-06-16"', testItem)).toBe(true);
    });

    it("should handle date in =in= operator", () => {
      const testItem = { id: 1, createdAt: "2024-06-15T10:30:00.000Z" };

      expect(filter.execute('createdAt=in=("2024-06-15T10:30:00.000Z", "2024-06-16T10:30:00.000Z")', testItem)).toBe(true);
      expect(filter.execute('createdAt=in=("2024-06-14T10:30:00.000Z", "2024-06-16T10:30:00.000Z")', testItem)).toBe(false);
    });
  });

  describe("String Operators", () => {
    describe("=contains=", () => {
      it("should match substring", () => {
        const testItem = { id: 1, name: "Hello World" };

        expect(filter.execute('name=contains="World"', testItem)).toBe(true);
        expect(filter.execute('name=contains="Hello"', testItem)).toBe(true);
        expect(filter.execute('name=contains="lo Wo"', testItem)).toBe(true);
        expect(filter.execute('name=contains="Goodbye"', testItem)).toBe(false);
      });

      it("should be case-sensitive", () => {
        const testItem = { id: 1, name: "Hello World" };

        expect(filter.execute('name=contains="world"', testItem)).toBe(false);
        expect(filter.execute('name=contains="HELLO"', testItem)).toBe(false);
      });
    });

    describe("=icontains=", () => {
      it("should match substring case-insensitively", () => {
        const testItem = { id: 1, name: "Hello World" };

        expect(filter.execute('name=icontains="world"', testItem)).toBe(true);
        expect(filter.execute('name=icontains="HELLO"', testItem)).toBe(true);
        expect(filter.execute('name=icontains="LO WO"', testItem)).toBe(true);
        expect(filter.execute('name=icontains="goodbye"', testItem)).toBe(false);
      });
    });

    describe("=startswith=", () => {
      it("should match prefix", () => {
        const testItem = { id: 1, name: "Hello World" };

        expect(filter.execute('name=startswith="Hello"', testItem)).toBe(true);
        expect(filter.execute('name=startswith="Hell"', testItem)).toBe(true);
        expect(filter.execute('name=startswith="World"', testItem)).toBe(false);
      });
    });

    describe("=istartswith=", () => {
      it("should match prefix case-insensitively", () => {
        const testItem = { id: 1, name: "Hello World" };

        expect(filter.execute('name=istartswith="hello"', testItem)).toBe(true);
        expect(filter.execute('name=istartswith="HELLO"', testItem)).toBe(true);
        expect(filter.execute('name=istartswith="world"', testItem)).toBe(false);
      });
    });

    describe("=endswith=", () => {
      it("should match suffix", () => {
        const testItem = { id: 1, name: "Hello World" };

        expect(filter.execute('name=endswith="World"', testItem)).toBe(true);
        expect(filter.execute('name=endswith="orld"', testItem)).toBe(true);
        expect(filter.execute('name=endswith="Hello"', testItem)).toBe(false);
      });
    });

    describe("=iendswith=", () => {
      it("should match suffix case-insensitively", () => {
        const testItem = { id: 1, name: "Hello World" };

        expect(filter.execute('name=iendswith="world"', testItem)).toBe(true);
        expect(filter.execute('name=iendswith="WORLD"', testItem)).toBe(true);
        expect(filter.execute('name=iendswith="hello"', testItem)).toBe(false);
      });
    });

    describe("=ilike=", () => {
      it("should match pattern case-insensitively", () => {
        const testItem = { id: 1, name: "Hello World" };

        expect(filter.execute('name=ilike="%WORLD"', testItem)).toBe(true);
        expect(filter.execute('name=ilike="hello%"', testItem)).toBe(true);
        expect(filter.execute('name=ilike="%LO WO%"', testItem)).toBe(true);
      });
    });

    describe("=nilike=", () => {
      it("should NOT match pattern case-insensitively", () => {
        const testItem = { id: 1, name: "Hello World" };

        expect(filter.execute('name=nilike="%goodbye%"', testItem)).toBe(true);
        expect(filter.execute('name=nilike="%world"', testItem)).toBe(false);
      });
    });
  });

  describe("Case-Insensitive Equality", () => {
    describe("=ieq=", () => {
      it("should match equality case-insensitively", () => {
        const testItem = { id: 1, status: "Active" };

        expect(filter.execute('status=ieq="active"', testItem)).toBe(true);
        expect(filter.execute('status=ieq="ACTIVE"', testItem)).toBe(true);
        expect(filter.execute('status=ieq="AcTiVe"', testItem)).toBe(true);
        expect(filter.execute('status=ieq="inactive"', testItem)).toBe(false);
      });
    });

    describe("=ine=", () => {
      it("should match inequality case-insensitively", () => {
        const testItem = { id: 1, status: "Active" };

        expect(filter.execute('status=ine="inactive"', testItem)).toBe(true);
        expect(filter.execute('status=ine="INACTIVE"', testItem)).toBe(true);
        expect(filter.execute('status=ine="active"', testItem)).toBe(false);
      });
    });
  });

  describe("Null and Empty Checks", () => {
    describe("=isempty=", () => {
      it("should detect empty strings", () => {
        const testItem = { id: 1, name: "", description: null, title: "Hello" };

        expect(filter.execute('name=isempty=true', testItem)).toBe(true);
        expect(filter.execute('title=isempty=true', testItem)).toBe(false);
        expect(filter.execute('title=isempty=false', testItem)).toBe(true);
      });

      it("should detect null values as empty", () => {
        const testItem = { id: 1, description: null };

        expect(filter.execute('description=isempty=true', testItem)).toBe(true);
        expect(filter.execute('description=isempty=false', testItem)).toBe(false);
      });

      it("should detect undefined values as empty", () => {
        const testItem = { id: 1 };

        expect(filter.execute('description=isempty=true', testItem)).toBe(true);
      });
    });
  });

  describe("Range/Between Operators", () => {
    describe("=between=", () => {
      it("should match values within numeric range", () => {
        const testItem = { id: 1, age: 25 };

        expect(filter.execute('age=between=[18, 30]', testItem)).toBe(true);
        expect(filter.execute('age=between=[26, 30]', testItem)).toBe(false);
        expect(filter.execute('age=between=[18, 24]', testItem)).toBe(false);
      });

      it("should include boundary values", () => {
        const testItem = { id: 1, age: 25 };

        expect(filter.execute('age=between=[25, 30]', testItem)).toBe(true);
        expect(filter.execute('age=between=[18, 25]', testItem)).toBe(true);
      });

      it("should work with date ranges", () => {
        const testItem = { id: 1, createdAt: "2024-06-15T10:30:00.000Z" };

        expect(filter.execute('createdAt=between=["2024-06-01", "2024-06-30"]', testItem)).toBe(true);
        expect(filter.execute('createdAt=between=["2024-07-01", "2024-07-31"]', testItem)).toBe(false);
      });

      it("should work with set syntax too", () => {
        const testItem = { id: 1, age: 25 };

        expect(filter.execute('age=between=(18, 30)', testItem)).toBe(true);
      });
    });

    describe("=nbetween=", () => {
      it("should match values outside range", () => {
        const testItem = { id: 1, age: 25 };

        expect(filter.execute('age=nbetween=[30, 40]', testItem)).toBe(true);
        expect(filter.execute('age=nbetween=[18, 30]', testItem)).toBe(false);
      });
    });
  });

  describe("Regex Operators", () => {
    describe("=regex=", () => {
      it("should match regular expressions", () => {
        const testItem = { id: 1, email: "user@example.com" };

        expect(filter.execute('email=regex="^user@"', testItem)).toBe(true);
        expect(filter.execute('email=regex=".*@example\\.com$"', testItem)).toBe(true);
        expect(filter.execute('email=regex="^admin@"', testItem)).toBe(false);
      });

      it("should be case-sensitive", () => {
        const testItem = { id: 1, name: "Hello World" };

        expect(filter.execute('name=regex="^Hello"', testItem)).toBe(true);
        expect(filter.execute('name=regex="^hello"', testItem)).toBe(false);
      });
    });

    describe("=iregex=", () => {
      it("should match regular expressions case-insensitively", () => {
        const testItem = { id: 1, name: "Hello World" };

        expect(filter.execute('name=iregex="^hello"', testItem)).toBe(true);
        expect(filter.execute('name=iregex="WORLD$"', testItem)).toBe(true);
      });
    });
  });

  describe("Length Operators", () => {
    describe("=length=", () => {
      it("should match exact string length", () => {
        const testItem = { id: 1, code: "ABC123" };

        expect(filter.execute('code=length=6', testItem)).toBe(true);
        expect(filter.execute('code=length=5', testItem)).toBe(false);
        expect(filter.execute('code=length=7', testItem)).toBe(false);
      });
    });

    describe("=minlength=", () => {
      it("should match minimum string length", () => {
        const testItem = { id: 1, password: "secret123" };

        expect(filter.execute('password=minlength=8', testItem)).toBe(true);
        expect(filter.execute('password=minlength=9', testItem)).toBe(true);
        expect(filter.execute('password=minlength=10', testItem)).toBe(false);
      });
    });

    describe("=maxlength=", () => {
      it("should match maximum string length", () => {
        const testItem = { id: 1, username: "john" };

        expect(filter.execute('username=maxlength=10', testItem)).toBe(true);
        expect(filter.execute('username=maxlength=4', testItem)).toBe(true);
        expect(filter.execute('username=maxlength=3', testItem)).toBe(false);
      });
    });
  });

  describe("Boolean Comparisons", () => {
    describe("==true", () => {
      it("should match true boolean values", () => {
        expect(filter.execute('active==true', { id: 1, active: true })).toBe(true);
        expect(filter.execute('active==true', { id: 1, active: false })).toBe(false);
      });

      it("should match truthy number values (1)", () => {
        expect(filter.execute('active==true', { id: 1, active: 1 })).toBe(true);
        expect(filter.execute('active==true', { id: 1, active: 0 })).toBe(false);
      });

      it("should match truthy string values", () => {
        expect(filter.execute('active==true', { id: 1, active: "true" })).toBe(true);
        expect(filter.execute('active==true', { id: 1, active: "1" })).toBe(true);
        expect(filter.execute('active==true', { id: 1, active: "false" })).toBe(false);
      });
    });

    describe("==false", () => {
      it("should match false boolean values", () => {
        expect(filter.execute('active==false', { id: 1, active: false })).toBe(true);
        expect(filter.execute('active==false', { id: 1, active: true })).toBe(false);
      });

      it("should match falsy number values (0)", () => {
        expect(filter.execute('active==false', { id: 1, active: 0 })).toBe(true);
        expect(filter.execute('active==false', { id: 1, active: 1 })).toBe(false);
      });

      it("should match falsy string values", () => {
        expect(filter.execute('active==false', { id: 1, active: "false" })).toBe(true);
        expect(filter.execute('active==false', { id: 1, active: "0" })).toBe(true);
        expect(filter.execute('active==false', { id: 1, active: "true" })).toBe(false);
      });
    });

    describe("!=true and !=false", () => {
      it("should negate boolean comparisons", () => {
        expect(filter.execute('active!=true', { id: 1, active: false })).toBe(true);
        expect(filter.execute('active!=true', { id: 1, active: true })).toBe(false);
        expect(filter.execute('active!=false', { id: 1, active: true })).toBe(true);
        expect(filter.execute('active!=false', { id: 1, active: false })).toBe(false);
      });
    });
  });

  describe("RSQL Named Comparison Operators", () => {
    it("should support =gt= for greater than", () => {
      const testItem = { id: 1, age: 25 };
      expect(filter.execute('age=gt=20', testItem)).toBe(true);
      expect(filter.execute('age=gt=25', testItem)).toBe(false);
    });

    it("should support =ge= for greater than or equal", () => {
      const testItem = { id: 1, age: 25 };
      expect(filter.execute('age=ge=25', testItem)).toBe(true);
      expect(filter.execute('age=ge=26', testItem)).toBe(false);
    });

    it("should support =lt= for less than", () => {
      const testItem = { id: 1, age: 25 };
      expect(filter.execute('age=lt=30', testItem)).toBe(true);
      expect(filter.execute('age=lt=25', testItem)).toBe(false);
    });

    it("should support =le= for less than or equal", () => {
      const testItem = { id: 1, age: 25 };
      expect(filter.execute('age=le=25', testItem)).toBe(true);
      expect(filter.execute('age=le=24', testItem)).toBe(false);
    });
  });
});
