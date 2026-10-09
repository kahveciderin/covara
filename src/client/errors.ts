export interface ErrorBodyInfo {
  message: string;
  code: string;
  details?: unknown;
}

const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

// Pull a human-readable message out of any error body a server may send:
// Covara's RFC 7807 problem+json ({ detail, title, code, errors }), the
// { error: { message, code, details } } envelope, a bare { error: "text" } or
// { message: "text" }, or a plain-text body.
export const describeErrorBody = (
  body: unknown,
  status: number,
  fallback = `HTTP ${status}`
): ErrorBodyInfo => {
  if (nonEmpty(body)) {
    return { message: body.trim().slice(0, 500), code: "HTTP_ERROR" };
  }
  if (!body || typeof body !== "object") {
    return { message: fallback, code: "HTTP_ERROR" };
  }

  const record = body as Record<string, unknown>;
  const code = nonEmpty(record.code) ? record.code : "HTTP_ERROR";

  const error = record.error;
  if (nonEmpty(error)) {
    return { message: error, code };
  }
  if (error && typeof error === "object") {
    const nested = error as Record<string, unknown>;
    if (nonEmpty(nested.message)) {
      return {
        message: nested.message,
        code: nonEmpty(nested.code) ? nested.code : code,
        details: nested.details,
      };
    }
  }

  if (nonEmpty(record.detail)) {
    return { message: record.detail, code, details: record.errors };
  }
  if (nonEmpty(record.message)) {
    return { message: record.message, code, details: record.details ?? record.errors };
  }
  if (nonEmpty(record.title)) {
    return { message: record.title, code, details: record.errors };
  }
  return { message: fallback, code };
};
