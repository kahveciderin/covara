import { ZodError } from "zod";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { isDebugEnabled, isProduction } from "@/server/env";

const ERROR_TYPE_BASE = "/__covara/problems";

export const ERROR_TYPES = {
  NOT_FOUND: `${ERROR_TYPE_BASE}/not-found`,
  VALIDATION_ERROR: `${ERROR_TYPE_BASE}/validation-error`,
  RATE_LIMIT_EXCEEDED: `${ERROR_TYPE_BASE}/rate-limit-exceeded`,
  PROOF_OF_WORK_REQUIRED: `${ERROR_TYPE_BASE}/proof-of-work-required`,
  CAPTCHA_REQUIRED: `${ERROR_TYPE_BASE}/captcha-required`,
  FILTER_PARSE_ERROR: `${ERROR_TYPE_BASE}/filter-parse-error`,
  UNAUTHORIZED: `${ERROR_TYPE_BASE}/unauthorized`,
  FORBIDDEN: `${ERROR_TYPE_BASE}/forbidden`,
  CONFLICT: `${ERROR_TYPE_BASE}/conflict`,
  PRECONDITION_FAILED: `${ERROR_TYPE_BASE}/precondition-failed`,
  BATCH_LIMIT_EXCEEDED: `${ERROR_TYPE_BASE}/batch-limit-exceeded`,
  CURSOR_INVALID: `${ERROR_TYPE_BASE}/cursor-invalid`,
  CURSOR_EXPIRED: `${ERROR_TYPE_BASE}/cursor-expired`,
  IDEMPOTENCY_MISMATCH: `${ERROR_TYPE_BASE}/idempotency-mismatch`,
  SEARCH_NOT_CONFIGURED: `${ERROR_TYPE_BASE}/search-not-configured`,
  SEARCH_FAILED: `${ERROR_TYPE_BASE}/search-failed`,
  INTERNAL_ERROR: `${ERROR_TYPE_BASE}/internal-error`,
  UNKNOWN_ERROR: `${ERROR_TYPE_BASE}/unknown-error`,
} as const;

export interface FieldError {
  field: string;
  message: string;
}

export interface ProblemDetail {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  code?: string;
  errors?: FieldError[];
  requestId?: string;
  retryAfter?: number;
  debug?: {
    sql?: string;
    scope?: string;
    ast?: unknown;
    stack?: string;
  };
  [key: string]: unknown;
}

export class ResourceError extends HTTPException {
  constructor(
    message: string,
    public statusCode: number,
    public code: string,
    public details?: unknown
  ) {
    super(statusCode as ContentfulStatusCode, { message });
    this.name = "ResourceError";
  }

  getType(): string {
    return ERROR_TYPES[this.code as keyof typeof ERROR_TYPES] ?? ERROR_TYPES.UNKNOWN_ERROR;
  }

  getTitle(): string {
    return this.code.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
  }

  override getResponse(): Response {
    const problem = formatRFC7807Error(this);
    const headers: Record<string, string> = {
      "Content-Type": "application/problem+json",
    };
    if (this instanceof RateLimitError) {
      headers["Retry-After"] = String(Math.ceil(this.retryAfter / 1000));
    }
    if (this instanceof PowRequiredError) {
      headers["Covara-Challenge-Type"] = "pow";
      headers["Covara-PoW-Challenge"] = this.challenge;
      headers["Covara-PoW-Difficulty"] = String(this.difficulty);
      headers["Covara-PoW-Algorithm"] = this.algorithm;
    }
    if (this instanceof CaptchaRequiredError) {
      headers["Covara-Challenge-Type"] = "captcha";
      headers["Covara-Captcha-Provider"] = this.provider;
      if (this.siteKey) headers["Covara-Captcha-Sitekey"] = this.siteKey;
      if (this.action) headers["Covara-Captcha-Action"] = this.action;
    }
    return new Response(JSON.stringify(problem), {
      status: this.statusCode,
      headers,
    });
  }
}

