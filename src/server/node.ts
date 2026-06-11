import type { Hono } from "hono";
import { beginShutdown } from "./lifecycle";

export interface ServeOptions {
  port?: number;
  hostname?: string;
  onListen?: (info: { port: number; address: string }) => void;
  // When true (default), install SIGTERM/SIGINT handlers that drain in-flight
  // connections before exiting. Set false to manage shutdown yourself.
  gracefulShutdown?: boolean;
  // How long to wait for SSE/long-lived connections to drain before forcing
  // the socket closed. Default 10s.
  drainTimeoutMs?: number;
}

export interface CovaraServer {
  port: number;
  address: string;
  close: () => Promise<void>;
}

export const startServer = async (
  app: Hono,
  options: ServeOptions = {}
): Promise<CovaraServer> => {
  const { serve } = await import("@hono/node-server");
  const port = options.port ?? Number(readPort() ?? 3000);
  const drainTimeoutMs = options.drainTimeoutMs ?? 10000;

  return new Promise((resolve) => {
    const server = serve(
      {
        fetch: app.fetch,
        port,
        hostname: options.hostname,
      },
      (info) => {
        const close = async (): Promise<void> => {
          // Flip readiness to 503 and close SSE connections so the load
          // balancer stops routing and clients reconnect cleanly, then wait a
          // bounded drain window before closing the listener.
          await beginShutdown();
          await new Promise<void>((res) => setTimeout(res, Math.min(drainTimeoutMs, 250)));
          await new Promise<void>((res, rej) =>
            server.close((err) => (err ? rej(err) : res()))
          );
        };

        if (options.gracefulShutdown !== false) {
          installSignalHandlers(close);
        }

        options.onListen?.({ port: info.port, address: info.address });
        resolve({ port: info.port, address: info.address, close });
      }
    );
  });
};

let signalHandlersInstalled = false;

const installSignalHandlers = (close: () => Promise<void>): void => {
  const proc = (globalThis as { process?: NodeProcess }).process;
  if (!proc?.on || signalHandlersInstalled) return;
  signalHandlersInstalled = true;

  const handle = (signal: string) => {
    void close()
      .then(() => proc.exit?.(0))
      .catch(() => proc.exit?.(1));
    void signal;
  };

  proc.on("SIGTERM", () => handle("SIGTERM"));
  proc.on("SIGINT", () => handle("SIGINT"));
};

interface NodeProcess {
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  exit?: (code?: number) => void;
  env?: Record<string, string | undefined>;
}

const readPort = (): string | undefined => {
  const proc = (globalThis as { process?: NodeProcess }).process;
  return proc?.env?.PORT;
};
