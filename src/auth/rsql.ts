import { CompiledScope } from "@/resource/types";

const escapeValue = (value: unknown): string => {
  if (value === null || value === undefined) {
    return "null";
  }

  if (typeof value === "number") {
    return String(value);
  }

  if (typeof value === "boolean") {
    return String(value);
  }

  if (value instanceof Date) {
    return `"${value.toISOString()}"`;
  }

  if (Array.isArray(value)) {
    return `(${value.map(escapeValue).join(",")})`;
  }

  const str = String(value);
  const escaped = str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/'/g, "\\'");
  return `"${escaped}"`;
};

class ScopeExpression implements CompiledScope {
  constructor(private expression: string) {}

  toString(): string {
    return this.expression;
  }

  isEmpty(): boolean {
    return this.expression.trim() === "";
  }

  and(other: CompiledScope): CompiledScope {
    if (this.isEmpty()) return other;
    if (other.isEmpty()) return this;
    return new ScopeExpression(`(${this.expression});(${other.toString()})`);
  }

  or(other: CompiledScope): CompiledScope {
    if (this.isEmpty()) return other;
    if (other.isEmpty()) return this;
    return new ScopeExpression(`(${this.expression}),(${other.toString()})`);
  }
}

export const emptyScope = (): CompiledScope => new ScopeExpression("");

export const allScope = (): CompiledScope => new ScopeExpression("*");

export function rsql(
  strings: TemplateStringsArray,
  ...values: unknown[]
): CompiledScope {
  let result = "";

  for (let i = 0; i < strings.length; i++) {
    result += strings[i];
    if (i < values.length) {
      result += escapeValue(values[i]);
    }
  }

  return new ScopeExpression(result.trim());
}

export const eq = (field: string, value: unknown): CompiledScope =>
  new ScopeExpression(`${field}==${escapeValue(value)}`);

export const ne = (field: string, value: unknown): CompiledScope =>
  new ScopeExpression(`${field}!=${escapeValue(value)}`);

export const gt = (field: string, value: unknown): CompiledScope =>
  new ScopeExpression(`${field}=gt=${escapeValue(value)}`);

export const gte = (field: string, value: unknown): CompiledScope =>
  new ScopeExpression(`${field}=ge=${escapeValue(value)}`);

export const lt = (field: string, value: unknown): CompiledScope =>
  new ScopeExpression(`${field}=lt=${escapeValue(value)}`);

export const lte = (field: string, value: unknown): CompiledScope =>
  new ScopeExpression(`${field}=le=${escapeValue(value)}`);

export const inList = (field: string, values: unknown[]): CompiledScope =>
  new ScopeExpression(`${field}=in=${escapeValue(values)}`);

export const notIn = (field: string, values: unknown[]): CompiledScope =>
  new ScopeExpression(`${field}=out=${escapeValue(values)}`);

export const like = (field: string, pattern: string): CompiledScope =>
  new ScopeExpression(`${field}%=${escapeValue(pattern)}`);

export const notLike = (field: string, pattern: string): CompiledScope =>
  new ScopeExpression(`${field}!%=${escapeValue(pattern)}`);

export const isNull = (field: string): CompiledScope =>
  new ScopeExpression(`${field}=isnull=true`);

export const isNotNull = (field: string): CompiledScope =>
  new ScopeExpression(`${field}=isnull=false`);

export const and = (...scopes: CompiledScope[]): CompiledScope => {
  const nonEmpty = scopes.filter((s) => !s.isEmpty());
  if (nonEmpty.length === 0) return emptyScope();
  if (nonEmpty.length === 1) return nonEmpty[0];

  return new ScopeExpression(
    nonEmpty.map((s) => `(${s.toString()})`).join(";")
  );
};

export const or = (...scopes: CompiledScope[]): CompiledScope => {
  const nonEmpty = scopes.filter((s) => !s.isEmpty());
  if (nonEmpty.length === 0) return emptyScope();
  if (nonEmpty.length === 1) return nonEmpty[0];

  return new ScopeExpression(
    nonEmpty.map((s) => `(${s.toString()})`).join(",")
  );
};

export const ownerScope = (userId: string, ownerField = "userId"): CompiledScope =>
  eq(ownerField, userId);

export const publicScope = (publicField = "public"): CompiledScope =>
  eq(publicField, true);

export const ownerOrPublic = (
  userId: string,
  ownerField = "userId",
  publicField = "public"
): CompiledScope =>
  or(ownerScope(userId, ownerField), publicScope(publicField));

export const isCompiledScope = (value: unknown): value is CompiledScope => {
  return (
    typeof value === "object" &&
    value !== null &&
    "toString" in value &&
    "isEmpty" in value &&
    "and" in value &&
    "or" in value
  );
};

export const scopeFromString = (expression: string): CompiledScope =>
  new ScopeExpression(expression);

export { ScopeExpression };
