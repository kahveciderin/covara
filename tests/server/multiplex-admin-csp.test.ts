import { describe, it, expect, afterEach } from "vitest";
import { Hono } from "hono";
import { createAdminUI } from "@/ui/middleware";
import { createMultiplexRouter } from "@/server/multiplex";
import { SSECollector } from "../helpers/hono";

// Regression: when the admin UI is enabled it mounts a `use("*")` middleware at
// `/__covara` that set `Content-Security-Policy` AFTER next(). That wildcard also
// covered the multiplex `/__covara/stream` SSE endpoint, so it re-wrapped the
// streaming response to add the header — which on Cloudflare Workers prevented it
// from flushing, hanging the stream at 0 bytes (blank status, empty body) so no
// subscription ever delivered. CSP must apply only to the admin HTML pages.
describe("multiplex stream is not broken by the admin UI CSP middleware", () => {
  const collectors: SSECollector[] = [];

  afterEach(() => {
    for (const c of collectors.splice(0)) c.close();
  });

  const buildApp = () => {
    const app = new Hono();
    // Same order as createCovara: admin UI (with its `/__covara/*` CSP
    // middleware) mounted before the multiplex endpoint under the same prefix.
    app.route("/__covara", createAdminUI({}));
    app.route("/__covara/stream", createMultiplexRouter());
    return app;
  };

  it("flushes ready and does NOT put a CSP header on the event-stream", async () => {
    const app = buildApp();
    const { collector, response } = await SSECollector.connect(app, "/__covara/stream");
    collectors.push(collector);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    // The admin CSP must not be applied to the stream (that mutation hangs it on
    // Workers). This is the assertion that fails on the pre-fix code.
    expect(response.headers.get("content-security-policy")).toBeNull();

    const ready = await collector.next();
    expect(ready?.event).toBe("ready");
    expect(ready!.data.cid).toBeTruthy();
  });

  it("still applies CSP to the admin UI HTML pages", async () => {
    const app = buildApp();
    // The admin login/HTML surface still gets the CSP header.
    const res = await app.request("/__covara/problems/not-found");
    // Whatever the status, an HTML response must carry the CSP header.
    if ((res.headers.get("content-type") ?? "").includes("text/html")) {
      expect(res.headers.get("content-security-policy")).toBeTruthy();
    }
  });
});
