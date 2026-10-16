export interface EmailDeliveryErrorOptions {
  provider: string;
  status?: number;
  retryAfterMs?: number;
  permanent?: boolean;
  code?: string;
  cause?: unknown;
}

export class EmailDeliveryError extends Error {
  readonly provider: string;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly permanent: boolean;
  readonly code?: string;

  constructor(message: string, options: EmailDeliveryErrorOptions) {
    super(message);
    this.name = "EmailDeliveryError";
    this.provider = options.provider;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    this.permanent = options.permanent ?? false;
    this.code = options.code;
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

const TRANSIENT_4XX = new Set([408, 409, 425, 429]);

export const isPermanentStatus = (status: number): boolean =>
  status >= 400 && status < 500 && !TRANSIENT_4XX.has(status);

export const parseRetryAfter = (
  value: string | null | undefined,
  now: number = Date.now()
): number | undefined => {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return Math.max(0, Math.ceil(parseFloat(trimmed) * 1000));
  }
  if (!/[a-z]/i.test(trimmed)) return undefined;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
};

export const isPermanentEmailError = (error: unknown): boolean =>
  error instanceof EmailDeliveryError && error.permanent;

export const isRetryableEmailError = (error: unknown): boolean =>
  !isPermanentEmailError(error);

export const emailRetryAfterMs = (error: unknown): number | undefined =>
  error instanceof EmailDeliveryError ? error.retryAfterMs : undefined;
