import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCovara } from "@/server/app";
import { createLocalStorage } from "@/storage/local";
import { clearGlobalStorage, setGlobalStorage, type StorageAdapter } from "@/storage/types";
import { clearSchemaRegistry } from "@/ui/schema-registry";

describe("Auto-mounted local storage serving", () => {
  let dir: string;
  let storage: StorageAdapter;

  beforeEach(async () => {
    clearSchemaRegistry();
    dir = await mkdtemp(join(tmpdir(), "covara-serve-"));
    storage = createLocalStorage({ basePath: dir, baseUrl: "/uploads" });
    setGlobalStorage(storage);
  });

  afterEach(async () => {
    clearGlobalStorage();
    await rm(dir, { recursive: true, force: true });
  });

  const app = () => createCovara({ adminUI: false, openapi: false, health: false });

  it("serves passive files with nosniff", async () => {
    await storage.upload("u1/cat.txt", Buffer.from("meow"));
    const res = await app().request("/uploads/u1/cat.txt");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("meow");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("serves active types (html/svg) as downloads, never inline", async () => {
    await storage.upload("page.html", Buffer.from("<script>alert(1)</script>"));
    await storage.upload("img.svg", Buffer.from("<svg onload=alert(1)></svg>"));
    for (const path of ["/uploads/page.html", "/uploads/img.svg"]) {
      const res = await app().request(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/octet-stream");
      expect(res.headers.get("content-disposition")).toMatch(/^attachment/);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });

  it("does not expose metadata sidecars or in-progress upload parts", async () => {
    await storage.upload("doc.txt", Buffer.from("x"));
    await storage.upload(".covara-uploads/session/1", Buffer.from("part"));
    expect((await app().request("/uploads/doc.txt.meta.json")).status).toBe(404);
    expect((await app().request("/uploads/.covara-uploads/session/1")).status).toBe(404);
  });
});
