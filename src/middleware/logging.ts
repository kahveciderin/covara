// Public entry for the structured logger, exposed at the
// `covara/middleware/logging` subpath. The implementation lives
// in the server runtime layer; this re-export keeps the documented import path
// stable and runtime-agnostic.
export {
  createLogger,
  getLogger,
  setLogger,
  defaultSink,
  resolveDefaultLevel,
} from "@/server/logger";
export type {
  Logger,
  LogLevel,
  LogFields,
  LogRecord,
  LogSink,
  CreateLoggerOptions,
} from "@/server/logger";
