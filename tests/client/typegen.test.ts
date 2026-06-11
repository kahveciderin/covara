import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock fetch for testing typegen
const mockSchema = {
  version: "1.0.0",
  timestamp: new Date().toISOString(),
  resources: [
    {
      name: "User",
      path: "/api/users",
      fields: [
        { name: "id", type: { kind: "primitive", primitive: "string" }, nullable: false, primaryKey: true },
        { name: "name", type: { kind: "primitive", primitive: "string" }, nullable: false },
        { name: "email", type: { kind: "primitive", primitive: "string" }, nullable: false },
        { name: "age", type: { kind: "primitive", primitive: "integer" }, nullable: true },
        { name: "createdAt", type: { kind: "primitive", primitive: "datetime" }, nullable: false },
      ],
      capabilities: {
        enableAggregations: true,
        enableBatch: true,
        enableSubscribe: true,
        enableCreate: true,
        enableUpdate: true,
        enableDelete: true,
      },
      procedures: [],
    },
    {
      name: "Todo",
      path: "/api/todos",
      fields: [
        { name: "id", type: { kind: "primitive", primitive: "string" }, nullable: false, primaryKey: true },
        { name: "userId", type: { kind: "primitive", primitive: "string" }, nullable: false },
        { name: "title", type: { kind: "primitive", primitive: "string" }, nullable: false },
        { name: "completed", type: { kind: "primitive", primitive: "boolean" }, nullable: false },
        { name: "position", type: { kind: "primitive", primitive: "integer" }, nullable: false },
      ],
      capabilities: {
        enableAggregations: true,
        enableBatch: true,
        enableSubscribe: true,
        enableCreate: true,
        enableUpdate: true,
        enableDelete: true,
      },
      procedures: ["markComplete"],
    },
  ],
};

