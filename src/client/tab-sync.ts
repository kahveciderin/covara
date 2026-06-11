export type TabSyncMessage =
  | { kind: "mutation"; resource: string; mutationType: "create" | "update" | "delete"; objectId?: string; optimisticId?: string; data?: unknown }
  | { kind: "id-remapped"; optimisticId: string; serverId: string }
  | { kind: "invalidate"; paths: string[] }
  | { kind: "sync-complete" };

export interface TabSync {
  readonly id: string;
  post: (message: TabSyncMessage) => void;
  subscribe: (listener: (message: TabSyncMessage) => void) => () => void;
  /** Try to become the queue-flushing leader. Returns true if this tab holds the lock. */
  acquireLeadership: () => boolean;
  releaseLeadership: () => void;
  isLeader: () => boolean;
  close: () => void;
}

interface BroadcastChannelLike {
  postMessage(message: unknown): void;
  close(): void;
  addEventListener(type: "message", listener: (e: { data: unknown }) => void): void;
  removeEventListener(type: "message", listener: (e: { data: unknown }) => void): void;
}

const hasBroadcastChannel = (): boolean =>
  typeof globalThis !== "undefined" &&
  typeof (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel === "function";

const LEADER_TTL_MS = 4000;

class BroadcastChannelTabSync implements TabSync {
  readonly id = `tab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  private channel: BroadcastChannelLike;
  private listeners = new Set<(message: TabSyncMessage) => void>();
  private lockKey: string;
  private leaderHeartbeat?: ReturnType<typeof setInterval>;
  private leader = false;

  constructor(channelName: string) {
    const Ctor = (globalThis as unknown as {
      BroadcastChannel: new (name: string) => BroadcastChannelLike;
    }).BroadcastChannel;
    this.channel = new Ctor(channelName);
    this.lockKey = `${channelName}::leader`;
    this.channel.addEventListener("message", this.onMessage);
  }

  private onMessage = (e: { data: unknown }) => {
    const message = e.data as TabSyncMessage;
    for (const listener of this.listeners) listener(message);
  };

  post(message: TabSyncMessage): void {
    this.channel.postMessage(message);
  }

  subscribe(listener: (message: TabSyncMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private readLock(): { id: string; ts: number } | null {
    if (typeof localStorage === "undefined") return null;
    try {
      const raw = localStorage.getItem(this.lockKey);
      return raw ? (JSON.parse(raw) as { id: string; ts: number }) : null;
    } catch {
      return null;
    }
  }

  private writeLock(): void {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(this.lockKey, JSON.stringify({ id: this.id, ts: Date.now() }));
    } catch {
      // ignore quota/availability errors
    }
  }

  acquireLeadership(): boolean {
    // No localStorage: every tab acts as leader (best effort, no coordination possible).
    if (typeof localStorage === "undefined") {
      this.leader = true;
      return true;
    }
    const current = this.readLock();
    const expired = !current || Date.now() - current.ts > LEADER_TTL_MS;
    if (current && current.id === this.id) {
      this.writeLock();
      this.startHeartbeat();
      this.leader = true;
      return true;
    }
    if (expired) {
      this.writeLock();
      this.startHeartbeat();
      this.leader = true;
      return true;
    }
    this.leader = false;
    return false;
  }

  private startHeartbeat(): void {
    if (this.leaderHeartbeat) return;
    this.leaderHeartbeat = setInterval(() => {
      const current = this.readLock();
      if (current && current.id !== this.id && Date.now() - current.ts <= LEADER_TTL_MS) {
        this.releaseLeadership();
        return;
      }
      this.writeLock();
    }, LEADER_TTL_MS / 2);
  }

  releaseLeadership(): void {
    this.leader = false;
    if (this.leaderHeartbeat) {
      clearInterval(this.leaderHeartbeat);
      this.leaderHeartbeat = undefined;
    }
    const current = this.readLock();
    if (current && current.id === this.id && typeof localStorage !== "undefined") {
      try {
        localStorage.removeItem(this.lockKey);
      } catch {
        // ignore
      }
    }
  }

  isLeader(): boolean {
    return this.leader;
  }

  close(): void {
    this.releaseLeadership();
    this.channel.removeEventListener("message", this.onMessage);
    this.channel.close();
    this.listeners.clear();
  }
}

const noopTabSync: TabSync = {
  id: "noop",
  post: () => {},
  subscribe: () => () => {},
  acquireLeadership: () => true,
  releaseLeadership: () => {},
  isLeader: () => true,
  close: () => {},
};

/**
 * Create a cross-tab coordination channel. Returns a no-op implementation in
 * environments without BroadcastChannel (React Native, Node), so callers never
 * need to feature-detect themselves.
 */
export const createTabSync = (channelName = "concave-tab-sync"): TabSync => {
  if (!hasBroadcastChannel()) {
    return noopTabSync;
  }
  return new BroadcastChannelTabSync(channelName);
};

export const isTabSyncSupported = hasBroadcastChannel;
