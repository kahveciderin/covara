import { getTableColumns, type Table } from "drizzle-orm";

// Coerce an htmx form body (all string values) into the shapes the resource's
// insert/update validation expects, using the table's column data types. Only
// present keys are coerced (so PATCH keeps partial semantics); unchecked
// checkboxes are simply absent. Unknown keys pass through unchanged.
export const coerceFormBody = (
  body: Record<string, unknown>,
  table: Table
): Record<string, unknown> => {
  const columns = getTableColumns(table) as Record<string, { dataType?: string }>;
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(body)) {
    if (typeof File !== "undefined" && value instanceof File) continue;
    const column = columns[key];
    if (!column) {
      out[key] = value;
      continue;
    }
    const str = typeof value === "string" ? value : String(value);
    switch (column.dataType) {
      case "number":
      case "bigint":
        out[key] = str === "" ? null : Number(str);
        break;
      case "boolean":
        out[key] = str === "on" || str === "true" || str === "1";
        break;
      default:
        out[key] = value;
    }
  }

  return out;
};
