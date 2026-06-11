export type Primitive = string | number | boolean | Date | null;

const escapeValue = (value: unknown): string => {
  if (value === null) {
    return "null";
  }

  if (typeof value === "string") {
    const escaped = value
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"');
    return `"${escaped}"`;
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

  return String(value);
};

const escapeForArray = (values: unknown[]): string => {
  return values.map(escapeValue).join(",");
};

export interface QueryBuilder {
  eq: (field: string, value: unknown) => string;
  neq: (field: string, value: unknown) => string;
  gt: (field: string, value: number | Date | string) => string;
  gte: (field: string, value: number | Date | string) => string;
  lt: (field: string, value: number | Date | string) => string;
  lte: (field: string, value: number | Date | string) => string;
  like: (field: string, pattern: string) => string;
  notLike: (field: string, pattern: string) => string;
  ilike: (field: string, pattern: string) => string;
  in: (field: string, values: unknown[]) => string;
  out: (field: string, values: unknown[]) => string;
  isNull: (field: string) => string;
  isNotNull: (field: string) => string;
  and: (...conditions: string[]) => string;
  or: (...conditions: string[]) => string;
  startsWith: (field: string, prefix: string) => string;
  endsWith: (field: string, suffix: string) => string;
  contains: (field: string, substring: string) => string;
  icontains: (field: string, substring: string) => string;
  between: (
    field: string,
    min: number | Date | string,
    max: number | Date | string
  ) => string;
  raw: (expression: string) => string;
}

export const q: QueryBuilder = {
  eq: (field, value) => `${field}==${escapeValue(value)}`,
  neq: (field, value) => `${field}!=${escapeValue(value)}`,
  gt: (field, value) => `${field}>${escapeValue(value)}`,
  gte: (field, value) => `${field}>=${escapeValue(value)}`,
  lt: (field, value) => `${field}<${escapeValue(value)}`,
  lte: (field, value) => `${field}<=${escapeValue(value)}`,
  like: (field, pattern) => `${field}%=${escapeValue(pattern)}`,
  notLike: (field, pattern) => `${field}!%=${escapeValue(pattern)}`,
  ilike: (field, pattern) => `${field}=ilike=${escapeValue(pattern)}`,
  in: (field, values) => `${field}=in=(${escapeForArray(values)})`,
  out: (field, values) => `${field}=out=(${escapeForArray(values)})`,
  isNull: (field) => `${field}=isnull=true`,
  isNotNull: (field) => `${field}=isnull=false`,
  and: (...conditions) => {
    const filtered = conditions.filter(Boolean);
    if (filtered.length === 0) return "";
    if (filtered.length === 1) return filtered[0]!;
    return filtered.map((c) => `(${c})`).join(";");
  },
  or: (...conditions) => {
    const filtered = conditions.filter(Boolean);
    if (filtered.length === 0) return "";
    if (filtered.length === 1) return filtered[0]!;
    return filtered.map((c) => `(${c})`).join(",");
  },
  startsWith: (field, prefix) => `${field}=startswith=${escapeValue(prefix)}`,
  endsWith: (field, suffix) => `${field}=endswith=${escapeValue(suffix)}`,
  contains: (field, substring) => `${field}=contains=${escapeValue(substring)}`,
  icontains: (field, substring) => `${field}=icontains=${escapeValue(substring)}`,
  between: (field, min, max) =>
    q.and(q.gte(field, min), q.lte(field, max)),
  raw: (expression) => expression,
};

export class QueryBuilderChain {
  private conditions: string[] = [];
  private combinator: "and" | "or" = "and";

  constructor(private fieldPrefix: string = "") {}

  private getField(field: string): string {
    return this.fieldPrefix ? `${this.fieldPrefix}.${field}` : field;
  }

  eq(field: string, value: unknown): this {
    this.conditions.push(q.eq(this.getField(field), value));
    return this;
  }

  neq(field: string, value: unknown): this {
    this.conditions.push(q.neq(this.getField(field), value));
    return this;
  }

  gt(field: string, value: number | Date | string): this {
    this.conditions.push(q.gt(this.getField(field), value));
    return this;
  }

  gte(field: string, value: number | Date | string): this {
    this.conditions.push(q.gte(this.getField(field), value));
    return this;
  }

  lt(field: string, value: number | Date | string): this {
    this.conditions.push(q.lt(this.getField(field), value));
    return this;
  }

  lte(field: string, value: number | Date | string): this {
    this.conditions.push(q.lte(this.getField(field), value));
    return this;
  }

  like(field: string, pattern: string): this {
    this.conditions.push(q.like(this.getField(field), pattern));
    return this;
  }

  in(field: string, values: unknown[]): this {
    this.conditions.push(q.in(this.getField(field), values));
    return this;
  }

  out(field: string, values: unknown[]): this {
    this.conditions.push(q.out(this.getField(field), values));
    return this;
  }

  isNull(field: string): this {
    this.conditions.push(q.isNull(this.getField(field)));
    return this;
  }

  isNotNull(field: string): this {
    this.conditions.push(q.isNotNull(this.getField(field)));
    return this;
  }

  startsWith(field: string, prefix: string): this {
    this.conditions.push(q.startsWith(this.getField(field), prefix));
    return this;
  }

  endsWith(field: string, suffix: string): this {
    this.conditions.push(q.endsWith(this.getField(field), suffix));
    return this;
  }

  contains(field: string, substring: string): this {
    this.conditions.push(q.contains(this.getField(field), substring));
    return this;
  }

  between(
    field: string,
    min: number | Date | string,
    max: number | Date | string
  ): this {
    this.conditions.push(q.between(this.getField(field), min, max));
    return this;
  }

  and(condition: string | QueryBuilderChain): this {
    if (condition instanceof QueryBuilderChain) {
      this.conditions.push(condition.build());
    } else {
      this.conditions.push(condition);
    }
    return this;
  }

  or(condition: string | QueryBuilderChain): this {
    if (this.conditions.length > 0 && this.combinator === "and") {
      const previous = this.conditions.join(";");
      this.conditions = [previous];
    }
    this.combinator = "or";

    if (condition instanceof QueryBuilderChain) {
      this.conditions.push(condition.build());
    } else {
      this.conditions.push(condition);
    }
    return this;
  }

  raw(expression: string): this {
    this.conditions.push(expression);
    return this;
  }

  build(): string {
    if (this.conditions.length === 0) return "";
    if (this.conditions.length === 1) return this.conditions[0]!;

    if (this.combinator === "or") {
      return q.or(...this.conditions);
    }
    return q.and(...this.conditions);
  }

  toString(): string {
    return this.build();
  }
}

export const createQueryBuilder = (fieldPrefix?: string): QueryBuilderChain => {
  return new QueryBuilderChain(fieldPrefix);
};

export const where = createQueryBuilder;

export interface FieldBuilder<T extends Primitive = Primitive> {
  eq: (value: T) => string;
  neq: (value: T) => string;
  gt: (value: NonNullable<T>) => string;
  gte: (value: NonNullable<T>) => string;
  lt: (value: NonNullable<T>) => string;
  lte: (value: NonNullable<T>) => string;
  in: (values: NonNullable<T>[]) => string;
  out: (values: NonNullable<T>[]) => string;
  isNull: () => string;
  isNotNull: () => string;
  like: (pattern: string) => string;
  contains: (substring: string) => string;
  startsWith: (prefix: string) => string;
  endsWith: (suffix: string) => string;
  between: (min: NonNullable<T>, max: NonNullable<T>) => string;
}

export const createFieldBuilder = <T extends Primitive = Primitive>(
  fieldName: string
): FieldBuilder<T> => {
  return {
    eq: (value: T) => q.eq(fieldName, value),
    neq: (value: T) => q.neq(fieldName, value),
    gt: (value: T) => q.gt(fieldName, value as number | Date | string),
    gte: (value: T) => q.gte(fieldName, value as number | Date | string),
    lt: (value: T) => q.lt(fieldName, value as number | Date | string),
    lte: (value: T) => q.lte(fieldName, value as number | Date | string),
    in: (values: T[]) => q.in(fieldName, values),
    out: (values: T[]) => q.out(fieldName, values),
    isNull: () => q.isNull(fieldName),
    isNotNull: () => q.isNotNull(fieldName),
    like: (pattern: string) => q.like(fieldName, pattern),
    contains: (substring: string) => q.contains(fieldName, substring),
    startsWith: (prefix: string) => q.startsWith(fieldName, prefix),
    endsWith: (suffix: string) => q.endsWith(fieldName, suffix),
    between: (min: T, max: T) =>
      q.between(fieldName, min as number | Date | string, max as number | Date | string),
  };
};

export type TypedQueryBuilder<T> = {
  [K in keyof T]-?: [Extract<T[K], Primitive>] extends [never]
    ? FieldBuilder
    : FieldBuilder<Extract<T[K], Primitive>>;
};

export const createTypedQueryBuilder = <T extends object>(
  fields?: (keyof T)[]
): TypedQueryBuilder<T> => {
  // If fields are provided, create explicit builder
  if (fields) {
    const builder: Partial<TypedQueryBuilder<T>> = {};
    for (const field of fields) {
      builder[field] = createFieldBuilder(String(field)) as TypedQueryBuilder<T>[typeof field];
    }
    return builder as TypedQueryBuilder<T>;
  }

  // Otherwise, use Proxy for dynamic field access
  return new Proxy({} as TypedQueryBuilder<T>, {
    get(_target, prop: string) {
      return createFieldBuilder(prop);
    },
  });
};

export interface IncludeOptions {
  select?: string[];
  limit?: number;
}

export interface IncludeConfig {
  name: string;
  options?: IncludeOptions;
}

const buildIncludeString = (configs: IncludeConfig[]): string => {
  return configs
    .map(({ name, options }) => {
      if (!options || (options.select === undefined && options.limit === undefined)) {
        return name;
      }

      const parts: string[] = [];
      if (options.select && options.select.length > 0) {
        parts.push(`select:${options.select.join(",")}`);
      }
      if (options.limit !== undefined) {
        parts.push(`limit:${options.limit}`);
      }

      return `${name}(${parts.join(";")})`;
    })
    .join(",");
};

export const include = (...relations: (string | IncludeConfig)[]): string => {
  const configs: IncludeConfig[] = relations.map((r) =>
    typeof r === "string" ? { name: r } : r
  );
  return buildIncludeString(configs);
};

export const withSelect = (name: string, select: string[]): IncludeConfig => ({
  name,
  options: { select },
});

export const withLimit = (name: string, limit: number): IncludeConfig => ({
  name,
  options: { limit },
});

export const withOptions = (
  name: string,
  options: IncludeOptions
): IncludeConfig => ({
  name,
  options,
});

export class IncludeBuilder {
  private configs: IncludeConfig[] = [];

  add(name: string, options?: IncludeOptions): this {
    this.configs.push({ name, options });
    return this;
  }

  select(name: string, fields: string[]): this {
    this.configs.push({ name, options: { select: fields } });
    return this;
  }

  limit(name: string, max: number): this {
    this.configs.push({ name, options: { limit: max } });
    return this;
  }

  build(): string {
    return buildIncludeString(this.configs);
  }

  toString(): string {
    return this.build();
  }
}

export const createIncludeBuilder = (): IncludeBuilder => {
  return new IncludeBuilder();
};

type FieldType<T, K extends keyof T> = Extract<T[K], Primitive>;

export interface TypedFilter<T> {
  eq<K extends keyof T>(field: K, value: FieldType<T, K>): string;
  neq<K extends keyof T>(field: K, value: FieldType<T, K>): string;
  gt<K extends keyof T>(field: K, value: NonNullable<FieldType<T, K>>): string;
  gte<K extends keyof T>(field: K, value: NonNullable<FieldType<T, K>>): string;
  lt<K extends keyof T>(field: K, value: NonNullable<FieldType<T, K>>): string;
  lte<K extends keyof T>(field: K, value: NonNullable<FieldType<T, K>>): string;
  in<K extends keyof T>(field: K, values: NonNullable<FieldType<T, K>>[]): string;
  out<K extends keyof T>(field: K, values: NonNullable<FieldType<T, K>>[]): string;
  isNull<K extends keyof T>(field: K): string;
  isNotNull<K extends keyof T>(field: K): string;
  like<K extends keyof T>(field: K, pattern: string): string;
  contains<K extends keyof T>(field: K, substring: string): string;
  startsWith<K extends keyof T>(field: K, prefix: string): string;
  endsWith<K extends keyof T>(field: K, suffix: string): string;
  between<K extends keyof T>(
    field: K,
    min: NonNullable<FieldType<T, K>>,
    max: NonNullable<FieldType<T, K>>
  ): string;
  and(...conditions: string[]): string;
  or(...conditions: string[]): string;
  raw(expression: string): string;
}

/**
 * Typed RSQL filter builder. Field names are validated against `keyof T` and
 * value types are checked against the field type, while `raw()` remains an
 * escape hatch for arbitrary expressions.
 *
 * @example
 * const filter = f<Todo>().eq("completed", true); // 'completed==true'
 */
export const createTypedFilter = <T>(): TypedFilter<T> => ({
  eq: (field, value) => q.eq(String(field), value),
  neq: (field, value) => q.neq(String(field), value),
  gt: (field, value) => q.gt(String(field), value as number | Date | string),
  gte: (field, value) => q.gte(String(field), value as number | Date | string),
  lt: (field, value) => q.lt(String(field), value as number | Date | string),
  lte: (field, value) => q.lte(String(field), value as number | Date | string),
  in: (field, values) => q.in(String(field), values),
  out: (field, values) => q.out(String(field), values),
  isNull: (field) => q.isNull(String(field)),
  isNotNull: (field) => q.isNotNull(String(field)),
  like: (field, pattern) => q.like(String(field), pattern),
  contains: (field, substring) => q.contains(String(field), substring),
  startsWith: (field, prefix) => q.startsWith(String(field), prefix),
  endsWith: (field, suffix) => q.endsWith(String(field), suffix),
  between: (field, min, max) =>
    q.between(String(field), min as number | Date | string, max as number | Date | string),
  and: (...conditions) => q.and(...conditions),
  or: (...conditions) => q.or(...conditions),
  raw: (expression) => q.raw(expression),
});

export const f = createTypedFilter;

export default q;
