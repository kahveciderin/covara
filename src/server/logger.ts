import { isDebugEnabled, readEnv } from "@/server/env";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

export interface LogRecord {
  level: LogLevel;
  time: string;
  msg: string;
  [field: string]: unknown;
}

export type LogSink = (record: LogRecord) => void;

export interface Logger {
  debug: (msg: string, fields?: LogFields) => void;
  info: (msg: string, fields?: LogFields) => void;
  warn: (msg: string, fields?: LogFields) => void;
  error: (msg: string, fields?: LogFields) => void;
  child: (fields: LogFields) => Logger;
  level: LogLevel;
}

export interface CreateLoggerOptions {
  level?: LogLevel;
  sink?: LogSink;
  base?: LogFields;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const CONSOLE_BY_LEVEL: Record<LogLevel, (line: string) => void> = {
  debug: (line) => console.debug(line),
  warn: (line) => console.warn(line),
  error: (line) => console.error(line),
  info: (line) => console.log(line),
};

export const defaultSink: LogSink = (record) => {
  const line = JSON.stringify(record);
  (CONSOLE_BY_LEVEL[record.level] ?? CONSOLE_BY_LEVEL.info)(line);
};

const isLogLevel = (value: string | undefined): value is LogLevel =>
  value === "debug" || value === "info" || value === "warn" || value === "error";

export const resolveDefaultLevel = (): LogLevel => {
  const fromEnv = readEnv("CONCAVE_LOG_LEVEL")?.toLowerCase();
  if (isLogLevel(fromEnv)) return fromEnv;
  if (isDebugEnabled()) return "debug";
  return "info";
};

export const createLogger = (options: CreateLoggerOptions = {}): Logger => {
  const level = options.level ?? resolveDefaultLevel();
  const sink = options.sink ?? defaultSink;
  const base = options.base ?? {};
  const threshold = LEVEL_ORDER[level];

  const emit = (recordLevel: LogLevel, msg: string, fields?: LogFields): void => {
    if (LEVEL_ORDER[recordLevel] < threshold) return;
    const record: LogRecord = {
      level: recordLevel,
      time: new Date().toISOString(),
      msg,
      ...base,
      ...(fields ?? {}),
    };
    sink(record);
  };

  return {
    level,
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
    child: (fields) =>
      createLogger({ level, sink, base: { ...base, ...fields } }),
  };
};

let globalLogger: Logger = createLogger();

export const getLogger = (): Logger => globalLogger;

export const setLogger = (logger: Logger): void => {
  globalLogger = logger;
};
