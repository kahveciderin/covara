import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  createLogger,
  getLogger,
  setLogger,
  defaultSink,
  resolveDefaultLevel,
  type LogRecord,
} from "@/server/logger";

describe("structured logger", () => {
  const originalLogger = getLogger();

  afterEach(() => {
    setLogger(originalLogger);
    delete process.env.COVARA_LOG_LEVEL;
    delete process.env.COVARA_DEBUG;
    vi.restoreAllMocks();
  });

  describe("level filtering", () => {
    it("suppresses debug records when level is info", () => {
      const records: LogRecord[] = [];
      const logger = createLogger({ level: "info", sink: (r) => records.push(r) });

      logger.debug("hidden");
      logger.info("shown");

      expect(records).toHaveLength(1);
      expect(records[0].msg).toBe("shown");
      expect(records[0].level).toBe("info");
    });

    it("emits debug records when level is debug", () => {
      const records: LogRecord[] = [];
      const logger = createLogger({ level: "debug", sink: (r) => records.push(r) });

      logger.debug("d");
      logger.info("i");
      logger.warn("w");
      logger.error("e");

      expect(records.map((r) => r.level)).toEqual(["debug", "info", "warn", "error"]);
    });

    it("only emits error at error level", () => {
      const records: LogRecord[] = [];
      const logger = createLogger({ level: "error", sink: (r) => records.push(r) });

      logger.debug("d");
      logger.info("i");
      logger.warn("w");
      logger.error("e");

      expect(records).toHaveLength(1);
      expect(records[0].level).toBe("error");
    });
  });

  describe("JSON shape", () => {
    it("default sink emits one-line JSON with level, time, msg", () => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});

      defaultSink({ level: "info", time: "2026-01-01T00:00:00.000Z", msg: "hello", a: 1 });

      expect(spy).toHaveBeenCalledTimes(1);
      const line = spy.mock.calls[0][0] as string;
      expect(line).not.toContain("\n");
      const parsed = JSON.parse(line);
      expect(parsed).toMatchObject({
        level: "info",
        time: "2026-01-01T00:00:00.000Z",
        msg: "hello",
        a: 1,
      });
    });

    it("routes each level to the matching console method", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const logger = createLogger({ level: "debug" });
      logger.warn("w");
      logger.error("e");

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });

    it("includes structured fields and a parseable ISO time", () => {
      const records: LogRecord[] = [];
      const logger = createLogger({ level: "info", sink: (r) => records.push(r) });

      logger.info("request", { requestId: "r1", status: 200, durationMs: 5 });

      const [record] = records;
      expect(record.requestId).toBe("r1");
      expect(record.status).toBe(200);
      expect(record.durationMs).toBe(5);
      expect(Number.isNaN(Date.parse(record.time))).toBe(false);
    });
  });

  describe("custom sink via setLogger", () => {
    it("captures structured records through the global logger", () => {
      const records: LogRecord[] = [];
      setLogger(createLogger({ level: "debug", sink: (r) => records.push(r) }));

      getLogger().error("boom", { code: "E_FAIL" });

      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ level: "error", msg: "boom", code: "E_FAIL" });
    });
  });

  describe("child()", () => {
    it("merges base fields into every record", () => {
      const records: LogRecord[] = [];
      const root = createLogger({ level: "debug", sink: (r) => records.push(r) });
      const child = root.child({ requestId: "abc" });

      child.info("scoped", { path: "/users" });

      expect(records[0]).toMatchObject({ requestId: "abc", path: "/users", msg: "scoped" });
    });

    it("lets per-call fields override inherited fields", () => {
      const records: LogRecord[] = [];
      const child = createLogger({ level: "debug", sink: (r) => records.push(r) }).child({
        requestId: "base",
      });

      child.info("m", { requestId: "override" });

      expect(records[0].requestId).toBe("override");
    });

    it("nested children accumulate fields", () => {
      const records: LogRecord[] = [];
      const a = createLogger({ level: "debug", sink: (r) => records.push(r) }).child({ a: 1 });
      const b = a.child({ b: 2 });

      b.warn("nested");

      expect(records[0]).toMatchObject({ a: 1, b: 2, level: "warn" });
    });
  });

  describe("resolveDefaultLevel", () => {
    beforeEach(() => {
      delete process.env.COVARA_LOG_LEVEL;
      delete process.env.COVARA_DEBUG;
    });

    it("defaults to info", () => {
      expect(resolveDefaultLevel()).toBe("info");
    });

    it("honors COVARA_LOG_LEVEL", () => {
      process.env.COVARA_LOG_LEVEL = "warn";
      expect(resolveDefaultLevel()).toBe("warn");
    });

    it("falls back to debug when COVARA_DEBUG=1", () => {
      process.env.COVARA_DEBUG = "1";
      expect(resolveDefaultLevel()).toBe("debug");
    });

    it("ignores invalid level values", () => {
      process.env.COVARA_LOG_LEVEL = "verbose";
      expect(resolveDefaultLevel()).toBe("info");
    });
  });
});
