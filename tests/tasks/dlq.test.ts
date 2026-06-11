import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { createDeadLetterQueue, DeadLetterQueue } from "@/tasks/dlq";
import { createTaskStorage, TaskStorage } from "@/tasks/storage";
import { createMemoryKV, KVAdapter } from "@/kv";
import { Task } from "@/tasks/types";

let kv: KVAdapter;
let storage: TaskStorage;
let dlq: DeadLetterQueue;
const requeuedTasks: Task[] = [];

const createTestTask = (overrides: Partial<Task> = {}): Task => ({
  id: crypto.randomUUID(),
  name: "test-task",
  input: { data: "test" },
  status: "failed",
  priority: 50,
  createdAt: Date.now(),
  scheduledFor: Date.now(),
  attempt: 3,
  maxAttempts: 3,
  lastError: "Test error",
  ...overrides,
});

describe("Dead Letter Queue", () => {
  beforeAll(async () => {
    kv = createMemoryKV("test-dlq");
    await kv.connect();
  });

  afterAll(async () => {
    await kv.disconnect();
  });

  beforeEach(async () => {
    storage = createTaskStorage(kv);
    requeuedTasks.length = 0;
    dlq = createDeadLetterQueue(kv, async (task) => {
      requeuedTasks.push(task);
      await storage.store(task);
      return task.id;
    });

    const allKeys = await kv.keys("*");
    for (const key of allKeys) {
      await kv.del(key);
    }
  });

  describe("add", () => {
    it("should add a task to the dead letter queue", async () => {
      const task = createTestTask();
      await storage.store(task);

      await dlq.add(task, "Max retries exceeded");

      const entry = await dlq.get(task.id);
      expect(entry).not.toBeNull();
      expect(entry?.taskId).toBe(task.id);
      expect(entry?.reason).toBe("Max retries exceeded");
      expect(entry?.attempts).toBe(task.attempt);
    });

    it("should update task status to dead", async () => {
      const task = createTestTask({ status: "running" });
      await storage.store(task);

      await dlq.add(task, "Processing failed");

      const stored = await storage.get(task.id);
      expect(stored?.status).toBe("dead");
      expect(stored?.lastError).toBe("Processing failed");
    });

    it("should set failedAt timestamp", async () => {
      const task = createTestTask();
      await storage.store(task);

      const before = Date.now();
      await dlq.add(task, "Error");
      const after = Date.now();

      const entry = await dlq.get(task.id);
      expect(entry?.failedAt).toBeGreaterThanOrEqual(before);
      expect(entry?.failedAt).toBeLessThanOrEqual(after);
    });

    it("should preserve task data", async () => {
      const task = createTestTask({
        input: { complex: { nested: "data" }, array: [1, 2, 3] },
      });
      await storage.store(task);

      await dlq.add(task, "Error");

      const entry = await dlq.get(task.id);
      expect(entry?.task.input).toEqual({ complex: { nested: "data" }, array: [1, 2, 3] });
    });
  });

  describe("list", () => {
    it("should list all dead tasks", async () => {
      const task1 = createTestTask({ id: "task-1" });
      const task2 = createTestTask({ id: "task-2" });
      const task3 = createTestTask({ id: "task-3" });

      await storage.store(task1);
      await storage.store(task2);
      await storage.store(task3);

      await dlq.add(task1, "Error 1");
      await dlq.add(task2, "Error 2");
      await dlq.add(task3, "Error 3");

      const entries = await dlq.list();

      expect(entries).toHaveLength(3);
    });

    it("should limit results", async () => {
      for (let i = 0; i < 10; i++) {
        const task = createTestTask({ id: `task-${i}` });
        await storage.store(task);
        await dlq.add(task, `Error ${i}`);
      }

      const entries = await dlq.list(5);
      expect(entries).toHaveLength(5);
    });

    it("should offset results", async () => {
      for (let i = 0; i < 10; i++) {
        const task = createTestTask({ id: `task-${i}` });
        await storage.store(task);
        await dlq.add(task, `Error ${i}`);
      }

      const page1 = await dlq.list(5, 0);
      const page2 = await dlq.list(5, 5);

      expect(page1).toHaveLength(5);
      expect(page2).toHaveLength(5);

      const ids1 = page1.map((e) => e.taskId);
      const ids2 = page2.map((e) => e.taskId);
      expect(ids1.some((id) => ids2.includes(id))).toBe(false);
    });

    it("should return empty array when no dead tasks", async () => {
      const entries = await dlq.list();
      expect(entries).toEqual([]);
    });
  });

  describe("get", () => {
    it("should return null for non-existent entry", async () => {
      const entry = await dlq.get("nonexistent");
      expect(entry).toBeNull();
    });

    it("should return complete dead letter entry", async () => {
      const task = createTestTask({
        name: "get-test",
        input: { key: "value" },
        attempt: 5,
        maxAttempts: 5,
      });
      await storage.store(task);
      await dlq.add(task, "Specific error");

      const entry = await dlq.get(task.id);

      expect(entry).not.toBeNull();
      expect(entry?.taskId).toBe(task.id);
      expect(entry?.task.name).toBe("get-test");
      expect(entry?.task.input).toEqual({ key: "value" });
      expect(entry?.reason).toBe("Specific error");
      expect(entry?.attempts).toBe(5);
      expect(entry?.failedAt).toBeDefined();
    });
  });

  describe("retry", () => {
    it("should retry a dead task", async () => {
      const task = createTestTask({
        name: "retry-test",
        input: { important: "data" },
      });
      await storage.store(task);
      await dlq.add(task, "Original error");

      const newTaskId = await dlq.retry(task.id);

      expect(newTaskId).toBeDefined();
      expect(newTaskId).not.toBe(task.id);

      expect(requeuedTasks).toHaveLength(1);
      expect(requeuedTasks[0].name).toBe("retry-test");
      expect(requeuedTasks[0].input).toEqual({ important: "data" });
    });

    it("should create new task with reset state", async () => {
      const task = createTestTask({
        attempt: 5,
        lastError: "Old error",
        startedAt: Date.now() - 1000,
        completedAt: Date.now(),
        workerId: "old-worker",
        result: { failed: true },
      });
      await storage.store(task);
      await dlq.add(task, "Error");

      await dlq.retry(task.id);

      const newTask = requeuedTasks[0];
      expect(newTask.status).toBe("pending");
      expect(newTask.attempt).toBe(0);
      expect(newTask.startedAt).toBeUndefined();
      expect(newTask.completedAt).toBeUndefined();
      expect(newTask.workerId).toBeUndefined();
      expect(newTask.lastError).toBeUndefined();
      expect(newTask.result).toBeUndefined();
    });

    it("should remove task from dead letter queue after retry", async () => {
      const task = createTestTask();
      await storage.store(task);
      await dlq.add(task, "Error");

      await dlq.retry(task.id);

      const entry = await dlq.get(task.id);
      expect(entry).toBeNull();
    });

    it("should return null for non-existent task", async () => {
      const result = await dlq.retry("nonexistent");
      expect(result).toBeNull();
    });

    it("should set new scheduledFor to now", async () => {
      const task = createTestTask({
        scheduledFor: Date.now() - 60000,
      });
      await storage.store(task);
      await dlq.add(task, "Error");

      const before = Date.now();
      await dlq.retry(task.id);
      const after = Date.now();

      const newTask = requeuedTasks[0];
      expect(newTask.scheduledFor).toBeGreaterThanOrEqual(before);
      expect(newTask.scheduledFor).toBeLessThanOrEqual(after);
    });

    it("should set new createdAt to now", async () => {
      const task = createTestTask({
        createdAt: Date.now() - 60000,
      });
      await storage.store(task);
      await dlq.add(task, "Error");

      const before = Date.now();
      await dlq.retry(task.id);
      const after = Date.now();

      const newTask = requeuedTasks[0];
      expect(newTask.createdAt).toBeGreaterThanOrEqual(before);
      expect(newTask.createdAt).toBeLessThanOrEqual(after);
    });
  });

  describe("retryAll", () => {
    it("should retry all dead tasks", async () => {
      for (let i = 0; i < 5; i++) {
        const task = createTestTask({ id: `task-${i}`, name: `task-${i}` });
        await storage.store(task);
        await dlq.add(task, `Error ${i}`);
      }

      const retried = await dlq.retryAll();

      expect(retried).toBe(5);
      expect(requeuedTasks).toHaveLength(5);
    });

    it("should return 0 when no dead tasks", async () => {
      const retried = await dlq.retryAll();
      expect(retried).toBe(0);
    });

    it("should clear dead letter queue", async () => {
      for (let i = 0; i < 3; i++) {
        const task = createTestTask({ id: `task-${i}` });
        await storage.store(task);
        await dlq.add(task, `Error ${i}`);
      }

      await dlq.retryAll();

      const count = await dlq.count();
      expect(count).toBe(0);
    });
  });

  describe("purge", () => {
    it("should purge all dead tasks when no time specified", async () => {
      for (let i = 0; i < 5; i++) {
        const task = createTestTask({ id: `task-${i}` });
        await storage.store(task);
        await dlq.add(task, `Error ${i}`);
      }

      const purged = await dlq.purge();

      expect(purged).toBe(5);

      const count = await dlq.count();
      expect(count).toBe(0);
    });

    it("should purge only old tasks when time specified", async () => {
      const oldTask = createTestTask({ id: "old-task" });
      await storage.store(oldTask);
      await kv.zadd("covara:tasks:dead", Date.now() - 10000, oldTask.id);
      await kv.hmset(`covara:tasks:dead:data:${oldTask.id}`, {
        taskId: oldTask.id,
        task: JSON.stringify(oldTask),
        failedAt: String(Date.now() - 10000),
        reason: "Old error",
        attempts: "3",
      });

      const newTask = createTestTask({ id: "new-task" });
      await storage.store(newTask);
      await dlq.add(newTask, "New error");

      const purged = await dlq.purge(5000);

      expect(purged).toBe(1);

      const count = await dlq.count();
      expect(count).toBe(1);

      const remaining = await dlq.get("new-task");
      expect(remaining).not.toBeNull();
    });

    it("should return 0 when nothing to purge", async () => {
      const purged = await dlq.purge();
      expect(purged).toBe(0);
    });

    it("should delete task data along with DLQ entry", async () => {
      const task = createTestTask();
      await storage.store(task);
      await dlq.add(task, "Error");

      await dlq.purge();

      const stored = await storage.get(task.id);
      expect(stored).toBeNull();
    });
  });

  describe("count", () => {
    it("should return 0 for empty queue", async () => {
      const count = await dlq.count();
      expect(count).toBe(0);
    });

    it("should return correct count", async () => {
      for (let i = 0; i < 7; i++) {
        const task = createTestTask({ id: `task-${i}` });
        await storage.store(task);
        await dlq.add(task, `Error ${i}`);
      }

      const count = await dlq.count();
      expect(count).toBe(7);
    });

    it("should update count after operations", async () => {
      const task1 = createTestTask({ id: "task-1" });
      const task2 = createTestTask({ id: "task-2" });
      await storage.store(task1);
      await storage.store(task2);

      await dlq.add(task1, "Error 1");
      expect(await dlq.count()).toBe(1);

      await dlq.add(task2, "Error 2");
      expect(await dlq.count()).toBe(2);

      await dlq.retry(task1.id);
      expect(await dlq.count()).toBe(1);

      await dlq.purge();
      expect(await dlq.count()).toBe(0);
    });
  });

  describe("edge cases", () => {
    it("should handle task with complex input", async () => {
      const task = createTestTask({
        input: {
          nested: { deeply: { nested: { value: "test" } } },
          array: [1, { key: "value" }, [2, 3]],
          date: "2024-01-15T00:00:00Z",
          special: "unicode: \u2665",
        },
      });
      await storage.store(task);
      await dlq.add(task, "Error");

      const entry = await dlq.get(task.id);
      expect(entry?.task.input).toEqual(task.input);
    });

    it("should handle very long error messages", async () => {
      const task = createTestTask();
      await storage.store(task);

      const longError = "x".repeat(10000);
      await dlq.add(task, longError);

      const entry = await dlq.get(task.id);
      expect(entry?.reason).toBe(longError);
    });

    it("should handle special characters in error messages", async () => {
      const task = createTestTask();
      await storage.store(task);

      const specialError = 'Error: "quotes" and \'single\' and \n newlines \t tabs';
      await dlq.add(task, specialError);

      const entry = await dlq.get(task.id);
      expect(entry?.reason).toBe(specialError);
    });

    it("should handle concurrent adds", async () => {
      const tasks = Array.from({ length: 10 }, (_, i) =>
        createTestTask({ id: `concurrent-${i}` })
      );

      await Promise.all(tasks.map((task) => storage.store(task)));
      await Promise.all(tasks.map((task) => dlq.add(task, `Error ${task.id}`)));

      const count = await dlq.count();
      expect(count).toBe(10);
    });
  });
});