describe("Typegen", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url.includes("/env")) {
        return Promise.reject(new Error("Env endpoint not available"));
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(mockSchema),
      });
    }));
  });

  it("should generate TypeScript types from schema", async () => {
    const { generateTypes } = await import("../../src/client/typegen");

    const result = await generateTypes({
      serverUrl: "http://localhost:3000",
      output: "typescript",
      includeClient: true,
    });

    expect(result.code).toContain("export interface User {");
    expect(result.code).toContain("export interface Todo {");
    expect(result.code).toContain("id: string;");
    expect(result.code).toContain("name: string;");
    expect(result.code).toContain("email: string;");
    expect(result.code).toContain("age: number | null;");
  });

  it("should generate Input and Update types", async () => {
    const { generateTypes } = await import("../../src/client/typegen");

    const result = await generateTypes({
      serverUrl: "http://localhost:3000",
      output: "typescript",
      includeClient: true,
    });

    expect(result.code).toContain("export type UserInput =");
    expect(result.code).toContain("export type UserUpdate =");
    expect(result.code).toContain("export type TodoInput =");
    expect(result.code).toContain("export type TodoUpdate =");
  });

  it("should generate field metadata types", async () => {
    const { generateTypes } = await import("../../src/client/typegen");

    const result = await generateTypes({
      serverUrl: "http://localhost:3000",
      output: "typescript",
      includeClient: true,
    });

    expect(result.code).toContain("export type UserFields =");
    expect(result.code).toContain("export type UserNumericFields =");
    expect(result.code).toContain("export type UserComparableFields =");
    expect(result.code).toContain("export type UserStringFields =");
  });

  it("should generate ResourcePaths constants", async () => {
    const { generateTypes } = await import("../../src/client/typegen");

    const result = await generateTypes({
      serverUrl: "http://localhost:3000",
      output: "typescript",
      includeClient: true,
    });

    expect(result.code).toContain("export const ResourcePaths = {");
    expect(result.code).toContain('"/api/users"');
    expect(result.code).toContain('"/api/todos"');
    expect(result.code).not.toContain('"/api/api/users"');
    expect(result.code).not.toContain('"/api/api/todos"');
    expect(result.code).toContain("} as const;");
  });

  it("should import types from covara/client", async () => {
    const { generateTypes } = await import("../../src/client/typegen");

    const result = await generateTypes({
      serverUrl: "http://localhost:3000",
      output: "typescript",
      includeClient: true,
    });

    expect(result.code).toContain('import type { ResourceClient, CovaraClient } from "covara/client";');
  });

  it("should generate TypedResources using LiveQuery with type tracking", async () => {
    const { generateTypes } = await import("../../src/client/typegen");

    const result = await generateTypes({
      serverUrl: "http://localhost:3000",
      output: "typescript",
      includeClient: true,
    });

    expect(result.code).toContain("export interface TypedResources {");
    expect(result.code).toContain("user: LiveQuery<User, {}>;");
    expect(result.code).toContain("todo: LiveQuery<Todo, {}>;");
  });

  it("should generate TypedCovaraClient extending CovaraClient", async () => {
    const { generateTypes } = await import("../../src/client/typegen");

    const result = await generateTypes({
      serverUrl: "http://localhost:3000",
      output: "typescript",
      includeClient: true,
    });

    expect(result.code).toContain("export interface TypedCovaraClient extends CovaraClient {");
    expect(result.code).toContain("resources: TypedResources;");
  });

  it("should generate createTypedClient factory function", async () => {
    const { generateTypes } = await import("../../src/client/typegen");

    const result = await generateTypes({
      serverUrl: "http://localhost:3000",
      output: "typescript",
      includeClient: true,
    });

    expect(result.code).toContain("export function createTypedClient(baseClient: CovaraClient): TypedCovaraClient {");
    expect(result.code).toContain("resources: {");
    expect(result.code).toContain("user: createLiveQuery<User, {}>(baseClient, ResourcePaths.user),");
    expect(result.code).toContain("todo: createLiveQuery<Todo, {}>(baseClient, ResourcePaths.todo),");
  });

  it("should not generate duplicate ResourceQueryBuilder (uses library type)", async () => {
    const { generateTypes } = await import("../../src/client/typegen");

    const result = await generateTypes({
      serverUrl: "http://localhost:3000",
      output: "typescript",
      includeClient: true,
    });

    // ResourceQueryBuilder should be imported from library, not generated
    expect(result.code).not.toContain("export interface ResourceQueryBuilder<");
  });

  it("should not include client types when includeClient is false", async () => {
    const { generateTypes } = await import("../../src/client/typegen");

    const result = await generateTypes({
      serverUrl: "http://localhost:3000",
      output: "typescript",
      includeClient: false,
    });

    expect(result.code).toContain("export interface User {");
    expect(result.code).toContain("export interface Todo {");
    expect(result.code).not.toContain("export const ResourcePaths =");
    expect(result.code).not.toContain("export function createTypedClient");
  });

  it("should include schema metadata in result", async () => {
    const { generateTypes } = await import("../../src/client/typegen");

    const result = await generateTypes({
      serverUrl: "http://localhost:3000",
      output: "typescript",
      includeClient: true,
    });

    expect(result.schema.resources).toHaveLength(2);
    expect(result.schema.resources[0].name).toBe("User");
    expect(result.schema.resources[1].name).toBe("Todo");
    expect(result.generatedAt).toBeDefined();
  });

  it("should generate LiveQuery interface with fluent methods", async () => {
    const { generateTypes } = await import("../../src/client/typegen");

    const result = await generateTypes({
      serverUrl: "http://localhost:3000",
      output: "typescript",
      includeClient: true,
    });

    expect(result.code).toContain("export interface LiveQuery<T extends { id: string }, Relations = {}, Included = {}, Selected extends keyof T = keyof T>");
    expect(result.code).toContain("filter(filter: string): LiveQuery<T, Relations, Included, Selected>;");
    expect(result.code).toContain("where(filter: string): LiveQuery<T, Relations, Included, Selected>;");
    expect(result.code).toContain("orderBy(orderBy: string): LiveQuery<T, Relations, Included, Selected>;");
    expect(result.code).toContain("limit(limit: number): LiveQuery<T, Relations, Included, Selected>;");
    expect(result.code).toContain("select<K extends keyof T>(...fields: K[]): LiveQuery<T, Relations, Included, K | 'id'>;");
    expect(result.code).toContain("include<K extends keyof Relations>(...relations: K[]): LiveQuery<T, Relations, Included & Pick<Relations, K>, Selected>;");
  });

  it("should generate LiveQuery with proxied ResourceClient methods", async () => {
    const { generateTypes } = await import("../../src/client/typegen");

    const result = await generateTypes({
      serverUrl: "http://localhost:3000",
      output: "typescript",
      includeClient: true,
    });

    expect(result.code).toContain('query(): ReturnType<ResourceClient<T>["query"]>;');
    expect(result.code).toContain('list(options?: Parameters<ResourceClient<T>["list"]>[0]): ReturnType<ResourceClient<T>["list"]>;');
    expect(result.code).toContain('search(query: string, options?: Parameters<ResourceClient<T>["search"]>[1]): ReturnType<ResourceClient<T>["search"]>;');
    expect(result.code).toContain('create(data: Parameters<ResourceClient<T>["create"]>[0], options?: Parameters<ResourceClient<T>["create"]>[1]): ReturnType<ResourceClient<T>["create"]>;');
  });

  it("should generate createLiveQuery function", async () => {
    const { generateTypes } = await import("../../src/client/typegen");

    const result = await generateTypes({
      serverUrl: "http://localhost:3000",
      output: "typescript",
      includeClient: true,
    });

    expect(result.code).toContain("function createLiveQuery<T extends { id: string }, Relations = {}, Included = {}, Selected extends keyof T = keyof T>(");
    expect(result.code).toContain("baseClient: CovaraClient,");
    expect(result.code).toContain("const resourceClient = baseClient.resource<T>(path);");
    expect(result.code).toContain("query() { return resourceClient.query(); },");
  });
});

