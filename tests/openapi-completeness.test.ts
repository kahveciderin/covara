import { describe, it, expect } from "vitest";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { generateOpenAPISpec, RegisteredResource } from "@/openapi/generator";

const createMockDrizzleSchema = () => {
  return {
    id: { name: "id", dataType: "uuid", notNull: true },
    title: { name: "title", dataType: "text", notNull: true },
    status: {
      name: "status",
      dataType: "text",
      columnType: "PgText",
      notNull: true,
      enumValues: ["draft", "published", "archived"] as const,
    },
    version: { name: "version", dataType: "number", notNull: true },
    updatedAt: { name: "updatedAt", dataType: "timestamp", notNull: false },
    _: { name: "posts" },
  } as any;
};

const baseResource: RegisteredResource = {
  name: "Post",
  path: "/posts",
  schema: createMockDrizzleSchema(),
};

describe("OpenAPI Completeness", () => {
  describe("filter parameter documentation", () => {
    it("documents RSQL operators and combinators with an example", () => {
      const spec = generateOpenAPISpec([baseResource]);
      const filterParam = spec.paths["/posts"]!.get!.parameters!.find(
        (p) => p.name === "filter"
      )!;

      expect(filterParam).toBeDefined();
      const desc = filterParam.description ?? "";
      expect(desc).toContain("==");
      expect(desc).toContain("=in=");
      expect(desc).toContain("=between=");
      expect(desc).toContain("=contains=");
      expect(desc.toLowerCase()).toContain("and");
      expect(desc.toLowerCase()).toContain("or");
      expect(desc).toContain("grouping");
      expect(desc).toContain("Example");
      expect(filterParam.example).toBeDefined();
    });

    it("includes registered custom operators in the description", () => {
      const resource: RegisteredResource = {
        ...baseResource,
        customOperators: {
          "=jsoncontains=": {
            convert: (lhs, rhs) => sql`JSON_CONTAINS(${lhs}, ${rhs})`,
            execute: () => true,
          },
        },
      };

      const spec = generateOpenAPISpec([resource]);
      const filterParam = spec.paths["/posts"]!.get!.parameters!.find(
        (p) => p.name === "filter"
      )!;

      expect(filterParam.description).toContain("=jsoncontains=");
      expect(filterParam.description).toContain("Custom operators");
    });
  });

  describe("procedures", () => {
    it("emits an /rpc/{name} path with request and response schemas from zod", () => {
      const resource: RegisteredResource = {
        ...baseResource,
        procedures: {
          publish: {
            input: z.object({ id: z.string() }),
            output: z.object({ success: z.boolean() }),
            handler: async () => ({ success: true }),
          },
        },
      };

      const spec = generateOpenAPISpec([resource]);
      const rpcPath = spec.paths["/posts/rpc/publish"];

      expect(rpcPath).toBeDefined();
      expect(rpcPath!.post).toBeDefined();
      expect(rpcPath!.post!.requestBody!.required).toBe(true);

      const reqSchema =
        rpcPath!.post!.requestBody!.content["application/json"]!.schema;
      expect(reqSchema.type).toBe("object");
      expect(reqSchema.properties).toHaveProperty("id");

      const resSchema =
        rpcPath!.post!.responses["200"]!.content!["application/json"]!.schema;
      expect(resSchema.type).toBe("object");
      expect(resSchema.properties).toHaveProperty("success");
    });

    it("falls back to a generic object schema when zod is absent", () => {
      const resource: RegisteredResource = {
        ...baseResource,
        procedures: {
          ping: { handler: async () => ({}) },
        },
      };

      const spec = generateOpenAPISpec([resource]);
      const rpcPath = spec.paths["/posts/rpc/ping"]!;

      expect(rpcPath.post!.requestBody!.required).toBe(false);
      expect(
        rpcPath.post!.requestBody!.content["application/json"]!.schema.type
      ).toBe("object");
    });
  });

  describe("enum columns", () => {
    it("emits enum values in the property schema", () => {
      const spec = generateOpenAPISpec([baseResource]);
      const postSchema = spec.components!.schemas!.Post!;
      const statusProp = postSchema.properties!.status!;

      expect(statusProp.enum).toEqual(["draft", "published", "archived"]);
      expect(statusProp.type).toBe("string");
    });
  });

  describe("subscribe endpoint", () => {
    it("documents an SSE endpoint with query params", () => {
      const spec = generateOpenAPISpec([baseResource]);
      const subscribe = spec.paths["/posts/subscribe"]!.get!;

      expect(subscribe.responses["200"]!.content).toHaveProperty(
        "text/event-stream"
      );

      const paramNames = subscribe.parameters!.map((p) => p.name);
      expect(paramNames).toContain("filter");
      expect(paramNames).toContain("include");
      expect(paramNames).toContain("resumeFrom");
      expect(paramNames).toContain("skipExisting");

      const eventSchema =
        subscribe.responses["200"]!.content!["text/event-stream"]!.schema;
      expect(eventSchema.properties!.type!.enum).toContain("added");
      expect(eventSchema.properties!.type!.enum).toContain("invalidate");
    });
  });

  describe("etag / conditional headers", () => {
    it("documents If-Match and 412 when etag is configured", () => {
      const resource: RegisteredResource = {
        ...baseResource,
        capabilities: {
          enableCreate: true,
          enableUpdate: true,
          enableDelete: true,
        },
        etag: { versionField: "version" },
      };

      const spec = generateOpenAPISpec([resource]);
      const patch = spec.paths["/posts/{id}"]!.patch!;

      const headerParams = patch.parameters!.map((p) => p.name);
      expect(headerParams).toContain("If-Match");
      expect(patch.responses["412"]).toBeDefined();
      expect(patch.responses["200"]!.headers).toHaveProperty("ETag");

      const get = spec.paths["/posts/{id}"]!.get!;
      const getParamNames = get.parameters!.map((p) => p.name);
      expect(getParamNames).toContain("If-None-Match");
      expect(get.responses["304"]).toBeDefined();
      expect(get.responses["200"]!.headers).toHaveProperty("ETag");

      const del = spec.paths["/posts/{id}"]!.delete!;
      expect(del.responses["412"]).toBeDefined();
    });

    it("omits conditional headers when etag is not configured", () => {
      const spec = generateOpenAPISpec([baseResource]);
      const patch = spec.paths["/posts/{id}"]!.patch!;

      const headerParams = (patch.parameters ?? []).map((p) => p.name);
      expect(headerParams).not.toContain("If-Match");
      expect(patch.responses["412"]).toBeUndefined();

      const get = spec.paths["/posts/{id}"]!.get!;
      expect(get.responses["304"]).toBeUndefined();
      expect(get.responses["200"]!.headers).toBeUndefined();
    });
  });
});
