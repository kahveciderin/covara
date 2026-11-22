import { createMemoryKV } from "@/kv";
import { createTaskRegistry, createTaskScheduler } from "@/tasks/scheduler";
import { createTaskWorker } from "@/tasks/worker";
import { defineTask } from "@/tasks/define";

const mode = process.argv[2];
const kv = createMemoryKV("exit");
await kv.connect();
const registry = createTaskRegistry();
const job = defineTask({
  name: "job",
  timeout: 60_000,
  handler: (ctx) =>
    new Promise<void>((resolve, reject) => {
      if (mode === "done") setTimeout(resolve, 50);
      if (mode === "abort") ctx.signal.addEventListener("abort", () => reject(new Error("aborted")));
    }),
});
registry.register(job);
await createTaskScheduler(kv, registry).enqueue(job, {});
const worker = createTaskWorker(kv, registry, { pollIntervalMs: 20 });
await worker.start();
await new Promise((resolve) => setTimeout(resolve, 400));
await worker.stop();
await kv.disconnect();
