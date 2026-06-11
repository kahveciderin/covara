import { describe, it, expect, afterEach } from "vitest";
import { Hono } from "hono";
import { createSecurityHeaders } from "@/middleware/securityHeaders";

const setNodeEnv = (value: string | undefined): void => {
  if (value === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = value;
  }
};

describe("createSecurityHeaders", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    setNodeEnv(originalNodeEnv);
  });

  const makeApp = (mw = createSecurityHeaders()): Hono => {
    const app = new Hono();
    app.use("*", mw);
    app.get("/ok", (c) => c.json({ ok: true }));
    app.get("/boom", () => {
      throw new Error("boom");
    });
    return app;
  };

  describe("default headers", () => {
    it("sets all default security headers", async () => {
      setNodeEnv("test");
      const app = makeApp();
      const res = await app.request("http://localhost/ok");

      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(res.headers.get("X-Frame-Options")).toBe("DENY");
      expect(res.headers.get("Referrer-Policy")).toBe(
        "strict-origin-when-cross-origin"
      );
      expect(res.headers.get("X-DNS-Prefetch-Control")).toBe("off");
      expect(res.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
      expect(res.headers.get("Content-Security-Policy")).toBe(
        "default-src 'none'; frame-ancestors 'none'"
      );
    });
  });

  describe("HSTS", () => {
    it("is absent on plain http in non-production", async () => {
      setNodeEnv("development");
      const app = makeApp();
      const res = await app.request("http://localhost/ok");

      expect(res.headers.get("Strict-Transport-Security")).toBeNull();
    });

    it("is present on https requests", async () => {
      setNodeEnv("development");
      const app = makeApp();
      const res = await app.request("https://localhost/ok");

      expect(res.headers.get("Strict-Transport-Security")).toBe(
        "max-age=15552000; includeSubDomains"
      );
    });

    it("is present on plain http when in production", async () => {
      setNodeEnv("production");
      const app = makeApp();
      const res = await app.request("http://localhost/ok");

      expect(res.headers.get("Strict-Transport-Security")).toBe(
        "max-age=15552000; includeSubDomains"
      );
    });

    it("honors custom max-age, includeSubDomains and preload", async () => {
      setNodeEnv("development");
      const app = makeApp(
        createSecurityHeaders({
          hsts: { maxAge: 100, includeSubDomains: false, preload: true },
        })
      );
      const res = await app.request("https://localhost/ok");

      expect(res.headers.get("Strict-Transport-Security")).toBe(
        "max-age=100; preload"
      );
    });

    it("can be disabled", async () => {
      setNodeEnv("production");
      const app = makeApp(createSecurityHeaders({ hsts: false }));
      const res = await app.request("https://localhost/ok");

      expect(res.headers.get("Strict-Transport-Security")).toBeNull();
    });
  });

  describe("Content-Security-Policy", () => {
    it("can be overridden", async () => {
      setNodeEnv("test");
      const app = makeApp(
        createSecurityHeaders({ contentSecurityPolicy: "default-src 'self'" })
      );
      const res = await app.request("http://localhost/ok");

      expect(res.headers.get("Content-Security-Policy")).toBe(
        "default-src 'self'"
      );
    });

    it("can be disabled", async () => {
      setNodeEnv("test");
      const app = makeApp(
        createSecurityHeaders({ contentSecurityPolicy: false })
      );
      const res = await app.request("http://localhost/ok");

      expect(res.headers.get("Content-Security-Policy")).toBeNull();
    });

    it("does not clobber a CSP set by a downstream handler", async () => {
      setNodeEnv("test");
      const app = new Hono();
      app.use("*", createSecurityHeaders());
      app.get("/custom", (c) => {
        c.header("Content-Security-Policy", "default-src 'self'");
        return c.json({ ok: true });
      });
      const res = await app.request("http://localhost/custom");

      expect(res.headers.get("Content-Security-Policy")).toBe(
        "default-src 'self'"
      );
    });
  });

  describe("frameOptions", () => {
    it("supports SAMEORIGIN", async () => {
      setNodeEnv("test");
      const app = makeApp(createSecurityHeaders({ frameOptions: "SAMEORIGIN" }));
      const res = await app.request("http://localhost/ok");

      expect(res.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
    });

    it("supports DENY", async () => {
      setNodeEnv("test");
      const app = makeApp(createSecurityHeaders({ frameOptions: "DENY" }));
      const res = await app.request("http://localhost/ok");

      expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    });

    it("can be disabled", async () => {
      setNodeEnv("test");
      const app = makeApp(createSecurityHeaders({ frameOptions: false }));
      const res = await app.request("http://localhost/ok");

      expect(res.headers.get("X-Frame-Options")).toBeNull();
    });
  });

  describe("error and 404 responses", () => {
    it("sets headers on 404 responses", async () => {
      setNodeEnv("test");
      const app = makeApp();
      const res = await app.request("http://localhost/missing");

      expect(res.status).toBe(404);
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(res.headers.get("X-Frame-Options")).toBe("DENY");
      expect(res.headers.get("Content-Security-Policy")).toBe(
        "default-src 'none'; frame-ancestors 'none'"
      );
    });

    it("sets headers on error responses", async () => {
      setNodeEnv("test");
      const app = makeApp();
      const res = await app.request("http://localhost/boom");

      expect(res.status).toBe(500);
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    });

    it("can disable contentTypeOptions", async () => {
      setNodeEnv("test");
      const app = makeApp(createSecurityHeaders({ contentTypeOptions: false }));
      const res = await app.request("http://localhost/ok");

      expect(res.headers.get("X-Content-Type-Options")).toBeNull();
    });
  });
});
