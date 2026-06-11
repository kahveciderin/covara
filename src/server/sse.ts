export interface SSEWriter {
  write(chunk: string): boolean;
  close(): void;
  readonly closed: boolean;
  readonly bufferedBytes: number;
  readonly backpressured: boolean;
  onClose(callback: () => void): void;
}

export interface SSEStreamOptions {
  signal?: AbortSignal;
  maxQueueBytes?: number;
  headers?: Record<string, string>;
}

export interface SSEMessage {
  id?: string | number;
  event?: string;
  data: string;
  retry?: number;
}

export const formatSSE = (message: SSEMessage): string => {
  let frame = "";
  if (message.id !== undefined) frame += `id: ${message.id}\n`;
  if (message.event) frame += `event: ${message.event}\n`;
  if (message.retry !== undefined) frame += `retry: ${message.retry}\n`;
  for (const line of message.data.split("\n")) {
    frame += `data: ${line}\n`;
  }
  return frame + "\n";
};

export const formatSSEComment = (comment: string): string => `: ${comment}\n\n`;

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
  "X-Content-Type-Options": "nosniff",
} as const;

export const createSSEStream = (
  options: SSEStreamOptions = {}
): { writer: SSEWriter; response: Response } => {
  const encoder = new TextEncoder();
  const maxQueueBytes = options.maxQueueBytes ?? 65536;
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let closed = false;
  const closeCallbacks: (() => void)[] = [];

  const notifyClose = () => {
    if (closed) return;
    closed = true;
    for (const callback of closeCallbacks) {
      try {
        callback();
      } catch {
        // close callbacks must never break stream teardown
      }
    }
  };

  const stream = new ReadableStream<Uint8Array>(
    {
      start(c) {
        controller = c;
      },
      cancel() {
        notifyClose();
      },
    },
    {
      highWaterMark: maxQueueBytes,
      size: (chunk) => chunk.byteLength,
    }
  );

  options.signal?.addEventListener("abort", () => {
    if (!closed) {
      try {
        controller?.close();
      } catch {
        // already closed by the consumer
      }
      notifyClose();
    }
  });

  const writer: SSEWriter = {
    write(chunk: string): boolean {
      if (closed || !controller) return false;
      try {
        controller.enqueue(encoder.encode(chunk));
      } catch {
        notifyClose();
        return false;
      }
      return (controller.desiredSize ?? 1) > 0;
    },
    close(): void {
      if (!closed) {
        try {
          controller?.close();
        } catch {
          // already closed by the consumer
        }
        notifyClose();
      }
    },
    get closed() {
      return closed;
    },
    get bufferedBytes() {
      if (!controller || closed) return 0;
      return Math.max(0, maxQueueBytes - (controller.desiredSize ?? maxQueueBytes));
    },
    get backpressured() {
      if (!controller || closed) return false;
      return (controller.desiredSize ?? 1) <= 0;
    },
    onClose(callback: () => void): void {
      if (closed) {
        callback();
      } else {
        closeCallbacks.push(callback);
      }
    },
  };

  const response = new Response(stream, {
    status: 200,
    headers: { ...SSE_HEADERS, ...options.headers },
  });

  return { writer, response };
};