export class NotFoundError extends ResourceError {
  constructor(resource: string, id: string) {
    super(`${resource} with id '${id}' not found`, 404, "NOT_FOUND", {
      resource,
      id,
    });
    this.name = "NotFoundError";
  }
}

export class ValidationError extends ResourceError {
  constructor(message: string, details?: unknown) {
    super(message, 400, "VALIDATION_ERROR", details);
    this.name = "ValidationError";
  }
}

export class RateLimitError extends ResourceError {
  public retryAfter: number;

  constructor(retryAfter: number, message = "Rate limit exceeded") {
    super(message, 429, "RATE_LIMIT_EXCEEDED", { retryAfter });
    this.retryAfter = retryAfter;
    this.name = "RateLimitError";
  }
}

export class PowRequiredError extends ResourceError {
  constructor(
    public challenge: string,
    public difficulty: number,
    public algorithm: string = "sha256",
    message = "Proof of work required"
  ) {
    super(message, 428, "PROOF_OF_WORK_REQUIRED", { difficulty, algorithm });
    this.name = "PowRequiredError";
  }
}

export class CaptchaRequiredError extends ResourceError {
  constructor(
    public provider: string,
    public siteKey?: string,
    public action?: string,
    message = "CAPTCHA required"
  ) {
    super(message, 428, "CAPTCHA_REQUIRED", { provider, siteKey, action });
    this.name = "CaptchaRequiredError";
  }
}

