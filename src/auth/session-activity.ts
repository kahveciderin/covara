import type { SessionData, SessionStore } from "./types";
import { createWorkTracker, isShuttingDown, trackBackgroundWork } from "@/server/lifecycle";

const ACTIVITY_THROTTLE_MS = 60_000;

export const createSessionActivityRecorder = (store: SessionStore) => {
  const pending = createWorkTracker();

  return {
    record(session: SessionData): void {
      if (isShuttingDown()) return;
      const now = Date.now();
      const last = typeof session.data?.lastActiveAt === "number" ? session.data.lastActiveAt : 0;
      const remaining = session.expiresAt.getTime() - now;
      if (now - last < ACTIVITY_THROTTLE_MS || remaining <= 0) return;

      session.data = { ...session.data, lastActiveAt: now };
      const write = store.set(session.id, session, remaining).catch(() => {});
      pending.track(write, session.id);
      trackBackgroundWork(write);
    },

    // The store upserts, so a write still in flight would recreate a session
    // deleted underneath it.
    settle: (sessionId?: string): Promise<void> => pending.settle(sessionId),
  };
};
