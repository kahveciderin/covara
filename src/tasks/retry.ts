import { RetryConfig } from "./types";

export const calculateBackoff = (
  attempt: number,
  config: RetryConfig
): number => {
  const initial = config.initialDelayMs ?? 1000;
  const max = config.maxDelayMs ?? 60000;

  let delay: number;

  switch (config.backoff ?? "exponential") {
    case "exponential":
      delay = Math.min(initial * Math.pow(2, attempt - 1), max);
      break;
    case "linear":
      delay = Math.min(initial * attempt, max);
      break;
    case "fixed":
      delay = initial;
      break;
    default:
      delay = initial;
  }

  const jitter = delay * (0.1 + Math.random() * 0.1);
  return Math.floor(delay + jitter);
};

export const shouldRetry = (
  error: Error,
  attempt: number,
  maxAttempts: number,
  config?: RetryConfig
): boolean => {
  if (attempt >= maxAttempts) return false;
  if (config?.retryOn) {
    return config.retryOn(error);
  }
  return true;
};

export const resolveRetryDelay = (
  error: Error,
  attempt: number,
  config: RetryConfig
): number => {
  const override = config.retryDelayMs?.(error, attempt);
  if (override !== undefined && Number.isFinite(override) && override >= 0) {
    return Math.floor(override);
  }
  return calculateBackoff(attempt, config);
};
