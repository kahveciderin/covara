import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { getClientIP, configureClientIp } from "@/server/request";
import { createCovara } from "@/server/app";
import { setLogger, getLogger, createLogger, type LogRecord } from "@/server/logger";

const app = new Hono();
app.get("/ip", (c) => c.text(getClientIP(c)));

const ip = async (peer: string | undefined, headers: Record<string, string> = {}) => {
  const env = peer === undefined ? {} : { incoming: { socket: { remoteAddress: peer } } };
  return (await app.request("/ip", { headers }, env)).text();
};

describe("getClientIP", () => {
  let logs: LogRecord[];
  const previous = getLogger();

  beforeEach(() => {
    configureClientIp({});
    logs = [];
    setLogger(createLogger({ level: "debug", sink: (r) => logs.push(r) }));
  });
  afterEach(() => {
    configureClientIp({});
    setLogger(previous);
    vi.unstubAllGlobals();
  });

  describe("by default on Node", () => {
    it("ignores X-Forwarded-For, X-Real-IP and CF-Connecting-IP, which the client controls", async () => {
      const spoof = { "x-forwarded-for": "6.6.6.6", "x-real-ip": "7.7.7.7", "cf-connecting-ip": "8.8.8.8" };
      expect(await ip("203.0.113.9", spoof)).toBe("203.0.113.9");
    });

    it("a client can't change its key by varying the header", async () => {
      const keys = new Set<string>();
      for (let i = 0; i < 5; i++) keys.add(await ip("203.0.113.9", { "x-forwarded-for": `10.0.0.${i}` }));
      expect([...keys]).toEqual(["203.0.113.9"]);
    });

    it("warns once that forwarding headers were ignored", async () => {
      await ip("127.0.0.1", { "x-forwarded-for": "1.2.3.4" });
      await ip("127.0.0.1", { "x-forwarded-for": "1.2.3.5" });
      const warns = logs.filter((l) => l.level === "warn");
      expect(warns).toHaveLength(1);
      expect(warns[0].msg).toMatch(/trustProxy/);
    });

    it("no warning without forwarding headers", async () => {
      await ip("127.0.0.1");
      expect(logs.filter((l) => l.level === "warn")).toHaveLength(0);
    });

    it("unknown without a socket", async () => {
      expect(await ip(undefined)).toBe("unknown");
    });
  });

  describe("on Cloudflare Workers", () => {
    beforeEach(() => vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" }));

    it("uses CF-Connecting-IP, which the edge sets, and ignores X-Forwarded-For", async () => {
      expect(await ip(undefined, { "cf-connecting-ip": "198.51.100.4", "x-forwarded-for": "6.6.6.6" })).toBe(
        "198.51.100.4"
      );
    });
  });

  describe("with trusted proxies", () => {
    it("reads X-Forwarded-For from the right while the hops are trusted", async () => {
      configureClientIp({ trustProxy: ["loopback"] });
      expect(await ip("127.0.0.1", { "x-forwarded-for": "6.6.6.6, 198.51.100.7" })).toBe("198.51.100.7");
      expect(await ip("127.0.0.1", { "x-forwarded-for": "198.51.100.7, 127.0.0.1" })).toBe("198.51.100.7");
    });

    it("an untrusted peer's headers are ignored", async () => {
      configureClientIp({ trustProxy: ["loopback"] });
      expect(await ip("203.0.113.9", { "x-forwarded-for": "6.6.6.6" })).toBe("203.0.113.9");
    });

    it("an IPv4-mapped IPv6 peer matches an IPv4 range", async () => {
      configureClientIp({ trustProxy: ["10.0.0.0/8"] });
      expect(await ip("::ffff:10.1.2.3", { "x-forwarded-for": "198.51.100.7" })).toBe("198.51.100.7");
    });

    it("CIDR lists, several hops", async () => {
      configureClientIp({ trustProxy: ["10.0.0.0/8", "192.168.1.1"] });
      expect(await ip("10.1.2.3", { "x-forwarded-for": "6.6.6.6, 9.9.9.9, 192.168.1.1, 10.0.0.5" })).toBe("9.9.9.9");
    });

    it("every hop trusted gives the left-most entry", async () => {
      configureClientIp({ trustProxy: ["uniquelocal"] });
      expect(await ip("10.0.0.1", { "x-forwarded-for": "10.0.0.9, 192.168.0.2" })).toBe("10.0.0.9");
    });

    it("IPv6 ranges", async () => {
      configureClientIp({ trustProxy: ["fd00::/8"] });
      expect(await ip("fd12::1", { "x-forwarded-for": "2001:db8::5" })).toBe("2001:db8::5");
      expect(await ip("fe12::1", { "x-forwarded-for": "2001:db8::5" })).toBe("fe12::1");
    });

    it("X-Real-IP from a trusted peer without X-Forwarded-For", async () => {
      configureClientIp({ trustProxy: ["loopback"] });
      expect(await ip("::1", { "x-real-ip": "198.51.100.8" })).toBe("198.51.100.8");
    });

    it("ignores a port on an entry", async () => {
      configureClientIp({ trustProxy: ["loopback"] });
      expect(await ip("127.0.0.1", { "x-forwarded-for": "198.51.100.7:5123" })).toBe("198.51.100.7");
      expect(await ip("127.0.0.1", { "x-forwarded-for": "[2001:db8::5]:443" })).toBe("2001:db8::5");
    });

    it("rejects a malformed entry in the list", () => {
      expect(() => configureClientIp({ trustProxy: ["10.0.0.0/33"] })).toThrow(/trustProxy/);
      expect(() => configureClientIp({ trustProxy: ["nonsense"] })).toThrow(/trustProxy/);
    });
  });

  describe("with a hop count", () => {
    it("takes the entry that many hops from the right", async () => {
      configureClientIp({ trustProxy: 1 });
      expect(await ip("203.0.113.1", { "x-forwarded-for": "6.6.6.6, 198.51.100.7" })).toBe("198.51.100.7");
      configureClientIp({ trustProxy: 2 });
      expect(await ip("203.0.113.1", { "x-forwarded-for": "6.6.6.6, 198.51.100.7" })).toBe("6.6.6.6");
      configureClientIp({ trustProxy: 5 });
      expect(await ip("203.0.113.1", { "x-forwarded-for": "6.6.6.6, 198.51.100.7" })).toBe("6.6.6.6");
    });

    it("0 trusts nothing", async () => {
      configureClientIp({ trustProxy: 0 });
      expect(await ip("203.0.113.1", { "x-forwarded-for": "6.6.6.6" })).toBe("203.0.113.1");
    });
  });

  it('"cloudflare" trusts CF-Connecting-IP on Node', async () => {
    configureClientIp({ trustProxy: "cloudflare" });
    expect(await ip("203.0.113.1", { "cf-connecting-ip": "198.51.100.4", "x-forwarded-for": "6.6.6.6" })).toBe(
      "198.51.100.4"
    );
    expect(await ip("203.0.113.1")).toBe("203.0.113.1");
  });

  it("a clientIp hook overrides everything, falling back when it returns nothing", async () => {
    configureClientIp({ clientIp: (c) => c.req.header("x-app-ip") });
    expect(await ip("203.0.113.1", { "x-app-ip": "198.51.100.9" })).toBe("198.51.100.9");
    expect(await ip("203.0.113.1")).toBe("203.0.113.1");
  });

  it("createCovara applies trustProxy and clientIp", async () => {
    const covara = createCovara({ trustProxy: ["loopback"] });
    covara.get("/ip", (c) => c.text(getClientIP(c)));
    const res = await covara.request("/ip", { headers: { "x-forwarded-for": "198.51.100.7" } }, {
      incoming: { socket: { remoteAddress: "127.0.0.1" } },
    });
    expect(await res.text()).toBe("198.51.100.7");
  });
});
