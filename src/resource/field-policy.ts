import type { FieldPolicies, FilterConfig } from "./types";
import { ValidationError } from "./error";

export interface QueryableFields {
  filter: string[] | null;
  sort: string[] | null;
  groupBy: string[] | null;
  metrics: string[] | null;
}

// A column hidden from responses by `fields.readable` must not be usable in
// queries either: filtering, sorting or aggregating on it turns the API into an
// oracle for the hidden value (e.g. `?filter=email==victim@x` reveals whether
// the address exists). Each operation therefore defaults to the readable
// allowlist; an explicit per-operation list overrides it. `null` = unrestricted.
export const resolveQueryableFields = (
  fields: FieldPolicies | undefined,
  filterConfig?: FilterConfig
): QueryableFields => {
  const readable = fields?.readable ?? null;
  let filter = fields?.filterable ?? readable;
  if (filterConfig?.allowedFields) {
    const allowed = filterConfig.allowedFields;
    filter = filter ? filter.filter((f) => allowed.includes(f)) : [...allowed];
  }
  return {
    filter,
    sort: fields?.sortable ?? readable,
    groupBy: fields?.aggregatable?.groupBy ?? readable,
    metrics: fields?.aggregatable?.metrics ?? readable,
  };
};

export const assertQueryableFields = (
  allowed: string[] | null,
  requested: string[],
  operation: "sort" | "groupBy" | "metric"
): void => {
  if (!allowed) return;
  const invalid = requested.filter((f) => !allowed.includes(f));
  if (invalid.length === 0) return;
  const verb =
    operation === "sort" ? "sortable" : operation === "groupBy" ? "groupable" : "aggregatable";
  throw new ValidationError(`Field '${invalid[0]}' is not ${verb}`, {
    field: invalid[0],
    operation,
    invalidFields: invalid,
    allowedFields: allowed,
  });
};

const registry = new Map<string, QueryableFields>();

export const registerQueryableFields = (resource: string, fields: QueryableFields): void => {
  registry.set(resource, fields);
};

export const getQueryableFields = (resource: string): QueryableFields | undefined =>
  registry.get(resource);
