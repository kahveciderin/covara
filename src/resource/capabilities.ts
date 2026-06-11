import { getTableColumns, Table, TableConfig } from "drizzle-orm";
import { ValidationError } from "./error";
import { FieldPolicies, ResourceCapabilities } from "./types";

export type FieldOperation =
  | "read"
  | "write"
  | "filter"
  | "sort"
  | "groupBy"
  | "metric";

export interface FieldValidationResult {
  valid: boolean;
  allowedFields: string[];
  invalidFields: string[];
}

const findSimilarFields = (field: string, allowedFields: string[]): string[] => {
  const normalizedField = field.toLowerCase();
  return allowedFields
    .filter((allowed) => {
      const normalizedAllowed = allowed.toLowerCase();
      return (
        normalizedAllowed.includes(normalizedField) ||
        normalizedField.includes(normalizedAllowed) ||
        levenshteinDistance(normalizedField, normalizedAllowed) <= 2
      );
    })
    .slice(0, 3);
};

const levenshteinDistance = (a: string, b: string): number => {
  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= a.length; j++) {
    matrix[0]![j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i]![j] = matrix[i - 1]![j - 1]!;
      } else {
        matrix[i]![j] = Math.min(
          matrix[i - 1]![j - 1]! + 1,
          matrix[i]![j - 1]! + 1,
          matrix[i - 1]![j]! + 1
        );
      }
    }
  }

  return matrix[b.length]![a.length]!;
};

export const getAllowedFields = (
  policies: FieldPolicies | undefined,
  operation: FieldOperation,
  schemaColumns: string[]
): string[] => {
  if (!policies) {
    return schemaColumns;
  }

  switch (operation) {
    case "read":
      return policies.readable ?? schemaColumns;
    case "write":
      return policies.writable ?? schemaColumns;
    case "filter":
      return policies.filterable ?? schemaColumns;
    case "sort":
      return policies.sortable ?? schemaColumns;
    case "groupBy":
      return policies.aggregatable?.groupBy ?? schemaColumns;
    case "metric":
      return policies.aggregatable?.metrics ?? schemaColumns;
    default:
      return schemaColumns;
  }
};

export const validateFieldAccess = (
  policies: FieldPolicies | undefined,
  operation: FieldOperation,
  requestedFields: string[],
  schemaColumns: string[]
): FieldValidationResult => {
  const allowedFields = getAllowedFields(policies, operation, schemaColumns);
  const invalidFields: string[] = [];

  for (const field of requestedFields) {
    if (!allowedFields.includes(field)) {
      invalidFields.push(field);
    }
  }

  return {
    valid: invalidFields.length === 0,
    allowedFields,
    invalidFields,
  };
};

export const validateFieldAccessOrThrow = (
  policies: FieldPolicies | undefined,
  operation: FieldOperation,
  requestedFields: string[],
  schemaColumns: string[]
): void => {
  const result = validateFieldAccess(
    policies,
    operation,
    requestedFields,
    schemaColumns
  );

  if (!result.valid) {
    const field = result.invalidFields[0]!;
    const similarFields = findSimilarFields(field, result.allowedFields);

    throw new ValidationError(
      `Field '${field}' is not allowed for ${operation}`,
      {
        field,
        operation,
        invalidFields: result.invalidFields,
        allowedFields: result.allowedFields,
        suggestion:
          similarFields.length > 0
            ? `Did you mean: ${similarFields.join(", ")}?`
            : undefined,
      }
    );
  }
};

export const applyReadablePolicy = <T extends Record<string, unknown>>(
  items: T[],
  policies: FieldPolicies | undefined
): Partial<T>[] => {
  if (!policies?.readable) {
    return items;
  }

  const readable = new Set(policies.readable);

  return items.map((item) => {
    const result: Partial<T> = {};
    for (const key of Object.keys(item)) {
      if (readable.has(key)) {
        result[key as keyof T] = item[key as keyof T];
      }
    }
    return result;
  });
};

export const stripNonWritableFields = <T extends Record<string, unknown>>(
  data: T,
  policies: FieldPolicies | undefined
): Partial<T> => {
  if (!policies?.writable) {
    return data;
  }

  const writable = new Set(policies.writable);
  const result: Partial<T> = {};

  for (const key of Object.keys(data)) {
    if (writable.has(key)) {
      result[key as keyof T] = data[key as keyof T];
    }
  }

  return result;
};

export const DEFAULT_CAPABILITIES: ResourceCapabilities = {
  enableAggregations: true,
  enableBatch: true,
  enableSubscribe: true,
  enableCreate: true,
  enableUpdate: true,
  enableDelete: true,
};

