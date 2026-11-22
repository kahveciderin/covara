import { Table, TableConfig, getTableColumns } from "drizzle-orm";

// An offset is required whenever a time is given: without one the instant would
// depend on the server's timezone.
const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))?$/;

const parseInstant = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  const match = ISO_INSTANT.exec(value);
  if (!match) return value;
  const [year, month, day] = match.slice(1).map(Number);
  // `new Date` rolls 2026-02-30 over into March instead of failing.
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return value;
  return new Date(value);
};

export const createDateInputParser = <TConfig extends TableConfig>(
  table: Table<TConfig>
): ((body: unknown) => unknown) => {
  const parsers: [string, (value: unknown) => unknown][] = [];
  for (const [key, column] of Object.entries(getTableColumns(table))) {
    const { dataType, baseColumn } = column as { dataType: string; baseColumn?: { dataType: string } };
    if (dataType === "date") {
      parsers.push([key, parseInstant]);
    } else if (baseColumn?.dataType === "date") {
      parsers.push([key, (value) => (Array.isArray(value) ? value.map(parseInstant) : value)]);
    }
  }

  return (body) => {
    if (parsers.length === 0 || body === null || typeof body !== "object" || Array.isArray(body)) {
      return body;
    }
    const out = { ...(body as Record<string, unknown>) };
    for (const [key, parse] of parsers) {
      if (key in out) out[key] = parse(out[key]);
    }
    return out;
  };
};
