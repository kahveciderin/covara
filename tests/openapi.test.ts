import { describe, it, expect } from "vitest";
import {
  generateOpenAPISpec,
  serveOpenAPI,
  RegisteredResource,
  OpenAPIConfig,
} from "@/openapi/generator";
import {
  buildCovaraSchema,
  generateTypeScriptTypes,
  extractSchemaInfo,
} from "@/openapi/schema";

// Mock Drizzle schema for testing
const createMockDrizzleSchema = () => {
  return {
    id: { name: "id", dataType: "uuid", notNull: true },
    name: { name: "name", dataType: "text", notNull: true },
    email: { name: "email", dataType: "text", notNull: true },
    age: { name: "age", dataType: "integer", notNull: false },
    createdAt: { name: "createdAt", dataType: "timestamp", notNull: true },
    metadata: { name: "metadata", dataType: "json", notNull: false },
    _: { name: "users" },
  } as any;
};

describe("OpenAPI Generator", () => {
  const mockResource: RegisteredResource = {
    name: "User",
    path: "/users",
    schema: createMockDrizzleSchema(),
    capabilities: {
      enableCreate: true,
      enableUpdate: true,
      enableDelete: true,
      enableBatch: true,
      enableAggregations: true,
      enableSubscribe: true,
    },
    fields: {
      readable: ["id", "name", "email", "age", "createdAt"],
      writable: ["name", "email", "age"],
    },
  };

  describe("generateOpenAPISpec", () => {
    it("should generate valid OpenAPI 3.0 spec", () => {
      const spec = generateOpenAPISpec([mockResource]);

      expect(spec.openapi).toBe("3.0.3");
      expect(spec.info).toBeDefined();
      expect(spec.paths).toBeDefined();
      expect(spec.components).toBeDefined();
    });

    it("should include resource paths", () => {
      const spec = generateOpenAPISpec([mockResource]);

      expect(spec.paths["/users"]).toBeDefined();
      expect(spec.paths["/users/{id}"]).toBeDefined();
      expect(spec.paths["/users/count"]).toBeDefined();
      expect(spec.paths["/users/aggregate"]).toBeDefined();
      expect(spec.paths["/users/subscribe"]).toBeDefined();
    });

    it("should include CRUD operations", () => {
      const spec = generateOpenAPISpec([mockResource]);

      expect(spec.paths["/users"]!.get).toBeDefined(); // List
      expect(spec.paths["/users"]!.post).toBeDefined(); // Create
      expect(spec.paths["/users/{id}"]!.get).toBeDefined(); // Get
      expect(spec.paths["/users/{id}"]!.patch).toBeDefined(); // Update
      expect(spec.paths["/users/{id}"]!.put).toBeDefined(); // Replace
      expect(spec.paths["/users/{id}"]!.delete).toBeDefined(); // Delete
    });

    it("should generate schema from Drizzle model", () => {
      const spec = generateOpenAPISpec([mockResource]);

      expect(spec.components?.schemas?.User).toBeDefined();
      expect(spec.components?.schemas?.UserInput).toBeDefined();
    });

    it("should include query parameters for list endpoint", () => {
      const spec = generateOpenAPISpec([mockResource]);

      const listOp = spec.paths["/users"]!.get!;
      const paramNames = listOp.parameters?.map((p) => p.name);

      expect(paramNames).toContain("filter");
      expect(paramNames).toContain("cursor");
      expect(paramNames).toContain("limit");
      expect(paramNames).toContain("orderBy");
      expect(paramNames).toContain("select");
    });

    it("should include ProblemDetail schema for errors", () => {
      const spec = generateOpenAPISpec([mockResource]);

      expect(spec.components?.schemas?.ProblemDetail).toBeDefined();
    });

    it("should use custom config", () => {
      const config: OpenAPIConfig = {
        title: "My API",
        version: "2.0.0",
        description: "Test API",
        servers: [{ url: "https://api.example.com", description: "Production" }],
      };

      const spec = generateOpenAPISpec([mockResource], config);

      expect(spec.info.title).toBe("My API");
      expect(spec.info.version).toBe("2.0.0");
      expect(spec.info.description).toBe("Test API");
      expect(spec.servers).toHaveLength(1);
    });

    it("should include tags for resources", () => {
      const spec = generateOpenAPISpec([mockResource]);

      expect(spec.tags).toContainEqual({ name: "User" });
    });

    it("should exclude disabled capabilities", () => {
      const resource: RegisteredResource = {
        ...mockResource,
        capabilities: {
          enableCreate: false,
          enableDelete: false,
          enableAggregations: false,
          enableSubscribe: false,
        },
      };

      const spec = generateOpenAPISpec([resource]);

      expect(spec.paths["/users"]!.post).toBeUndefined();
      expect(spec.paths["/users/{id}"]!.delete).toBeUndefined();
      expect(spec.paths["/users/aggregate"]).toBeUndefined();
      expect(spec.paths["/users/subscribe"]).toBeUndefined();
    });

    it("should handle multiple resources", () => {
      const resources: RegisteredResource[] = [
        mockResource,
        {
          name: "Post",
          path: "/posts",
          schema: createMockDrizzleSchema(),
        },
      ];

      const spec = generateOpenAPISpec(resources);

      expect(spec.paths["/users"]).toBeDefined();
      expect(spec.paths["/posts"]).toBeDefined();
      expect(spec.components?.schemas?.User).toBeDefined();
      expect(spec.components?.schemas?.Post).toBeDefined();
    });

    it("should include procedure endpoints", () => {
      const resource: RegisteredResource = {
        ...mockResource,
        procedures: {
          activate: { handler: async () => ({}) },
          deactivate: { handler: async () => ({}) },
        },
      };

      const spec = generateOpenAPISpec([resource]);

      expect(spec.paths["/users/rpc/activate"]).toBeDefined();
      expect(spec.paths["/users/rpc/deactivate"]).toBeDefined();
    });
  });

  describe("serveOpenAPI", () => {
    it("should cache generated spec", () => {
      const service = serveOpenAPI([mockResource]);

      const spec1 = service.getSpec();
      const spec2 = service.getSpec();

      expect(spec1).toBe(spec2); // Same reference
    });

    it("should allow cache invalidation", () => {
      const service = serveOpenAPI([mockResource]);

      const spec1 = service.getSpec();
      service.invalidateCache();
      const spec2 = service.getSpec();

      expect(spec1).not.toBe(spec2); // Different references
      expect(spec1).toEqual(spec2); // Same content
    });
  });
});

