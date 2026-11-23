import type { Context } from "hono";
import type { RateLimitStore } from "@/middleware/rateLimit";
import { InMemoryRateLimitStore } from "@/middleware/rateLimit";

export type ThrottleKey = string | { key: string; maxAttempts: number };

export interface LoginThrottleOptions {
  maxAttempts?: number;
  perIdentifier?: number | false;
  perIp?: number | false;
  keys?: (identifier: string, ip: string, c?: Context) => ThrottleKey[];
  windowMs?: number;
  store?: RateLimitStore;
}

export interface ThrottleCheck {
  locked: boolean;
  retryAfterSeconds: number;
}

const DEFAULTS = {
  maxAttempts: 5,
  windowMs: 15 * 60 * 1000,
};

const limit = (name: string, value: number): number => {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`LoginThrottle: ${name} must be a positive integer or false`);
  }
  return value;
};

interface LimitedKey {
  key: string;
  maxAttempts: number;
}

export class LoginThrottle {
  private store: RateLimitStore;
  private maxAttempts: number;
  private perIdentifier: number | false;
  private perIp: number | false;
  private customKeys?: LoginThrottleOptions["keys"];
  private windowMs: number;

  constructor(options: LoginThrottleOptions = {}) {
    this.store = options.store ?? new InMemoryRateLimitStore();
    this.maxAttempts = limit("maxAttempts", options.maxAttempts ?? DEFAULTS.maxAttempts);
    this.perIdentifier =
      options.perIdentifier === false ? false : limit("perIdentifier", options.perIdentifier ?? this.maxAttempts);
    this.perIp = options.perIp === false ? false : limit("perIp", options.perIp ?? this.maxAttempts);
    this.customKeys = options.keys;
    this.windowMs = options.windowMs ?? DEFAULTS.windowMs;
  }

  private keys(identifier: string, ip: string, c?: Context): LimitedKey[] {
    if (this.customKeys) {
      return this.customKeys(identifier, ip, c).map((entry) =>
        typeof entry === "string"
          ? { key: entry, maxAttempts: this.maxAttempts }
          : { key: entry.key, maxAttempts: limit("keys maxAttempts", entry.maxAttempts) }
      );
    }
    const keys: LimitedKey[] = [];
    if (this.perIdentifier !== false) {
      keys.push({ key: `login:id:${identifier.toLowerCase()}`, maxAttempts: this.perIdentifier });
    }
    if (this.perIp !== false) keys.push({ key: `login:ip:${ip}`, maxAttempts: this.perIp });
    return keys;
  }

  async recordFailure(identifier: string, ip: string, c?: Context): Promise<ThrottleCheck> {
    let locked = false;
    let retryAfterSeconds = 0;

    for (const { key, maxAttempts } of this.keys(identifier, ip, c)) {
      const info = await this.store.increment(key, this.windowMs);
      if (info.count >= maxAttempts) {
        locked = true;
        const remaining = Math.ceil((info.resetAt - Date.now()) / 1000);
        retryAfterSeconds = Math.max(retryAfterSeconds, remaining, 1);
      }
    }

    return { locked, retryAfterSeconds };
  }

  async check(identifier: string, ip: string, c?: Context): Promise<ThrottleCheck> {
    let locked = false;
    let retryAfterSeconds = 0;

    for (const { key, maxAttempts } of this.keys(identifier, ip, c)) {
      const info = await this.store.increment(key, this.windowMs);
      const count = info.count;
      const resetAt = info.resetAt;
      await this.store.decrement(key);
      if (count > maxAttempts) {
        locked = true;
        const remaining = Math.ceil((resetAt - Date.now()) / 1000);
        retryAfterSeconds = Math.max(retryAfterSeconds, remaining, 1);
      }
    }

    return { locked, retryAfterSeconds };
  }

  async reset(identifier: string, ip: string, c?: Context): Promise<void> {
    for (const { key } of this.keys(identifier, ip, c)) {
      await this.store.reset(key);
    }
  }
}
