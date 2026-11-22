export type ShutdownHook = () => void | Promise<void>;

let shuttingDown = false;
const shutdownHooks: ShutdownHook[] = [];

const WORK_TIMEOUT_MS = 5000;

// On Workers, I/O left running when its request ends may never settle, so work
// is only waited on, and retained, for a bounded time.
export const createWorkTracker = () => {
  const active = new Map<Promise<unknown>, { key?: string; startedAt: number }>();

  return {
    track(work: Promise<unknown>, key?: string): void {
      const now = Date.now();
      for (const [pending, { startedAt }] of active) {
        if (now - startedAt > WORK_TIMEOUT_MS) active.delete(pending);
      }
      active.set(work, { key, startedAt: now });
      const done = () => active.delete(work);
      work.then(done, done);
    },

    async settle(key?: string): Promise<void> {
      const waiting = [...active]
        .filter(([, info]) => key === undefined || info.key === key)
        .map(([work]) => work);
      if (waiting.length === 0) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled(waiting),
        new Promise((resolve) => {
          timer = setTimeout(resolve, WORK_TIMEOUT_MS);
        }),
      ]);
      clearTimeout(timer);
      for (const work of waiting) active.delete(work);
    },

    clear: () => active.clear(),
  };
};

const backgroundWork = createWorkTracker();

export const trackBackgroundWork = (work: Promise<unknown>): void => backgroundWork.track(work);

export const isShuttingDown = (): boolean => shuttingDown;

export const onShutdown = (hook: ShutdownHook): void => {
  shutdownHooks.push(hook);
};

export const resetLifecycle = (): void => {
  shuttingDown = false;
  shutdownHooks.length = 0;
  backgroundWork.clear();
};

// Flip the readiness flag (so /readyz starts returning 503 and load balancers
// stop routing new traffic), then run every registered drain hook. Hooks close
// long-lived resources such as SSE subscriptions so connections aren't dropped
// mid-flight on a rolling deploy. Resolves once tracked background writes have
// settled, so the caller may close its database afterwards.
export const beginShutdown = async (): Promise<void> => {
  if (shuttingDown) return backgroundWork.settle();
  shuttingDown = true;

  for (const hook of shutdownHooks) {
    try {
      await hook();
    } catch {
      // a failing drain hook must not prevent the rest from running
    }
  }

  await backgroundWork.settle();
};