describe("Schema Generator", () => {
  const mockSchema = createMockDrizzleSchema();

  describe("extractSchemaInfo", () => {
    it("should extract field info from Drizzle schema", () => {
      const fields = extractSchemaInfo(mockSchema);

      const idField = fields.find((f) => f.name === "id");
      expect(idField).toBeDefined();
      expect(idField?.type).toEqual({ kind: "primitive", primitive: "uuid" });
      expect(idField?.nullable).toBe(false);

      const ageField = fields.find((f) => f.name === "age");
      expect(ageField).toBeDefined();
      expect(ageField?.type).toEqual({ kind: "primitive", primitive: "integer" });
      expect(ageField?.nullable).toBe(true);
    });

    it("should map Drizzle types to TypeScript types", () => {
      const fields = extractSchemaInfo(mockSchema);

      const createdAtField = fields.find((f) => f.name === "createdAt");
      expect(createdAtField?.type).toEqual({ kind: "primitive", primitive: "datetime" });

      const metadataField = fields.find((f) => f.name === "metadata");
      expect(metadataField?.type).toEqual({ kind: "primitive", primitive: "json" });
    });
  });

  describe("buildCovaraSchema", () => {
    it("should build complete schema object", () => {
      const resources: RegisteredResource[] = [
        {
          name: "User",
          path: "/users",
          schema: mockSchema,
          capabilities: {
            enableCreate: true,
            enableSubscribe: true,
          },
          procedures: {
            activate: { handler: async () => ({}) },
          },
        },
      ];

      const schema = buildCovaraSchema(resources);

      expect(schema.version).toBeDefined();
      expect(schema.resources).toHaveLength(1);
      expect(schema.resources[0].name).toBe("User");
      expect(schema.resources[0].path).toBe("/users");
      expect(schema.resources[0].procedures).toContain("activate");
      expect(schema.timestamp).toBeDefined();
    });
  });

  describe("generateTypeScriptTypes", () => {
    it("should generate valid TypeScript interfaces", () => {
      const resources: RegisteredResource[] = [
        {
          name: "User",
          path: "/users",
          schema: mockSchema,
        },
      ];

      const schema = buildCovaraSchema(resources);
      const types = generateTypeScriptTypes(schema);

      expect(types).toContain("export interface User");
      expect(types).toContain("id: string");
      expect(types).toContain("name: string");
      expect(types).toContain("age: number | null");
      expect(types).toContain("export type UserInput");
      expect(types).toContain("export type UserUpdate");
    });

    it("should generate client types", () => {
      const resources: RegisteredResource[] = [
        {
          name: "User",
          path: "/users",
          schema: mockSchema,
        },
      ];

      const schema = buildCovaraSchema(resources);
      const types = generateTypeScriptTypes(schema);

      expect(types).toContain("export interface CovaraClient");
      expect(types).toContain("export interface ResourceClient");
      expect(types).toContain("export interface ListOptions");
      expect(types).toContain("export interface PaginatedResponse");
      expect(types).toContain("export interface Subscription");
    });

    it("should include generation metadata", () => {
      const resources: RegisteredResource[] = [
        {
          name: "User",
          path: "/users",
          schema: mockSchema,
        },
      ];

      const schema = buildCovaraSchema(resources);
      const types = generateTypeScriptTypes(schema);

      expect(types).toContain("// Generated by Covara");
      expect(types).toContain("// Generated at");
    });
  });
});
