import { getGlobalKV, hasGlobalKV, type KVAdapter } from "@/kv/types";
import type { ScheduleOptions, TaskContext, TaskDefinition } from "@/tasks/types";
import { calculateBackoff } from "@/tasks/retry";
import {
  EmailDeliveryError,
  emailRetryAfterMs,
  isPermanentEmailError,
  isRetryableEmailError,
} from "./errors";
import type {
  EmailAdapter,
  EmailAttachment,
  EmailMessage,
  SendEmailOptions,
  SendEmailResult,
} from "./types";

export const DEFAULT_EMAIL_TASK_NAME = "covara.email.send";
export const DEFAULT_EMAIL_MAX_PAYLOAD_BYTES = 120_000;

const SENT_MARKER_PREFIX = "covara:email:sent:";
const DEFAULT_DEDUPE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface EmailTaskQueue {
  enqueue<TInput>(
    task: TaskDefinition<TInput>,
    input: TInput,
    options?: ScheduleOptions
  ): Promise<string>;
}

export interface DurableEmailRetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  maxRetryAfterMs?: number;
}

export interface InlineEmailRetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  maxRetryAfterMs?: number;
}

export interface EmailDeliveryFailure {
  messageId: string;
  idempotencyKey: string;
  provider: string;
  message: EmailMessage;
  error: Error;
  attempts: number;
  permanent: boolean;
  mode: "queued" | "inline";
  taskId?: string;
}

export interface DurableEmailOptions {
  queue?: EmailTaskQueue;
  kv?: KVAdapter | null;
  taskName?: string;
  priority?: number;
  timeoutMs?: number;
  retry?: DurableEmailRetryOptions;
  inline?: InlineEmailRetryOptions;
  maxPayloadBytes?: number;
  dedupeTtlMs?: number;
  onDeliveryFailed?: (failure: EmailDeliveryFailure) => void | Promise<void>;
  logger?: { warn(message: string): void };
}

type SerializedAttachment = Omit<EmailAttachment, "content"> & {
  content: string;
  encoding?: "bytes";
};

export type SerializedEmailMessage = Omit<EmailMessage, "attachments"> & {
  attachments?: SerializedAttachment[];
};

export interface EmailTaskInput {
  messageId: string;
  idempotencyKey: string;
  provider: string;
  message: SerializedEmailMessage | EmailMessage;
  enqueuedAt: number;
}

export interface DurableEmailAdapter extends EmailAdapter {
  readonly durable: boolean;
  readonly inner: EmailAdapter;
  readonly task: TaskDefinition<EmailTaskInput, SendEmailResult>;
}

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
};

const base64ToBytes = (value: string): Uint8Array => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

export const serializeEmailMessage = (message: EmailMessage): SerializedEmailMessage => {
  const { attachments, ...rest } = message;
  if (!attachments) return rest;
  return {
    ...rest,
    attachments: attachments.map((attachment) =>
      typeof attachment.content === "string"
        ? { ...attachment, content: attachment.content }
        : { ...attachment, content: bytesToBase64(attachment.content), encoding: "bytes" as const }
    ),
  };
};

export const deserializeEmailMessage = (
  message: SerializedEmailMessage | EmailMessage
): EmailMessage => {
  const { attachments, ...rest } = message;
  if (!attachments) return rest;
  return {
    ...rest,
    attachments: attachments.map((attachment) => {
      const { encoding, ...fields } = attachment as SerializedAttachment;
      if (encoding === "bytes" && typeof fields.content === "string") {
        return { ...fields, content: base64ToBytes(fields.content) };
      }
      return fields as EmailAttachment;
    }),
  };
};

const toError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const byteLength = (value: string): number => new TextEncoder().encode(value).length;

