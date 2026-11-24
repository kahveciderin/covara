export interface AppSSELimits {
  /** Live subscriptions per signed-in user, per resource (default 10). */
  maxSubscriptionsPerUser?: number;
  /** Live subscriptions per client IP from anonymous clients, per resource (default 50). Signed-in requests don't count. */
  maxSubscriptionsPerIP?: number;
}

let appLimits: AppSSELimits = {};

const assertCap = (name: string, value: number | undefined): void => {
  if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
    throw new Error(`sse.${name} must be a positive integer, got ${value}`);
  }
};

export const setAppSSELimits = (limits: AppSSELimits = {}): void => {
  assertCap("maxSubscriptionsPerUser", limits.maxSubscriptionsPerUser);
  assertCap("maxSubscriptionsPerIP", limits.maxSubscriptionsPerIP);
  appLimits = { ...limits };
};

export const getAppSSELimits = (): AppSSELimits => appLimits;
