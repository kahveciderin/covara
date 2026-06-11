import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import {
  createRecurringManager,
  calculateNextRun,
  startRecurringScheduler,
  RecurringManager,
} from "@/tasks/recurring";
import { createMemoryKV, KVAdapter } from "@/kv";

let kv: KVAdapter;
let manager: RecurringManager;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("Recurring Tasks", () => {
  beforeAll(async () => {
    kv = createMemoryKV("test-recurring");
    await kv.connect();
  });

  afterAll(async () => {
    await kv.disconnect();
  });

  beforeEach(async () => {
    manager = createRecurringManager(kv);

    const allKeys = await kv.keys("*");
    for (const key of allKeys) {
      await kv.del(key);
    }
  });

  describe("calculateNextRun", () => {
    describe("cron expressions", () => {
      it("should calculate next run for hourly cron", () => {
        const fromTime = new Date("2024-01-15T10:30:00Z").getTime();
        const nextRun = calculateNextRun(
          { cron: "0 * * * *", timezone: "UTC" },
          fromTime
        );

        const nextDate = new Date(nextRun);
        expect(nextDate.getUTCMinutes()).toBe(0);
        expect(nextDate.getUTCHours()).toBe(11);
      });

      it("should calculate next run for daily cron", () => {
        const fromTime = new Date("2024-01-15T10:30:00Z").getTime();
        const nextRun = calculateNextRun(
          { cron: "0 0 * * *", timezone: "UTC" },
          fromTime
        );

        const nextDate = new Date(nextRun);
        expect(nextDate.getUTCHours()).toBe(0);
        expect(nextDate.getUTCMinutes()).toBe(0);
        expect(nextDate.getUTCDate()).toBe(16);
      });

      it("should calculate next run for weekly cron (Mondays)", () => {
        const fromTime = new Date("2024-01-15T10:30:00Z").getTime();
        const nextRun = calculateNextRun(
          { cron: "0 9 * * 1", timezone: "UTC" },
          fromTime
        );

        const nextDate = new Date(nextRun);
        expect(nextDate.getUTCDay()).toBe(1);
        expect(nextDate.getUTCHours()).toBe(9);
      });

      it("should respect timezone", () => {
        const fromTime = new Date("2024-01-15T10:00:00Z").getTime();

        const utcNext = calculateNextRun(
          { cron: "0 12 * * *", timezone: "UTC" },
          fromTime
        );

        const nyNext = calculateNextRun(
          { cron: "0 12 * * *", timezone: "America/New_York" },
          fromTime
        );

        expect(utcNext).not.toBe(nyNext);
      });
    });

    describe("interval", () => {
      it("should calculate next run from interval", () => {
        const fromTime = Date.now();
        const nextRun = calculateNextRun(
          { interval: 60000 },
          fromTime
        );

        expect(nextRun).toBe(fromTime + 60000);
      });

      it("should handle very short intervals", () => {
        const fromTime = Date.now();
        const nextRun = calculateNextRun(
          { interval: 100 },
          fromTime
        );

        expect(nextRun).toBe(fromTime + 100);
      });

      it("should handle very long intervals", () => {
        const fromTime = Date.now();
        const interval = 7 * 24 * 60 * 60 * 1000;
        const nextRun = calculateNextRun(
          { interval },
          fromTime
        );

        expect(nextRun).toBe(fromTime + interval);
      });
    });

    it("should throw error when neither cron nor interval specified", () => {
      expect(() => calculateNextRun({}, Date.now())).toThrow(
        "Either cron or interval must be specified"
      );
    });
  });

  describe("RecurringManager", () => {
    describe("create", () => {
      it("should create a recurring schedule with cron", async () => {
        const scheduleId = await manager.create(
          { name: "cron-task" } as never,
          { data: "test" },
          { cron: "0 * * * *", timezone: "UTC" }
        );

        expect(scheduleId).toBeDefined();
        expect(typeof scheduleId).toBe("string");

        const schedule = await manager.get(scheduleId);
        expect(schedule).not.toBeNull();
        expect(schedule?.taskName).toBe("cron-task");
        expect(schedule?.cron).toBe("0 * * * *");
        expect(schedule?.timezone).toBe("UTC");
        expect(schedule?.enabled).toBe(true);
        expect(schedule?.input).toEqual({ data: "test" });
      });

      it("should create a recurring schedule with interval", async () => {
        const scheduleId = await manager.create(
          { name: "interval-task" } as never,
          {},
          { interval: 60000 }
        );

        const schedule = await manager.get(scheduleId);
        expect(schedule?.interval).toBe(60000);
        expect(schedule?.cron).toBeUndefined();
      });

      it("should calculate initial nextRunAt", async () => {
        const before = Date.now();
        const scheduleId = await manager.create(
          { name: "next-run-test" } as never,
          {},
          { interval: 5000 }
        );

        const schedule = await manager.get(scheduleId);
        expect(schedule?.nextRunAt).toBeGreaterThanOrEqual(before + 5000);
      });

      it("should default timezone to UTC", async () => {
        const scheduleId = await manager.create(
          { name: "timezone-default" } as never,
          {},
          { cron: "0 * * * *" }
        );

        const schedule = await manager.get(scheduleId);
        expect(schedule?.timezone).toBe("UTC");
      });
    });

    describe("pause and resume", () => {
      it("should pause a recurring schedule", async () => {
        const scheduleId = await manager.create(
          { name: "pause-test" } as never,
          {},
          { interval: 60000 }
        );

        await manager.pause(scheduleId);

        const schedule = await manager.get(scheduleId);
        expect(schedule?.enabled).toBe(false);
      });

      it("should resume a paused schedule", async () => {
        const scheduleId = await manager.create(
          { name: "resume-test" } as never,
          {},
          { interval: 60000 }
        );

        await manager.pause(scheduleId);
        await manager.resume(scheduleId);

        const schedule = await manager.get(scheduleId);
        expect(schedule?.enabled).toBe(true);
      });

      it("should recalculate nextRunAt on resume", async () => {
        const scheduleId = await manager.create(
          { name: "resume-recalc" } as never,
          {},
          { interval: 1000 }
        );

        const beforePause = await manager.get(scheduleId);
        await sleep(50);

        await manager.pause(scheduleId);
        await sleep(50);

        const resumeTime = Date.now();
        await manager.resume(scheduleId);

        const afterResume = await manager.get(scheduleId);
        expect(afterResume?.nextRunAt).toBeGreaterThanOrEqual(resumeTime + 1000);
      });
    });

    describe("delete", () => {
      it("should delete a recurring schedule", async () => {
        const scheduleId = await manager.create(
          { name: "delete-test" } as never,
          {},
          { interval: 60000 }
        );

        await manager.delete(scheduleId);

        const schedule = await manager.get(scheduleId);
        expect(schedule).toBeNull();
      });

      it("should handle deleting non-existent schedule", async () => {
        await expect(manager.delete("nonexistent")).resolves.not.toThrow();
      });
    });

    describe("get", () => {
      it("should return null for non-existent schedule", async () => {
        const schedule = await manager.get("nonexistent");
        expect(schedule).toBeNull();
      });

      it("should return complete schedule object", async () => {
        const scheduleId = await manager.create(
          { name: "get-test" } as never,
          { key: "value" },
          { cron: "0 12 * * *", timezone: "America/New_York" }
        );

        const schedule = await manager.get(scheduleId);

        expect(schedule).not.toBeNull();
        expect(schedule?.id).toBe(scheduleId);
        expect(schedule?.taskName).toBe("get-test");
        expect(schedule?.input).toEqual({ key: "value" });
        expect(schedule?.cron).toBe("0 12 * * *");
        expect(schedule?.timezone).toBe("America/New_York");
        expect(schedule?.enabled).toBe(true);
        expect(schedule?.createdAt).toBeDefined();
        expect(schedule?.nextRunAt).toBeDefined();
      });
    });

    describe("list", () => {
      it("should list all recurring schedules", async () => {
        await manager.create({ name: "list-1" } as never, {}, { interval: 1000 });
        await manager.create({ name: "list-2" } as never, {}, { interval: 2000 });
        await manager.create({ name: "list-3" } as never, {}, { interval: 3000 });

        const schedules = await manager.list();

        expect(schedules).toHaveLength(3);
        expect(schedules.map((s) => s.taskName)).toContain("list-1");
        expect(schedules.map((s) => s.taskName)).toContain("list-2");
        expect(schedules.map((s) => s.taskName)).toContain("list-3");
      });

      it("should return empty array when no schedules exist", async () => {
        const schedules = await manager.list();
        expect(schedules).toEqual([]);
      });
    });

    describe("tick", () => {
      it("should enqueue due tasks", async () => {
        const enqueuedTasks: { name: string; input: unknown }[] = [];

        const scheduleId = await manager.create(
          { name: "tick-test" } as never,
          { data: "test" },
          { interval: 10 }
        );

        await sleep(50);

        await manager.tick(async (taskName, input) => {
          enqueuedTasks.push({ name: taskName, input });
          return "task-id";
        });

        expect(enqueuedTasks).toHaveLength(1);
        expect(enqueuedTasks[0].name).toBe("tick-test");
        expect(enqueuedTasks[0].input).toEqual({ data: "test" });
      });

      it("should update lastRunAt and nextRunAt after tick", async () => {
        const scheduleId = await manager.create(
          { name: "tick-update" } as never,
          {},
          { interval: 100 }
        );

        await sleep(150);

        const beforeTick = await manager.get(scheduleId);
        const tickTime = Date.now();

        await manager.tick(async () => "task-id");

        const afterTick = await manager.get(scheduleId);

        expect(afterTick?.lastRunAt).toBeDefined();
        expect(afterTick?.lastRunAt).toBeLessThanOrEqual(tickTime + 10);
        expect(afterTick?.nextRunAt).toBeGreaterThan(beforeTick!.nextRunAt);
      });

      it("should not enqueue paused schedules", async () => {
        const enqueuedTasks: string[] = [];

        const scheduleId = await manager.create(
          { name: "paused-tick" } as never,
          {},
          { interval: 10 }
        );

        await manager.pause(scheduleId);
        await sleep(50);

        await manager.tick(async (taskName) => {
          enqueuedTasks.push(taskName);
          return "task-id";
        });

        expect(enqueuedTasks).toHaveLength(0);
      });

      it("should not enqueue schedules not yet due", async () => {
        const enqueuedTasks: string[] = [];

        await manager.create(
          { name: "not-due" } as never,
          {},
          { interval: 60000 }
        );

        await manager.tick(async (taskName) => {
          enqueuedTasks.push(taskName);
          return "task-id";
        });

        expect(enqueuedTasks).toHaveLength(0);
      });

      it("should handle multiple due schedules", async () => {
        const enqueuedTasks: string[] = [];

        await manager.create({ name: "multi-1" } as never, {}, { interval: 10 });
        await manager.create({ name: "multi-2" } as never, {}, { interval: 10 });
        await manager.create({ name: "multi-3" } as never, {}, { interval: 10 });

        await sleep(50);

        await manager.tick(async (taskName) => {
          enqueuedTasks.push(taskName);
          return "task-id";
        });

        expect(enqueuedTasks).toHaveLength(3);
      });

      it("should clean up orphaned schedules", async () => {
        await kv.zadd("covara:tasks:recurring", Date.now() - 1000, "orphan-id");

        await manager.tick(async () => "task-id");

        const score = await kv.zscore("covara:tasks:recurring", "orphan-id");
        expect(score).toBeNull();
      });
    });
  });

  describe("startRecurringScheduler", () => {
    it("should start periodic tick execution", async () => {
      const enqueuedTasks: string[] = [];

      await manager.create(
        { name: "scheduler-test" } as never,
        {},
        { interval: 30 }
      );

      const stop = startRecurringScheduler(
        kv,
        async (taskName) => {
          enqueuedTasks.push(taskName);
          return "task-id";
        },
        50
      );

      await sleep(200);
      stop();

      expect(enqueuedTasks.length).toBeGreaterThanOrEqual(1);
    });

    it("should stop when stop function is called", async () => {
      let tickCount = 0;

      await manager.create(
        { name: "stop-scheduler" } as never,
        {},
        { interval: 10 }
      );

      const stop = startRecurringScheduler(
        kv,
        async () => {
          tickCount++;
          return "task-id";
        },
        30
      );

      await sleep(100);
      stop();
      const countAfterStop = tickCount;

      await sleep(100);

      expect(tickCount).toBe(countAfterStop);
    });
  });
});