const compileGeneratedCode = async (generated: string, usage: string): Promise<string[]> => {
  const ts = await import("typescript");
  const fs = await import("fs");
  const os = await import("os");
  const path = await import("path");

  const root = path.resolve(__dirname, "../..");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "covara-typegen-"));
  const generatedFile = path.join(dir, "api-types.ts");
  const usageFile = path.join(dir, "usage.ts");
  fs.writeFileSync(generatedFile, generated);
  fs.writeFileSync(usageFile, usage);

  try {
    const program = ts.createProgram([generatedFile, usageFile], {
      strict: true,
      noEmit: true,
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      lib: ["lib.es2020.d.ts", "lib.dom.d.ts"],
      skipLibCheck: true,
      esModuleInterop: true,
      paths: {
        "covara/client": [path.join(root, "src/client/index.ts")],
        "@/*": [path.join(root, "src/*")],
      },
    });
    const diagnostics = ts.getPreEmitDiagnostics(program);
    return diagnostics.map(
      (d) =>
        `${d.file?.fileName ?? "?"}:${d.start ?? 0} ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

describe("Typegen generated code compiles", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url.includes("/env")) {
        return Promise.reject(new Error("Env endpoint not available"));
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(mockSchema),
      });
    }));
  });

  it("generated TypeScript typechecks against the real client library", async () => {
    const { generateTypes } = await import("../../src/client/typegen");

    const result = await generateTypes({
      serverUrl: "http://localhost:3000",
      output: "typescript",
      includeClient: true,
    });

    const usage = `
import { createTypedClient, ResourcePaths } from "./api-types";
import type { User, UserInput, Todo, TodoUpdate } from "./api-types";
import type { CovaraClient } from "covara/client";

declare const base: CovaraClient;
const client = createTypedClient(base);

// Path constants match the server-reported mount paths
const userPath: "/api/users" = ResourcePaths.user;
const todoPath: "/api/todos" = ResourcePaths.todo;
void userPath;
void todoPath;

// Primary keys and nullable fields are optional on Input
const input: UserInput = { name: "a", email: "a@example.com", createdAt: "now" };
void input;

const update: TodoUpdate = { completed: true };
void update;

// Fluent LiveQuery keeps the resource type
const query = client.resources.user.filter("age>18").select("id", "name");
const _selected: "id" | "name" = null as unknown as typeof query._selected extends infer S ? S extends "id" | "name" ? S : never : never;
void _selected;

async function main(): Promise<User | Todo> {
  const list = await client.resources.user.list();
  const todo = await client.resources.todo.get("1");
  return list.items[0] ?? todo;
}
void main;
`;

    const diagnostics = await compileGeneratedCode(result.code, usage);
    expect(diagnostics).toEqual([]);
  }, 60000);
});

// Test schema with relations
const mockSchemaWithRelations = {
  version: "1.0.0",
  timestamp: new Date().toISOString(),
  resources: [
    {
      name: "Category",
      path: "/api/categories",
      fields: [
        { name: "id", type: { kind: "primitive", primitive: "string" }, nullable: false, primaryKey: true },
        { name: "name", type: { kind: "primitive", primitive: "string" }, nullable: false },
      ],
      capabilities: {
        enableAggregations: true,
        enableBatch: true,
        enableSubscribe: true,
        enableCreate: true,
        enableUpdate: true,
        enableDelete: true,
      },
      procedures: [],
    },
    {
      name: "Post",
      path: "/api/posts",
      fields: [
        { name: "id", type: { kind: "primitive", primitive: "string" }, nullable: false, primaryKey: true },
        { name: "title", type: { kind: "primitive", primitive: "string" }, nullable: false },
        { name: "categoryId", type: { kind: "primitive", primitive: "string" }, nullable: true },
      ],
      relations: [
        { name: "category", type: "belongsTo", resource: "Category", foreignKey: "categoryId" },
      ],
      capabilities: {
        enableAggregations: true,
        enableBatch: true,
        enableSubscribe: true,
        enableCreate: true,
        enableUpdate: true,
        enableDelete: true,
      },
      procedures: [],
    },
  ],
};

describe("Typegen with Relations", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url.includes("/env")) {
        return Promise.reject(new Error("Env endpoint not available"));
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(mockSchemaWithRelations),
      });
    }));
  });

  it("should generate Relations interface for resources with relations", async () => {
    const { generateTypes } = await import("../../src/client/typegen");

    const result = await generateTypes({
      serverUrl: "http://localhost:3000",
      output: "typescript",
      includeClient: true,
    });

    expect(result.code).toContain("export interface PostRelations {");
    expect(result.code).toContain("category: Category | null;");
  });

  it("should generate WithRelations and With types", async () => {
    const { generateTypes } = await import("../../src/client/typegen");

    const result = await generateTypes({
      serverUrl: "http://localhost:3000",
      output: "typescript",
      includeClient: true,
    });

    expect(result.code).toContain("export interface PostWithRelations extends Post {");
    expect(result.code).toContain("category?: Category | null;");
    expect(result.code).toContain("export type PostWith<K extends keyof PostRelations> = Post & { [P in K]?: PostRelations[P] };");
  });

  it("should generate TypedResources with relations type for resources that have relations", async () => {
    const { generateTypes } = await import("../../src/client/typegen");

    const result = await generateTypes({
      serverUrl: "http://localhost:3000",
      output: "typescript",
      includeClient: true,
    });

    expect(result.code).toContain("post: LiveQuery<Post, PostRelations>;");
    expect(result.code).toContain("category: LiveQuery<Category, {}>;");
  });

  it("should generate createTypedClient with relations for resources that have relations", async () => {
    const { generateTypes } = await import("../../src/client/typegen");

    const result = await generateTypes({
      serverUrl: "http://localhost:3000",
      output: "typescript",
      includeClient: true,
    });

    expect(result.code).toContain("post: createLiveQuery<Post, PostRelations>(baseClient, ResourcePaths.post),");
    expect(result.code).toContain("category: createLiveQuery<Category, {}>(baseClient, ResourcePaths.category),");
  });

  it("generated code with relations typechecks against the real client library", async () => {
    const { generateTypes } = await import("../../src/client/typegen");

    const result = await generateTypes({
      serverUrl: "http://localhost:3000",
      output: "typescript",
      includeClient: true,
    });

    const usage = `
import { createTypedClient } from "./api-types";
import type { Category, PostWithRelations, PostWith } from "./api-types";
import type { CovaraClient } from "covara/client";

declare const base: CovaraClient;
const client = createTypedClient(base);

// include() narrows to known relation names and tracks the included type
const withCategory = client.resources.post.include("category");
type Included = typeof withCategory._included;
const included: Included = { category: null };
void included;

const post: PostWithRelations = { id: "1", title: "t", categoryId: null, category: null };
const picked: PostWith<"category"> = { id: "1", title: "t", categoryId: null };
void post;
void picked;

const category: Category | null = post.category ?? null;
void category;
`;

    const diagnostics = await compileGeneratedCode(result.code, usage);
    expect(diagnostics).toEqual([]);
  }, 60000);
});

describe("Typegen identifier and nullability handling", () => {
  const oddSchema = {
    version: "1.0.0",
    timestamp: new Date().toISOString(),
    resources: [
      {
        name: "todo-items",
        path: "/api/todo-items",
        fields: [
          { name: "id", type: { kind: "primitive", primitive: "string" }, nullable: false, primaryKey: true },
          { name: "display-name", type: { kind: "primitive", primitive: "string" }, nullable: false },
          { name: "note", type: { kind: "primitive", primitive: "string" }, nullable: true },
          { name: "count", type: { kind: "primitive", primitive: "integer" }, nullable: false, defaultValue: 0 },
          { name: "serial", type: { kind: "primitive", primitive: "integer" }, nullable: false, autoIncrement: true },
        ],
        capabilities: {},
        procedures: [],
      },
    ],
  };

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url.includes("/env")) {
        return Promise.reject(new Error("Env endpoint not available"));
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(oddSchema),
      });
    }));
  });

  it("sanitizes resource names into valid identifiers and quotes odd field names", async () => {
    const { generateTypes } = await import("../../src/client/typegen");

    const result = await generateTypes({
      serverUrl: "http://localhost:3000",
      output: "typescript",
      includeClient: true,
    });

    expect(result.code).toContain("export interface todoItems {");
    expect(result.code).toContain('"display-name": string;');
    expect(result.code).toContain('todoItems: "/api/todo-items" as const,');
    expect(result.code).toContain("todoItems: LiveQuery<todoItems, {}>;");
  });

  it("marks nullable, defaulted, and primary-key input fields optional and drops auto-increment fields", async () => {
    const { generateTypes } = await import("../../src/client/typegen");

    const result = await generateTypes({
      serverUrl: "http://localhost:3000",
      output: "typescript",
      includeClient: true,
    });

    const inputSection = result.code.slice(
      result.code.indexOf("export type todoItemsInput"),
      result.code.indexOf("export type todoItemsUpdate")
    );
    expect(inputSection).toContain("id?: string;");
    expect(inputSection).toContain('"display-name": string;');
    expect(inputSection).toContain("note?: string | null;");
    expect(inputSection).toContain("count?: number;");
    expect(inputSection).not.toContain("serial");
  });

  it("generated code with odd identifiers typechecks", async () => {
    const { generateTypes } = await import("../../src/client/typegen");

    const result = await generateTypes({
      serverUrl: "http://localhost:3000",
      output: "typescript",
      includeClient: true,
    });

    const usage = `
import { createTypedClient } from "./api-types";
import type { todoItemsInput } from "./api-types";
import type { CovaraClient } from "covara/client";

declare const base: CovaraClient;
const client = createTypedClient(base);
void client.resources.todoItems;

const input: todoItemsInput = { "display-name": "hello" };
void input;
`;

    const diagnostics = await compileGeneratedCode(result.code, usage);
    expect(diagnostics).toEqual([]);
  }, 60000);
});
