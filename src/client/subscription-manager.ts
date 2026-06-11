import {
  SubscriptionEvent,
  SubscriptionState,
  SubscriptionCallbacks,
  Subscription,
  SubscribeOptions,
} from "./types";
import { Transport } from "./transport";

export interface SubscriptionManagerConfig<T> {
  transport: Transport;
  resourcePath: string;
  idField: keyof T;
  options?: SubscribeOptions;
  callbacks?: SubscriptionCallbacks<T>;
  rng?: () => number;
}

export const computeBackoffDelay = (
  attempt: number,
  base: number,
  cap: number,
  rng: () => number = Math.random
): number => {
  const exponential = base * Math.pow(2, attempt);
  const bounded = Math.min(cap, Number.isFinite(exponential) ? exponential : cap);
  const jittered = rng() * bounded;
  return Math.max(0, Math.min(cap, jittered));
};

export class SubscriptionManager<T extends { id: string }> implements Subscription<T> {
  private eventSource: EventSource | null = null;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private baseReconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private rng: () => number;
  private _state: SubscriptionState<T>;
  private config: SubscriptionManagerConfig<T>;
  private isUnsubscribed = false;

  constructor(config: SubscriptionManagerConfig<T>) {
    this.config = config;
    this.rng = config.rng ?? Math.random;
    this._state = {
      items: new Map(),
      isConnected: false,
      lastSeq: config.options?.resumeFrom ?? 0,
      error: null,
    };

    this.connect();
  }

  get state(): SubscriptionState<T> {
    return this._state;
  }

  get items(): T[] {
    return Array.from(this._state.items.values());
  }

  private connect(): void {
    if (this.isUnsubscribed) return;

    const params: Record<string, string> = {};

    if (this.config.options?.filter) {
      params.filter = this.config.options.filter;
    }

    if (this.config.options?.include) {
      params.include = this.config.options.include;
    }

    if (this._state.lastSeq > 0) {
      params.resumeFrom = String(this._state.lastSeq);
    }

    if (this.config.options?.skipExisting) {
      params.skipExisting = "true";
    }

    if (this.config.options?.knownIds && this.config.options.knownIds.length > 0) {
      params.knownIds = this.config.options.knownIds.join(",");
    }

    const path = `${this.config.resourcePath}/subscribe`;
    this.eventSource = this.config.transport.createEventSource(path, params);

    this.eventSource.addEventListener("connected", (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      this._state.isConnected = true;
      this._state.error = null;
      this.reconnectAttempts = 0;

      if (data.seq !== undefined) {
        this._state.lastSeq = data.seq;
      }

      this.config.callbacks?.onConnected?.(this._state.lastSeq);
    });

    this.eventSource.addEventListener("message", (e) => {
      try {
        const event = JSON.parse((e as MessageEvent).data) as SubscriptionEvent<T>;
        this.handleEvent(event);
      } catch (error) {
        console.error("Failed to parse subscription event:", error);
      }
    });

    this.eventSource.onerror = () => {
      this._state.isConnected = false;
      this.config.callbacks?.onDisconnected?.();

      if (!this.isUnsubscribed) {
        this.scheduleReconnect();
      }
    };
  }

  private handleEvent(event: SubscriptionEvent<T>): void {
    if (event.seq > this._state.lastSeq) {
      this._state.lastSeq = event.seq;
    }

    switch (event.type) {
      case "existing": {
        const item = event.object;
        const id = String(item[this.config.idField]);
        this._state.items.set(id, item);
        this.config.callbacks?.onExisting?.(item);
        break;
      }

      case "added": {
        const item = event.object;
        const id = String(item[this.config.idField]);
        this._state.items.set(id, item);
        this.config.callbacks?.onAdded?.(item, event.meta);
        break;
      }

      case "changed": {
        const item = event.object;
        const id = String(item[this.config.idField]);
        this._state.items.set(id, item);
        this.config.callbacks?.onChanged?.(item, event.previousObjectId);
        break;
      }

      case "removed": {
        this._state.items.delete(event.objectId);
        this.config.callbacks?.onRemoved?.(event.objectId);
        break;
      }

      case "invalidate": {
        this._state.items.clear();
        this._state.lastSeq = 0;
        this.config.callbacks?.onInvalidate?.(event.reason);
        this.reconnect();
        break;
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this._state.error = new Error("Max reconnect attempts exceeded");
      this.config.callbacks?.onError?.(this._state.error);
      return;
    }

    const delay = computeBackoffDelay(
      this.reconnectAttempts,
      this.baseReconnectDelay,
      this.maxReconnectDelay,
      this.rng
    );

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectAttempts++;
      this.connect();
    }, delay);
  }

  reconnect(): void {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    this.reconnectAttempts = 0;
    this.connect();
  }

  unsubscribe(): void {
    this.isUnsubscribed = true;

    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    this._state.isConnected = false;
    this._state.items.clear();
  }
}

export const createSubscription = <T extends { id: string }>(
  config: SubscriptionManagerConfig<T>
): Subscription<T> => {
  return new SubscriptionManager(config);
};
