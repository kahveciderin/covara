import { Hono } from "hono";
import { TaskScheduler, TaskRegistry, TaskWorker } from "@/tasks";
import { DeadLetterQueue } from "@/tasks/dlq";
import { logAdminAction, getAdminUser, requireAdminUser } from "./admin-auth";

export interface TaskMonitorConfig {
  enabled?: boolean;
  scheduler?: TaskScheduler;
  registry?: TaskRegistry;
  dlq?: DeadLetterQueue;
  workers?: TaskWorker[];
}

export const createTaskMonitorRoutes = (config: TaskMonitorConfig = {}): Hono => {
  const router = new Hono();

  if (!config.enabled) {
    router.all("*", (c) => c.json({ enabled: false }));
    return router;
  }

  router.get("/queue", async (c) => {
    if (!config.scheduler) {
      return c.json({ enabled: false, queueDepth: 0 });
    }

    const adminUser = getAdminUser(c);

    try {
      const queueDepth = await config.scheduler.getQueueDepth();

      const pendingTasks = await config.scheduler.getTasks({
        status: "pending",
        limit: 50,
      });

      const scheduledTasks = await config.scheduler.getTasks({
        status: "scheduled",
        limit: 50,
      });

      const runningTasks = await config.scheduler.getTasks({
        status: "running",
        limit: 50,
      });

      if (adminUser) {
        logAdminAction({
          userId: adminUser.id,
          userEmail: adminUser.email,
          operation: "task_monitor_view_queue",
          reason: "Admin view task queue",
        });
      }

      return c.json({
        enabled: true,
        queueDepth,
        pending: pendingTasks,
        scheduled: scheduledTasks,
        running: runningTasks,
      });
    } catch (error) {
      return c.json(
        {
          type: "/__covara/problems/internal-error",
          title: "Failed to fetch queue",
          status: 500,
          detail: error instanceof Error ? error.message : "Unknown error",
        },
        500
      );
    }
  });

  router.get("/task/:id", async (c) => {
    if (!config.scheduler) {
      return c.json({ enabled: false });
    }

    const id = c.req.param("id");

    try {
      const task = await config.scheduler.getTask(id);
      if (!task) {
        return c.json(
          {
            type: "/__covara/problems/not-found",
            title: "Task not found",
            status: 404,
          },
          404
        );
      }

      return c.json({ task });
    } catch (error) {
      return c.json(
        {
          type: "/__covara/problems/internal-error",
          title: "Failed to fetch task",
          status: 500,
          detail: error instanceof Error ? error.message : "Unknown error",
        },
        500
      );
    }
  });

  router.post("/task/:id/cancel", async (c) => {
    if (!config.scheduler) {
      return c.json({ enabled: false });
    }

    const adminUser = requireAdminUser(c);

    const id = c.req.param("id");

    try {
      const cancelled = await config.scheduler.cancel(id);

      logAdminAction({
        userId: adminUser.id,
        userEmail: adminUser.email,
        operation: "task_cancel",
        resourceId: id,
        reason: "Admin cancelled task",
        details: { success: cancelled },
      });

      return c.json({ cancelled });
    } catch (error) {
      return c.json(
        {
          type: "/__covara/problems/internal-error",
          title: "Failed to cancel task",
          status: 500,
          detail: error instanceof Error ? error.message : "Unknown error",
        },
        500
      );
    }
  });

  router.get("/dlq", async (c) => {
    if (!config.dlq) {
      return c.json({ enabled: false, entries: [] });
    }

    const adminUser = getAdminUser(c);
    const limit = parseInt(c.req.query("limit") ?? "50", 10);
    const offset = parseInt(c.req.query("offset") ?? "0", 10);

    try {
      const entries = await config.dlq.list(limit, offset);
      const total = await config.dlq.count();

      if (adminUser) {
        logAdminAction({
          userId: adminUser.id,
          userEmail: adminUser.email,
          operation: "task_monitor_view_dlq",
          reason: "Admin view dead letter queue",
        });
      }

      return c.json({ enabled: true, entries, total });
    } catch (error) {
      return c.json(
        {
          type: "/__covara/problems/internal-error",
          title: "Failed to fetch DLQ",
          status: 500,
          detail: error instanceof Error ? error.message : "Unknown error",
        },
        500
      );
    }
  });

  router.get("/dlq/:id", async (c) => {
    if (!config.dlq) {
      return c.json({ enabled: false });
    }

    const id = c.req.param("id");

    try {
      const entry = await config.dlq.get(id);
      if (!entry) {
        return c.json(
          {
            type: "/__covara/problems/not-found",
            title: "DLQ entry not found",
            status: 404,
          },
          404
        );
      }

      return c.json({ entry });
    } catch (error) {
      return c.json(
        {
          type: "/__covara/problems/internal-error",
          title: "Failed to fetch DLQ entry",
          status: 500,
          detail: error instanceof Error ? error.message : "Unknown error",
        },
        500
      );
    }
  });

  router.post("/dlq/:id/retry", async (c) => {
    if (!config.dlq) {
      return c.json({ enabled: false });
    }

    const adminUser = requireAdminUser(c);

    const id = c.req.param("id");

    try {
      const newTaskId = await config.dlq.retry(id);

      logAdminAction({
        userId: adminUser.id,
        userEmail: adminUser.email,
        operation: "task_dlq_retry",
        resourceId: id,
        reason: "Admin retried DLQ task",
        details: { newTaskId },
      });

      return c.json({ success: !!newTaskId, newTaskId });
    } catch (error) {
      return c.json(
        {
          type: "/__covara/problems/internal-error",
          title: "Failed to retry task",
          status: 500,
          detail: error instanceof Error ? error.message : "Unknown error",
        },
        500
      );
    }
  });

  router.delete("/dlq/:id", async (c) => {
    if (!config.dlq) {
      return c.json({ enabled: false });
    }

    const adminUser = requireAdminUser(c);

    const id = c.req.param("id");

    try {
      const entry = await config.dlq.get(id);
      if (!entry) {
        return c.json(
          {
            type: "/__covara/problems/not-found",
            title: "DLQ entry not found",
            status: 404,
          },
          404
        );
      }

      await config.dlq.purge(Date.now() - entry.failedAt + 1000);

      logAdminAction({
        userId: adminUser.id,
        userEmail: adminUser.email,
        operation: "task_dlq_purge",
        resourceId: id,
        reason: "Admin purged DLQ entry",
      });

      return c.body(null, 204);
    } catch (error) {
      return c.json(
        {
          type: "/__covara/problems/internal-error",
          title: "Failed to purge DLQ entry",
          status: 500,
          detail: error instanceof Error ? error.message : "Unknown error",
        },
        500
      );
    }
  });

  router.get("/workers", (c) => {
    if (!config.workers || config.workers.length === 0) {
      return c.json({ enabled: false, workers: [] });
    }

    try {
      const workers = config.workers.map((w) => w.getStats());
      return c.json({ enabled: true, workers });
    } catch (error) {
      return c.json(
        {
          type: "/__covara/problems/internal-error",
          title: "Failed to fetch workers",
          status: 500,
          detail: error instanceof Error ? error.message : "Unknown error",
        },
        500
      );
    }
  });

  router.get("/definitions", (c) => {
    if (!config.registry) {
      return c.json({ enabled: false, definitions: [] });
    }

    try {
      const definitions = config.registry.getAll().map((d) => ({
        name: d.name,
        hasInput: !!d.input,
        hasOutput: !!d.output,
        priority: d.priority,
        timeout: d.timeout,
        maxConcurrency: d.maxConcurrency,
        retry: d.retry,
      }));

      return c.json({ enabled: true, definitions });
    } catch (error) {
      return c.json(
        {
          type: "/__covara/problems/internal-error",
          title: "Failed to fetch definitions",
          status: 500,
          detail: error instanceof Error ? error.message : "Unknown error",
        },
        500
      );
    }
  });

  return router;
};
