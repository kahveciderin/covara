import { KVAdapter } from "@/kv/types";
import { Task, TaskContext, TaskDefinition, ScheduleOptions } from "./types";
import { TaskRegistry } from "./scheduler";
import { createTaskStorage } from "./storage";
import { createDeadLetterQueue, DeadLetterQueueOptions } from "./dlq";
import { calculateBackoff, shouldRetry } from "./retry";
import {
  createIdempotencyStore,
  DEFAULT_IDEMPOTENCY_RETENTION_MS,
} from "./idempotency";
import { DEFAULT_RESULT_TTL_MS } from "./worker";

export interface QueueSendOptions {
  delaySeconds?: number;
  contentType?: string;
}

export interface QueueBindingLike<TBody = unknown> {
  send(message: TBody, options?: QueueSendOptions): Promise<void>;
  sendBatch?(
    messages: Iterable<{ body: TBody; options?: QueueSendOptions }>
  ): Promise<void>;
}

export interface QueueMessageLike<TBody = unknown> {
  readonly id: string;
  readonly timestamp: Date;
  readonly body: TBody;
  readonly attempts?: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

export interface MessageBatchLike<TBody = unknown> {
  readonly queue: string;
  readonly messages: QueueMessageLike<TBody>[];
  ackAll?(): void;
  retryAll?(options?: { delaySeconds?: number }): void;
}

export interface QueueTaskMessage<TInput = unknown> {
  taskId: string;
  name: string;
  input: TInput;
  attempt: number;
  maxAttempts: number;
  priority: number;
  scheduledFor: number;
  createdAt: number;
  idempotencyKey?: string;
  originalTaskId?: string;
  replayCount?: number;
}

export interface CloudflareQueueProducer {
  enqueue<TInput>(
    task: TaskDefinition<TInput>,
    input: TInput,
    options?: ScheduleOptions
  ): Promise<string>;
  enqueueBatch<TInput>(
    task: TaskDefinition<TInput>,
    inputs: TInput[],
    options?: ScheduleOptions
  ): Promise<string[]>;
}

const buildMessage = <TInput>(
  task: TaskDefinition<TInput>,
  input: TInput,
  options?: ScheduleOptions
): QueueTaskMessage<TInput> => {
  const now = Date.now();
  const scheduledFor = options?.at?.getTime() ?? now + (options?.delay ?? 0);
  return {
    taskId: crypto.randomUUID(),
    name: task.name,
    input,
    attempt: 0,
    maxAttempts: task.retry?.maxAttempts ?? 3,
    priority: options?.priority ?? task.priority ?? 50,
    scheduledFor,
    createdAt: now,
    ...(options?.idempotencyKey ?? task.idempotencyKey?.(input)
      ? {
          idempotencyKey:
            options?.idempotencyKey ?? task.idempotencyKey?.(input),
        }
      : {}),
  };
};

const delaySecondsFor = (message: QueueTaskMessage): number | undefined => {
  const diff = message.scheduledFor - Date.now();
  if (diff <= 0) return undefined;
  return Math.ceil(diff / 1000);
};

export const createCloudflareQueueProducer = (
  binding: QueueBindingLike<QueueTaskMessage>
): CloudflareQueueProducer => ({
  async enqueue<TInput>(
    task: TaskDefinition<TInput>,
    input: TInput,
    options?: ScheduleOptions
  ): Promise<string> {
    const message = buildMessage(task, input, options);
    const delaySeconds = delaySecondsFor(message);
    await binding.send(
      message as QueueTaskMessage,
      delaySeconds !== undefined ? { delaySeconds } : undefined
    );
    return message.taskId;
  },

  async enqueueBatch<TInput>(
    task: TaskDefinition<TInput>,
    inputs: TInput[],
    options?: ScheduleOptions
  ): Promise<string[]> {
    const messages = inputs.map((input) => buildMessage(task, input, options));

    if (binding.sendBatch) {
      await binding.sendBatch(
        messages.map((message) => {
          const delaySeconds = delaySecondsFor(message);
          return {
            body: message as QueueTaskMessage,
            ...(delaySeconds !== undefined ? { options: { delaySeconds } } : {}),
          };
        })
      );
    } else {
      for (const message of messages) {
        const delaySeconds = delaySecondsFor(message);
        await binding.send(
          message as QueueTaskMessage,
          delaySeconds !== undefined ? { delaySeconds } : undefined
        );
      }
    }

    return messages.map((message) => message.taskId);
  },
});

export interface QueueConsumerConfig {
  kv: KVAdapter;
  registry: TaskRegistry;
  workerId?: string;
  db?: unknown;
  onDlqEnqueue?: DeadLetterQueueOptions["onDlqEnqueue"];
}

export interface QueueConsumer<TInput = unknown> {
  process(batch: MessageBatchLike<QueueTaskMessage<TInput>>): Promise<void>;
}

const toTask = (message: QueueTaskMessage): Task => ({
  id: message.taskId,
  name: message.name,
  input: message.input,
  status: "running",
  priority: message.priority,
  createdAt: message.createdAt,
  scheduledFor: message.scheduledFor,
  attempt: message.attempt,
  maxAttempts: message.maxAttempts,
  ...(message.idempotencyKey !== undefined && {
    idempotencyKey: message.idempotencyKey,
  }),
  ...(message.originalTaskId !== undefined && {
    originalTaskId: message.originalTaskId,
  }),
  ...(message.replayCount !== undefined && { replayCount: message.replayCount }),
});

export const createQueueConsumer = (
  config: QueueConsumerConfig
): QueueConsumer => {
  const { kv, registry } = config;
  const workerId = config.workerId ?? "cf-queue-consumer";
  const storage = createTaskStorage(kv);
  const idempotencyStore = createIdempotencyStore(kv);

  const dlq = createDeadLetterQueue(
    kv,
    async () => {
      throw new Error("Queue consumer DLQ entries are not auto-requeued");
    },
    { onDlqEnqueue: config.onDlqEnqueue }
  );

  const runMessage = async (
    message: QueueMessageLike<QueueTaskMessage>
  ): Promise<void> => {
    const payload = message.body;
    const definition = registry.get(payload.name) as
      | TaskDefinition
      | undefined;

    const task = toTask(payload);
    const attemptNumber =
      message.attempts ?? payload.attempt + 1;

    if (!definition) {
      await storage.store({ ...task, status: "pending" });
      await dlq.add(
        { ...task, attempt: attemptNumber },
        `Unknown task type: ${payload.name}`
      );
      message.ack();
      return;
    }

    const retryConfig = definition.retry ?? {};
    const maxAttempts = payload.maxAttempts;
    const idempotencyKey = payload.idempotencyKey;
    const retentionMs =
      definition.idempotencyRetentionMs ?? DEFAULT_IDEMPOTENCY_RETENTION_MS;
    const resultTtlMs = definition.resultTtlMs ?? DEFAULT_RESULT_TTL_MS;

    await storage.store({ ...task, status: "running", startedAt: Date.now() });

    try {
      if (idempotencyKey) {
        const completed = await idempotencyStore.getCompleted(idempotencyKey);
        if (completed) {
          await storage.updateStatus(task.id, "running", "completed", {
            result: completed.result,
            completedAt: Date.now(),
            resultExpiresAt: Date.now() + resultTtlMs,
          });
          message.ack();
          return;
        }
      }

      const controller = new AbortController();
      const ctx: TaskContext = {
        taskId: task.id,
        attempt: attemptNumber,
        scheduledAt: new Date(task.scheduledFor),
        startedAt: new Date(),
        workerId,
        signal: controller.signal,
        db: config.db,
        reportProgress: async (percent: number, msg?: string) => {
          await storage.setProgress(task.id, {
            percent: Math.max(0, Math.min(100, percent)),
            ...(msg !== undefined && { message: msg }),
            updatedAt: Date.now(),
          });
        },
      };

      const timeoutMs = definition.timeout ?? 30000;
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Task timeout")), timeoutMs)
      );

      const result = await Promise.race([
        definition.handler(ctx, payload.input),
        timeoutPromise,
      ]);

      if (idempotencyKey) {
        await idempotencyStore.markCompleted(
          idempotencyKey,
          { taskId: task.id, result, completedAt: Date.now() },
          retentionMs
        );
      }

      await storage.updateStatus(task.id, "running", "completed", {
        result,
        completedAt: Date.now(),
        resultExpiresAt: Date.now() + resultTtlMs,
      });

      message.ack();
    } catch (error) {
      const err = error as Error;
      if (shouldRetry(err, attemptNumber, maxAttempts, retryConfig)) {
        const backoff = calculateBackoff(attemptNumber, retryConfig);
        await storage.updateStatus(task.id, "running", "scheduled", {
          attempt: attemptNumber,
          lastError: err.message,
          workerId: undefined,
        });
        message.retry({ delaySeconds: Math.ceil(backoff / 1000) });
      } else {
        await dlq.add({ ...task, attempt: attemptNumber }, err.message);
        message.ack();
      }
    }
  };

  return {
    async process(
      batch: MessageBatchLike<QueueTaskMessage>
    ): Promise<void> {
      for (const message of batch.messages) {
        await runMessage(message);
      }
    },
  };
};
