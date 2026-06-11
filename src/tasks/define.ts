import { z } from "zod";
import { TaskDefinition, RetryConfig, DebounceConfig } from "./types";

export interface DefineTaskOptions<TInput, TOutput> {
  name: string;
  input?: z.ZodSchema<TInput>;
  output?: z.ZodSchema<TOutput>;
  handler: (
    ctx: { taskId: string; attempt: number; workerId: string; signal: AbortSignal; scheduledAt: Date; startedAt: Date },
    input: TInput
  ) => Promise<TOutput>;
  retry?: RetryConfig;
  timeout?: number;
  priority?: number;
  maxConcurrency?: number;
  debounce?: DebounceConfig;
  idempotencyKey?: (input: TInput) => string;
  idempotencyRetentionMs?: number;
  resultTtlMs?: number;
}

export const defineTask = <TInput = unknown, TOutput = unknown>(
  options: DefineTaskOptions<TInput, TOutput>
): TaskDefinition<TInput, TOutput> => {
  return {
    name: options.name,
    input: options.input,
    output: options.output,
    handler: options.handler,
    retry: options.retry,
    timeout: options.timeout,
    priority: options.priority,
    maxConcurrency: options.maxConcurrency,
    debounce: options.debounce,
    idempotencyKey: options.idempotencyKey,
    idempotencyRetentionMs: options.idempotencyRetentionMs,
    resultTtlMs: options.resultTtlMs,
  };
};