export const createDurableEmailAdapter = (
  inner: EmailAdapter,
  options: DurableEmailOptions = {}
): DurableEmailAdapter => {
  const queue = options.queue;
  const taskName = options.taskName ?? DEFAULT_EMAIL_TASK_NAME;
  const maxAttempts = Math.max(1, options.retry?.maxAttempts ?? 6);
  const maxRetryAfterMs = options.retry?.maxRetryAfterMs ?? 60 * 60 * 1000;
  const maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_EMAIL_MAX_PAYLOAD_BYTES;
  const dedupeTtlMs = options.dedupeTtlMs ?? DEFAULT_DEDUPE_TTL_MS;
  const inline = {
    maxAttempts: Math.max(1, options.inline?.maxAttempts ?? 3),
    initialDelayMs: options.inline?.initialDelayMs ?? 250,
    maxDelayMs: options.inline?.maxDelayMs ?? 2000,
    maxRetryAfterMs: options.inline?.maxRetryAfterMs ?? 5000,
  };
  const logger = options.logger ?? console;
  let warned = false;

  const resolveKv = (): KVAdapter | null => {
    if (options.kv !== undefined) return options.kv;
    return hasGlobalKV() ? getGlobalKV() : null;
  };

  const reportFailure = async (failure: EmailDeliveryFailure): Promise<void> => {
    if (!options.onDeliveryFailed) return;
    try {
      await options.onDeliveryFailed(failure);
    } catch {
      return;
    }
  };

  const deliverOnce = async (input: EmailTaskInput): Promise<SendEmailResult> => {
    const kv = resolveKv();
    const markerKey = `${SENT_MARKER_PREFIX}${input.idempotencyKey}`;
    if (kv) {
      const existing = await kv.get(markerKey);
      if (existing) return JSON.parse(existing) as SendEmailResult;
    }

    const sent = await inner.send(deserializeEmailMessage(input.message), {
      idempotencyKey: input.idempotencyKey,
    });
    const result: SendEmailResult = {
      ...(sent.id !== undefined && { id: sent.id }),
      provider: sent.provider,
      status: "sent",
    };

    if (kv) {
      // A marker write failure must not fail the task: the provider already
      // accepted the message, and failing here would trigger a re-send.
      try {
        await kv.set(markerKey, JSON.stringify(result), {
          ex: Math.max(1, Math.ceil(dedupeTtlMs / 1000)),
        });
      } catch {
        return result;
      }
    }
    return result;
  };

  const task: TaskDefinition<EmailTaskInput, SendEmailResult> = {
    name: taskName,
    priority: options.priority,
    timeout: options.timeoutMs ?? 30_000,
    idempotencyKey: (input) => `covara:email:${input.idempotencyKey}`,
    retry: {
      maxAttempts,
      backoff: "exponential",
      initialDelayMs: options.retry?.initialDelayMs ?? 10_000,
      maxDelayMs: options.retry?.maxDelayMs ?? 15 * 60 * 1000,
      retryOn: (error) => isRetryableEmailError(error),
      retryDelayMs: (error) => {
        const retryAfter = emailRetryAfterMs(error);
        return retryAfter === undefined ? undefined : Math.min(retryAfter, maxRetryAfterMs);
      },
    },
    handler: async (ctx: TaskContext, input: EmailTaskInput) => {
      try {
        return await deliverOnce(input);
      } catch (thrown) {
        const error = toError(thrown);
        const permanent = isPermanentEmailError(error);
        if (permanent || ctx.attempt >= maxAttempts) {
          await reportFailure({
            messageId: input.messageId,
            idempotencyKey: input.idempotencyKey,
            provider: input.provider,
            message: deserializeEmailMessage(input.message),
            error,
            attempts: ctx.attempt,
            permanent,
            mode: "queued",
            taskId: ctx.taskId,
          });
        }
        throw error;
      }
    },
  };

  const buildInput = (message: EmailMessage, sendOptions?: SendEmailOptions): EmailTaskInput => {
    const messageId = sendOptions?.idempotencyKey ?? crypto.randomUUID();
    return {
      messageId,
      idempotencyKey: messageId,
      provider: inner.provider,
      message: serializeEmailMessage(message),
      enqueuedAt: Date.now(),
    };
  };

  const enqueue = async (input: EmailTaskInput): Promise<SendEmailResult> => {
    const size = byteLength(JSON.stringify(input));
    if (size > maxPayloadBytes) {
      throw new EmailDeliveryError(
        `email: queued payload is ${size} bytes, over the ${maxPayloadBytes}-byte limit; ` +
          "send large attachments by link instead",
        { provider: inner.provider, permanent: true, code: "payload_too_large" }
      );
    }
    const taskId = await queue!.enqueue(task, input);
    return { id: input.messageId, provider: inner.provider, status: "queued", taskId };
  };

  const sendInline = async (input: EmailTaskInput): Promise<SendEmailResult> => {
    if (!warned) {
      warned = true;
      logger.warn(
        `[covara] durable email (${inner.provider}): no task queue configured, so emails are ` +
          `sent inline with up to ${inline.maxAttempts} attempts and delivery is NOT durable. ` +
          "Pass { queue } to enqueue sends into the task system."
      );
    }

    let attempt = 0;
    let lastError: Error = new Error("email: send was not attempted");
    while (attempt < inline.maxAttempts) {
      attempt++;
      try {
        return await deliverOnce(input);
      } catch (thrown) {
        lastError = toError(thrown);
        if (isPermanentEmailError(lastError) || attempt >= inline.maxAttempts) break;
        const retryAfter = emailRetryAfterMs(lastError);
        if (retryAfter !== undefined && retryAfter > inline.maxRetryAfterMs) break;
        await sleep(retryAfter ?? calculateBackoff(attempt, inline));
      }
    }

    await reportFailure({
      messageId: input.messageId,
      idempotencyKey: input.idempotencyKey,
      provider: input.provider,
      message: deserializeEmailMessage(input.message),
      error: lastError,
      attempts: attempt,
      permanent: isPermanentEmailError(lastError),
      mode: "inline",
    });
    throw lastError;
  };

  const send = (message: EmailMessage, sendOptions?: SendEmailOptions) => {
    const input = buildInput(message, sendOptions);
    return queue ? enqueue(input) : sendInline(input);
  };

  return {
    provider: inner.provider,
    durable: queue !== undefined,
    inner,
    task,
    send,
    sendBatch: (messages, batchOptions) =>
      Promise.all(
        messages.map((message, index) =>
          send(
            message,
            batchOptions?.idempotencyKey
              ? { idempotencyKey: `${batchOptions.idempotencyKey}:${index}` }
              : undefined
          )
        )
      ),
  };
};

export const durableEmail = createDurableEmailAdapter;
