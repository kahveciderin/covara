/**
 * Date deserialization contract.
 *
 * The wire format for date/datetime fields is always an ISO 8601 `string` —
 * the generated types do not lie by claiming `Date` for values that arrive as
 * strings over JSON. To get a real `Date`, callers either:
 *
 *  1. Use the `toDate()` / `toDateOrNull()` helpers at the point of use, or
 *  2. Opt into automatic parsing by passing `parseDates` to the transport
 *     (see `TransportConfig.parseDates`), which mutates known date fields on
 *     the parsed response into `Date` instances at runtime.
 *
 * `ISODateString` is a branded `string` so that, where a generated type marks a
 * field as a date, the value is still assignable to/from `string` but can be
 * recognised as a date field at the type level.
 */

declare const isoDateBrand: unique symbol;

export type ISODateString = string & { readonly [isoDateBrand]?: never };

export const toDate = (value: ISODateString | string): Date => new Date(value);

export const toDateOrNull = (
  value: ISODateString | string | null | undefined
): Date | null => (value == null ? null : new Date(value));

/**
 * Registry mapping a resource path to the list of its date field names. The
 * transport consults this (when `parseDates` is enabled) to convert ISO strings
 * into `Date` instances on parsed responses. Populate it from generated code or
 * by hand via `registerDateFields`.
 */
export type DateFieldRegistry = Record<string, readonly string[]>;

const ISO_DATE_RE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

export const isISODateString = (value: unknown): value is string =>
  typeof value === "string" && ISO_DATE_RE.test(value);

const reviveValue = (value: unknown): unknown =>
  isISODateString(value) ? new Date(value) : value;

/**
 * Walk a parsed JSON value and convert ISO date strings into `Date` objects.
 *
 * When `fields` is provided, only those top-level (and per-item, for arrays /
 * `{ items: [] }` envelopes) keys are converted. When omitted, every string
 * that looks like an ISO 8601 date is converted.
 */
export const reviveDates = <T>(data: T, fields?: readonly string[]): T => {
  if (data == null || typeof data !== "object") {
    return data;
  }

  if (Array.isArray(data)) {
    return data.map((item) => reviveDates(item, fields)) as unknown as T;
  }

  const record = data as Record<string, unknown>;

  if (Array.isArray(record.items)) {
    return {
      ...record,
      items: (record.items as unknown[]).map((item) => reviveDates(item, fields)),
    } as unknown as T;
  }

  const result: Record<string, unknown> = { ...record };
  for (const key of Object.keys(result)) {
    if (fields) {
      if (fields.includes(key)) {
        result[key] = reviveValue(result[key]);
      }
    } else {
      result[key] = reviveValue(result[key]);
    }
  }
  return result as T;
};
