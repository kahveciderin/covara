import {
  AggregateOptions,
  AggregationResponse,
  AggregateSubscription,
  AggregateSubscriptionState,
  AggregateSubscriptionCallbacks,
} from "./types";
import { Transport } from "./transport";
import { computeBackoffDelay } from "./subscription-manager";

export type {
  AggregateSubscription,
  AggregateSubscriptionState,
  AggregateSubscriptionCallbacks,
};

export interface AggregateSubscriptionConfig {
  transport: Transport;
  resourcePath: string;
  options?: AggregateOptions;
  callbacks?: AggregateSubscriptionCallbacks;
  rng?: () => number;
}

export const buildAggregateParams = (
  options: AggregateOptions = {}
): Record<string, string> => {
  const params: Record<string, string> = {};
  if (options.filter) params.filter = options.filter;
  if (options.groupBy && options.groupBy.length > 0) params.groupBy = options.groupBy.join(",");
  if (options.count) params.count = "true";
  if (options.sum && options.sum.length > 0) params.sum = options.sum.join(",");
  if (options.avg && options.avg.length > 0) params.avg = options.avg.join(",");
  if (options.min && options.min.length > 0) params.min = options.min.join(",");
  if (options.max && options.max.length > 0) params.max = options.max.join(",");
  return params;
};

export class AggregateSubscriptionManager implements AggregateSubscription {
  private eventSource: EventSource | null = null;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  // Retry indefinitely with capped backoff rather than going stale (see
  // SubscriptionManager).
  private maxReconnectAttempts = Infinity;
  private baseReconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private rng: () => number;
  private _state: AggregateSubscriptionState;
  private config: AggregateSubscriptionConfig;
  private isUnsubscribed = false;

  constructor(config: AggregateSubscriptionConfig) {
    this.config = config;
    this.rng = config.rng ?? Math.random;
    this._state = {
      data: null,
      isConnected: false,
      error: null,
      lastSeq: 0,
    };
    this.connect();
  }

  get state(): AggregateSubscriptionState {
    return this._state;
  }

  private connect(): void {
    if (this.isUnsubscribed) return;

    const params = buildAggregateParams(this.config.options);
    const path = `${this.config.resourcePath}/aggregate/subscribe`;
    this.eventSource = this.config.transport.createEventSource(path, params);

    this.eventSource.addEventListener("connected", () => {
      this._state.isConnected = true;
      this._state.error = null;
      this.reconnectAttempts = 0;
      this.config.callbacks?.onConnectionChange?.(true);
    });

    this.eventSource.addEventListener("aggregate", (e) => {
      try {
        const payload = JSON.parse((e as MessageEvent).data) as {
          data: AggregationResponse;
          seq: number;
        };
        this._state.data = payload.data;
        if (typeof payload.seq === "number") this._state.lastSeq = payload.seq;
        this.config.callbacks?.onData?.(payload.data, payload.seq);
      } catch (err) {
        this._state.error = err instanceof Error ? err : new Error(String(err));
        this.config.callbacks?.onError?.(this._state.error);
      }
    });

    this.eventSource.addEventListener("error", (e) => {
      const data = (e as MessageEvent).data;
      if (data) {
        try {
          const parsed = JSON.parse(data);
          this._state.error = new Error(parsed.error ?? "Aggregate subscription error");
          this.config.callbacks?.onError?.(this._state.error);
        } catch {
          // non-JSON error event — handled by reconnect below
        }
      }
    });

    this.eventSource.onerror = () => {
      this._state.isConnected = false;
      this.config.callbacks?.onConnectionChange?.(false);
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.isUnsubscribed) return;
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);

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
      this.closeEventSource();
      this.connect();
    }, delay);
  }

  reconnect(): void {
    if (this.isUnsubscribed) return;
    this.closeEventSource();
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    this.reconnectAttempts = 0;
    this.connect();
  }

  private closeEventSource(): void {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }

  unsubscribe(): void {
    this.isUnsubscribed = true;
    this.closeEventSource();
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    this._state.isConnected = false;
  }
}

export const createAggregateSubscription = (
  config: AggregateSubscriptionConfig
): AggregateSubscription => new AggregateSubscriptionManager(config);
