import type { Context, ErrorHandler, NotFoundHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ZodError } from "zod";
import {
  ResourceError,
  formatRFC7807Error,
  RateLimitError,
  ERROR_TYPES,
  ProblemDetail,
} from "@/resource/error";
import { isDebugEnabled } from "@/server/env";
import { getLogger } from "@/server/logger";

const problemResponse = (c: Context, problem: ProblemDetail, status: number): Response => {
  c.header("Content-Type", "application/problem+json");
  return c.body(JSON.stringify(problem), status as ContentfulStatusCode);
};

export const errorHandler: ErrorHandler = (error, c) => {
  const requestId = c.get("requestId");

  let statusCode = 500;
  if (error instanceof ResourceError) {
    statusCode = error.statusCode;
  } else if (error instanceof ZodError) {
    statusCode = 400;
  } else if (error instanceof HTTPException) {
    statusCode = error.status;
  }

  // 4xx are expected client errors (validation, not-found, precondition,
  // rate-limit, auth) — log at warn so they don't drown real 5xx server errors.
  const logger = getLogger();
  const fields = {
    requestId,
    method: c.req.method,
    path: c.req.path,
    status: statusCode,
    error: error instanceof Error ? error.message : String(error),
    stack: isDebugEnabled() && error instanceof Error ? error.stack : undefined,
  };
  if (statusCode >= 500) {
    logger.error("Request error", fields);
  } else {
    logger.warn("Request error", fields);
  }

  if (error instanceof HTTPException) {
    return error.getResponse();
  }

  if (error instanceof RateLimitError) {
    c.header("Retry-After", String(Math.ceil(error.retryAfter / 1000)));
  }

  const problem = formatRFC7807Error(error, requestId);
  return problemResponse(c, problem, statusCode);
};

export const notFoundHandler: NotFoundHandler = (c) => {
  const requestId = c.get("requestId");

  const problem: ProblemDetail = {
    type: ERROR_TYPES.NOT_FOUND,
    title: "Not found",
    status: 404,
    detail: `Route ${c.req.method} ${c.req.path} not found`,
    code: "NOT_FOUND",
  };

  if (requestId) {
    problem.instance = `/requests/${requestId}`;
    problem.requestId = requestId;
  }

  return problemResponse(c, problem, 404);
};
