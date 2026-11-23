import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { publishCommitted } from "@/resource/publish-committed";
import { setLogger, getLogger, createLogger, type LogRecord } from "@/server/logger";

describe("publishCommitted logs once per outage", () => {
  let logs: LogRecord[];
  let previous: ReturnType<typeof getLogger>;
  const fail = () => Promise.reject(new Error("Connection is closed."));
  const succeed = () => Promise.resolve();

  beforeEach(async () => {
    logs = [];
    previous = getLogger();
    setLogger(createLogger({ level: "debug", sink: (r) => logs.push(r) }));
    await publishCommitted("items", succeed);
    logs.length = 0;
  });

  afterEach(() => setLogger(previous));

  it("many failed writes in a row give one error line", async () => {
    for (let i = 0; i < 20; i++) await publishCommitted("items", fail);
    expect(logs.filter((l) => l.level === "error")).toHaveLength(1);
    expect(logs[0].error).toBe("Connection is closed.");
  });

  it("the first success after failures says how many writes were not published", async () => {
    for (let i = 0; i < 20; i++) await publishCommitted("items", fail);
    await publishCommitted("items", succeed);
    await publishCommitted("items", succeed);
    const info = logs.filter((l) => l.level === "info");
    expect(info).toHaveLength(1);
    expect(info[0].failedWrites).toBe(20);
  });

  it("a new outage is logged again", async () => {
    await publishCommitted("items", fail);
    await publishCommitted("items", succeed);
    await publishCommitted("items", fail);
    expect(logs.filter((l) => l.level === "error")).toHaveLength(2);
  });

  it("never rejects", async () => {
    await expect(publishCommitted("items", () => { throw new Error("sync"); })).resolves.toBeUndefined();
  });
});