export class UnauthorizedError extends ResourceError {
  constructor(message = "Unauthorized") {
    super(message, 401, "UNAUTHORIZED");
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends ResourceError {
  constructor(message = "Forbidden") {
    super(message, 403, "FORBIDDEN");
    this.name = "ForbiddenError";
  }
}

export class ConflictError extends ResourceError {
  constructor(message: string, details?: unknown) {
    super(message, 409, "CONFLICT", details);
    this.name = "ConflictError";
  }
}

export class PreconditionFailedError extends ResourceError {
  constructor(currentETag?: string, message = "Resource was modified") {
    super(message, 412, "PRECONDITION_FAILED", {
      currentETag,
      suggestion: "Refetch the resource and retry with the new ETag",
    });
    this.name = "PreconditionFailedError";
  }
}

export class BatchLimitError extends ResourceError {
  constructor(operation: string, limit: number, requested: number) {
    super(
      `Batch ${operation} limit exceeded. Max ${limit} items allowed, got ${requested}.`,
      400,
      "BATCH_LIMIT_EXCEEDED",
      { operation, limit, requested }
    );
    this.name = "BatchLimitError";
  }
}

export class FilterParseError extends ResourceError {
  constructor(
    message: string,
    context?: {
      position?: number;
      suggestion?: string;
      allowedOperators?: string[];
      allowedFields?: string[];
      parsedSoFar?: string;
    }
  ) {
    super(`Invalid filter expression: ${message}`, 400, "FILTER_PARSE_ERROR", {
      ...context,
      ...(!isDebugEnabled() && context?.parsedSoFar
        ? { parsedSoFar: undefined }
        : {}),
    });
    this.name = "FilterParseError";
  }
}

export class CursorInvalidError extends ResourceError {
  constructor(
    reason: "version_mismatch" | "orderby_mismatch" | "malformed" | "tampered",
    details?: unknown
  ) {
    const messages: Record<typeof reason, string> = {
      version_mismatch: "Cursor version does not match current API version",
      orderby_mismatch: "Cursor orderBy does not match request orderBy",
      malformed: "Cursor format is invalid",
      tampered: "Cursor signature is invalid",
    };
    super(messages[reason], 400, "CURSOR_INVALID", { reason, ...details as object });
    this.name = "CursorInvalidError";
  }
}

export class CursorExpiredError extends ResourceError {
  constructor(details?: unknown) {
    super("Cursor has expired", 400, "CURSOR_EXPIRED", details);
    this.name = "CursorExpiredError";
  }
}

export class IdempotencyMismatchError extends ResourceError {
  constructor(message = "Idempotency key was already used with different request parameters") {
    super(message, 409, "IDEMPOTENCY_MISMATCH", {
      suggestion: "Use a new idempotency key for different requests",
    });
    this.name = "IdempotencyMismatchError";
  }
}

export class SearchNotConfiguredError extends ResourceError {
  constructor(message = "Search is not configured") {
    super(message, 501, "SEARCH_NOT_CONFIGURED", {
      suggestion: "Configure a search adapter using setGlobalSearch()",
    });
    this.name = "SearchNotConfiguredError";
  }
}

export class SearchError extends ResourceError {
  constructor(message: string, details?: unknown) {
    super(message, 500, "SEARCH_FAILED", details);
    this.name = "SearchError";
  }
}

export const formatZodError = (error: ZodError): FieldError[] => {
  return error.issues.map((issue) => ({
    field: issue.path.join("."),
    message: issue.message,
  }));
};

export const formatRFC7807Error = (
  error: unknown,
  requestId?: string
): ProblemDetail => {
  const isDebug = isDebugEnabled();
  const isProd = isProduction();

  if (error instanceof ResourceError) {
    const problem: ProblemDetail = {
      type: error.getType(),
      title: error.getTitle(),
      status: error.statusCode,
      detail: error.message,
      code: error.code,
    };

    if (requestId) {
      problem.instance = `/requests/${requestId}`;
      problem.requestId = requestId;
    }

    if (error instanceof RateLimitError) {
      problem.retryAfter = error.retryAfter;
    }

    if (error.details && typeof error.details === "object") {
      const details = error.details as Record<string, unknown>;
      if (details.errors) {
        problem.errors = details.errors as FieldError[];
      }
      Object.keys(details).forEach((key) => {
        if (key !== "errors" && !problem[key]) {
          problem[key] = details[key];
        }
      });
    }

    if (isDebug && error.stack) {
      problem.debug = { ...problem.debug, stack: error.stack };
    }

    return problem;
  }

  if (error instanceof ZodError) {
    const problem: ProblemDetail = {
      type: ERROR_TYPES.VALIDATION_ERROR,
      title: "Validation error",
      status: 400,
      detail: "Request validation failed",
      code: "VALIDATION_ERROR",
      errors: formatZodError(error),
    };

    if (requestId) {
      problem.instance = `/requests/${requestId}`;
      problem.requestId = requestId;
    }

    return problem;
  }

  if (error instanceof Error) {
    const problem: ProblemDetail = {
      type: ERROR_TYPES.INTERNAL_ERROR,
      title: "Internal error",
      status: 500,
      detail: isProd ? "An internal server error occurred" : error.message,
      code: "INTERNAL_ERROR",
    };

    if (requestId) {
      problem.instance = `/requests/${requestId}`;
      problem.requestId = requestId;
    }

    if (isDebug && error.stack) {
      problem.debug = { stack: error.stack };
    }

    return problem;
  }

  const problem: ProblemDetail = {
    type: ERROR_TYPES.UNKNOWN_ERROR,
    title: "Unknown error",
    status: 500,
    detail: "An unknown error occurred",
    code: "UNKNOWN_ERROR",
  };

  if (requestId) {
    problem.instance = `/requests/${requestId}`;
    problem.requestId = requestId;
  }

  return problem;
};

export const formatErrorResponse = (
  error: unknown
): { error: { code: string; message: string; details?: unknown } } => {
  if (error instanceof ResourceError) {
    return {
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
      },
    };
  }

  if (error instanceof ZodError) {
    return {
      error: {
        code: "VALIDATION_ERROR",
        message: "Validation failed",
        details: formatZodError(error),
      },
    };
  }

  if (error instanceof Error) {
    return {
      error: {
        code: "INTERNAL_ERROR",
        message: isProduction() ? "Internal server error" : error.message,
      },
    };
  }

  return {
    error: {
      code: "UNKNOWN_ERROR",
      message: "An unknown error occurred",
    },
  };
};
