import type { RateLimitStore } from "@/middleware/rateLimit";
import { InMemoryRateLimitStore } from "@/middleware/rateLimit";

export interface LoginThrottleOptions {
  maxAttempts?: number;
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

export class LoginThrottle {
  private store: RateLimitStore;
  private maxAttempts: number;
  private windowMs: number;

  constructor(options: LoginThrottleOptions = {}) {
    this.store = options.store ?? new InMemoryRateLimitStore();
    this.maxAttempts = options.maxAttempts ?? DEFAULTS.maxAttempts;
    this.windowMs = options.windowMs ?? DEFAULTS.windowMs;
  }

  private keys(identifier: string, ip: string): string[] {
    return [`login:id:${identifier.toLowerCase()}`, `login:ip:${ip}`];
  }

  async recordFailure(identifier: string, ip: string): Promise<ThrottleCheck> {
    let locked = false;
    let retryAfterSeconds = 0;

    for (const key of this.keys(identifier, ip)) {
      const info = await this.store.increment(key, this.windowMs);
      if (info.count >= this.maxAttempts) {
        locked = true;
        const remaining = Math.ceil((info.resetAt - Date.now()) / 1000);
        retryAfterSeconds = Math.max(retryAfterSeconds, remaining, 1);
      }
    }

    return { locked, retryAfterSeconds };
  }

  async check(identifier: string, ip: string): Promise<ThrottleCheck> {
    let locked = false;
    let retryAfterSeconds = 0;

    for (const key of this.keys(identifier, ip)) {
      const info = await this.store.increment(key, this.windowMs);
      const count = info.count;
      const resetAt = info.resetAt;
      await this.store.decrement(key);
      if (count > this.maxAttempts) {
        locked = true;
        const remaining = Math.ceil((resetAt - Date.now()) / 1000);
        retryAfterSeconds = Math.max(retryAfterSeconds, remaining, 1);
      }
    }

    return { locked, retryAfterSeconds };
  }

  async reset(identifier: string, ip: string): Promise<void> {
    for (const key of this.keys(identifier, ip)) {
      await this.store.reset(key);
    }
  }
}