export const isCapabilityEnabled = (
  capabilities: ResourceCapabilities | undefined,
  capability: keyof ResourceCapabilities
): boolean => {
  if (!capabilities) {
    return DEFAULT_CAPABILITIES[capability] ?? true;
  }

  return capabilities[capability] ?? DEFAULT_CAPABILITIES[capability] ?? true;
};

export const validateCapabilityOrThrow = (
  capabilities: ResourceCapabilities | undefined,
  capability: keyof ResourceCapabilities,
  resourceName: string
): void => {
  if (!isCapabilityEnabled(capabilities, capability)) {
    const operationName = capability.replace("enable", "").toLowerCase();
    throw new ValidationError(
      `${operationName} is not enabled for resource '${resourceName}'`,
      {
        resource: resourceName,
        capability,
        suggestion: `Enable ${capability} in the resource configuration`,
      }
    );
  }
};

export const getSchemaColumns = <TConfig extends TableConfig>(
  schema: Table<TConfig>
): string[] => {
  return Object.keys(getTableColumns(schema));
};

export interface CapabilityInfo {
  name: string;
  enabled: boolean;
  fields?: string[];
}

export const getResourceCapabilityInfo = (
  capabilities: ResourceCapabilities | undefined,
  policies: FieldPolicies | undefined,
  schemaColumns: string[]
): CapabilityInfo[] => {
  const info: CapabilityInfo[] = [];

  info.push({
    name: "create",
    enabled: isCapabilityEnabled(capabilities, "enableCreate"),
    fields: getAllowedFields(policies, "write", schemaColumns),
  });

  info.push({
    name: "read",
    enabled: true,
    fields: getAllowedFields(policies, "read", schemaColumns),
  });

  info.push({
    name: "update",
    enabled: isCapabilityEnabled(capabilities, "enableUpdate"),
    fields: getAllowedFields(policies, "write", schemaColumns),
  });

  info.push({
    name: "delete",
    enabled: isCapabilityEnabled(capabilities, "enableDelete"),
  });

  info.push({
    name: "batch",
    enabled: isCapabilityEnabled(capabilities, "enableBatch"),
  });

  info.push({
    name: "aggregate",
    enabled: isCapabilityEnabled(capabilities, "enableAggregations"),
    fields: getAllowedFields(policies, "groupBy", schemaColumns),
  });

  info.push({
    name: "subscribe",
    enabled: isCapabilityEnabled(capabilities, "enableSubscribe"),
    fields: getAllowedFields(policies, "filter", schemaColumns),
  });

  info.push({
    name: "filter",
    enabled: true,
    fields: getAllowedFields(policies, "filter", schemaColumns),
  });

  info.push({
    name: "sort",
    enabled: true,
    fields: getAllowedFields(policies, "sort", schemaColumns),
  });

  return info;
};

export const extractFieldsFromFilter = (filter: string): string[] => {
  const fields: string[] = [];
  const fieldRegex = /([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:==|!=|>=|<=|>|<|=\w+=)/g;
  let match;

  while ((match = fieldRegex.exec(filter)) !== null) {
    if (match[1] && !fields.includes(match[1])) {
      fields.push(match[1]);
    }
  }

  return fields;
};

export const validateFilterFields = (
  filter: string,
  policies: FieldPolicies | undefined,
  schemaColumns: string[]
): void => {
  const fields = extractFieldsFromFilter(filter);
  validateFieldAccessOrThrow(policies, "filter", fields, schemaColumns);
};

export const validateOrderByFields = (
  orderBy: string | undefined,
  policies: FieldPolicies | undefined,
  schemaColumns: string[]
): void => {
  if (!orderBy) return;

  const fields = orderBy.split(",").map((part) => {
    const [field] = part.trim().split(":");
    return field!;
  });

  validateFieldAccessOrThrow(policies, "sort", fields, schemaColumns);
};

export const validateSelectFields = (
  select: string[] | undefined,
  policies: FieldPolicies | undefined,
  schemaColumns: string[]
): void => {
  if (!select || select.length === 0) return;

  validateFieldAccessOrThrow(policies, "read", select, schemaColumns);
};

export const validateAggregationFields = (
  groupBy: string[] | undefined,
  metrics: string[] | undefined,
  policies: FieldPolicies | undefined,
  schemaColumns: string[]
): void => {
  if (groupBy && groupBy.length > 0) {
    validateFieldAccessOrThrow(policies, "groupBy", groupBy, schemaColumns);
  }

  if (metrics && metrics.length > 0) {
    validateFieldAccessOrThrow(policies, "metric", metrics, schemaColumns);
  }
};
