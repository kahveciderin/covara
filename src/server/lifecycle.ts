export type ShutdownHook = () => void | Promise<void>;

let shuttingDown = false;
const shutdownHooks: ShutdownHook[] = [];

export const isShuttingDown = (): boolean => shuttingDown;

export const onShutdown = (hook: ShutdownHook): void => {
  shutdownHooks.push(hook);
};

export const resetLifecycle = (): void => {
  shuttingDown = false;
  shutdownHooks.length = 0;
};

// Flip the readiness flag (so /readyz starts returning 503 and load balancers
// stop routing new traffic), then run every registered drain hook. Hooks close
// long-lived resources such as SSE subscriptions so connections aren't dropped
// mid-flight on a rolling deploy.
export const beginShutdown = async (): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const hook of shutdownHooks) {
    try {
      await hook();
    } catch {
      // a failing drain hook must not prevent the rest from running
    }
  }
};
