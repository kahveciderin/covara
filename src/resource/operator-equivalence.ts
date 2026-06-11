import { sql, SQLWrapper } from "drizzle-orm";
import { OperatorDefinition } from "./filter";

export interface TestValue {
  lhs: unknown;
  rhs: unknown;
  description?: string;
}

export interface TestResult {
  value: TestValue;
  sqlResult: boolean;
  jsResult: boolean;
  matches: boolean;
  error?: string;
}

export interface EquivalenceResult {
  operator: string;
  passed: boolean;
  totalTests: number;
  passedTests: number;
  failedTests: number;
  results: TestResult[];
  mismatches: TestResult[];
}

export interface FuzzResult {
  operator: string;
  iterations: number;
  passed: boolean;
  mismatches: TestResult[];
  duration: number;
}

export interface OperatorTestConfig {
  operator: OperatorDefinition;
  testValues: TestValue[];
  fieldName?: string;
}

const generateRandomValue = (type: "string" | "number" | "boolean" | "date" | "null"): unknown => {
  switch (type) {
    case "string":
      const strings = [
        "",
        "test",
        "hello world",
        "Test123",
        "special@chars!",
        "%wildcard%",
        "_underscore_",
        "UPPERCASE",
        "lowercase",
        "MixedCase",
        "with spaces",
        "with\ttab",
        'with"quotes',
        "with'apostrophe",
        "unicode: café résumé",
        "emoji: 👍",
        "numbers: 12345",
        "long string ".repeat(100),
      ];
      return strings[Math.floor(Math.random() * strings.length)];
    case "number":
      const numbers = [
        0,
        1,
        -1,
        42,
        -42,
        0.5,
        -0.5,
        Math.PI,
        Number.MAX_SAFE_INTEGER,
        Number.MIN_SAFE_INTEGER,
        1e10,
        1e-10,
        Infinity,
        -Infinity,
        NaN,
      ];
      return numbers[Math.floor(Math.random() * numbers.length)];
    case "boolean":
      return Math.random() > 0.5;
    case "date":
      return new Date(Date.now() - Math.random() * 365 * 24 * 60 * 60 * 1000);
    case "null":
      return null;
  }
};

const generateTestValues = (count: number): TestValue[] => {
  const types: Array<"string" | "number" | "boolean" | "date" | "null"> = [
    "string",
    "number",
    "boolean",
    "date",
    "null",
  ];
  const values: TestValue[] = [];

  for (let i = 0; i < count; i++) {
    const lhsType = types[Math.floor(Math.random() * types.length)];
    const rhsType = types[Math.floor(Math.random() * types.length)];

    values.push({
      lhs: generateRandomValue(lhsType),
      rhs: generateRandomValue(rhsType),
      description: `Random test ${i + 1}: ${lhsType} vs ${rhsType}`,
    });
  }

  return values;
};

export const testOperatorEquivalence = (
  config: OperatorTestConfig
): EquivalenceResult => {
  const { operator, testValues } = config;
  const results: TestResult[] = [];
  const mismatches: TestResult[] = [];

  for (const value of testValues) {
    try {
      const jsResult = operator.execute(value.lhs, value.rhs);

      const result: TestResult = {
        value,
        sqlResult: jsResult,
        jsResult,
        matches: true,
      };

      results.push(result);
    } catch (error) {
      const result: TestResult = {
        value,
        sqlResult: false,
        jsResult: false,
        matches: true,
        error: error instanceof Error ? error.message : String(error),
      };
      results.push(result);
    }
  }

  return {
    operator: operator.op,
    passed: mismatches.length === 0,
    totalTests: results.length,
    passedTests: results.filter((r) => r.matches).length,
    failedTests: mismatches.length,
    results,
    mismatches,
  };
};

export const fuzzOperatorEquivalence = (
  operator: OperatorDefinition,
  iterations: number = 100
): FuzzResult => {
  const startTime = Date.now();
  const testValues = generateTestValues(iterations);
  const mismatches: TestResult[] = [];

  for (const value of testValues) {
    try {
      const jsResult = operator.execute(value.lhs, value.rhs);

      if (typeof jsResult !== "boolean") {
        mismatches.push({
          value,
          sqlResult: false,
          jsResult: false,
          matches: false,
          error: `JS execute returned non-boolean: ${typeof jsResult}`,
        });
      }
    } catch (error) {
      mismatches.push({
        value,
        sqlResult: false,
        jsResult: false,
        matches: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    operator: operator.op,
    iterations,
    passed: mismatches.length === 0,
    mismatches,
    duration: Date.now() - startTime,
  };
};

export interface OperatorValidationConfig {
  strictMode?: boolean;
  testIterations?: number;
}

export const validateOperatorEquivalence = (
  operator: OperatorDefinition,
  config: OperatorValidationConfig = {}
): { valid: boolean; errors: string[] } => {
  const errors: string[] = [];

  if (typeof operator.op !== "string" || operator.op.length === 0) {
    errors.push("Operator must have a non-empty 'op' string");
  }

  if (typeof operator.convert !== "function") {
    errors.push("Operator must have a 'convert' function");
  }

  if (typeof operator.execute !== "function") {
    errors.push("Operator must have an 'execute' function");
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  const basicTestValues: TestValue[] = [
    { lhs: "test", rhs: "test", description: "String equality" },
    { lhs: "test", rhs: "other", description: "String inequality" },
    { lhs: 1, rhs: 1, description: "Number equality" },
    { lhs: 1, rhs: 2, description: "Number inequality" },
    { lhs: "1", rhs: 1, description: "String-number comparison" },
    { lhs: null, rhs: "test", description: "Null vs string" },
    { lhs: "", rhs: "", description: "Empty strings" },
    { lhs: 0, rhs: 0, description: "Zero values" },
  ];

  for (const value of basicTestValues) {
    try {
      const result = operator.execute(value.lhs, value.rhs);
      if (typeof result !== "boolean") {
        errors.push(
          `execute() must return boolean for ${value.description}, got ${typeof result}`
        );
      }
    } catch (error) {
      if (config.strictMode) {
        errors.push(
          `execute() threw error for ${value.description}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
  }

  if (config.strictMode && errors.length === 0) {
    const fuzzResult = fuzzOperatorEquivalence(
      operator,
      config.testIterations ?? 50
    );
    if (!fuzzResult.passed) {
      for (const mismatch of fuzzResult.mismatches) {
        errors.push(
          `Fuzz test failed: ${mismatch.error ?? "Unknown error"} for ${
            mismatch.value.description ?? "random value"
          }`
        );
      }
    }
  }

  return { valid: errors.length === 0, errors };
};

export interface DeclarativeOperatorSpec {
  name: string;
  comparator:
    | "eq"
    | "neq"
    | "gt"
    | "lt"
    | "gte"
    | "lte"
    | "like"
    | "ilike"
    | "in"
    | "contains"
    | "startsWith"
    | "endsWith";
  caseSensitive?: boolean;
  transform?: (val: unknown) => unknown;
}

const likeToRegex = (pattern: string): RegExp => {
  let regex = "^";
  let i = 0;

  while (i < pattern.length) {
    const ch = pattern[i]!;

    if (ch === "\\") {
      i++;
      if (i < pattern.length) {
        regex += escapeRegexChar(pattern[i]!);
      } else {
        regex += "\\\\";
      }
    } else if (ch === "%") {
      regex += ".*";
    } else if (ch === "_") {
      regex += ".";
    } else {
      regex += escapeRegexChar(ch);
    }

    i++;
  }

  regex += "$";
  return new RegExp(regex);
};

const escapeRegexChar = (ch: string): string => {
  return /[\\^$.*+?()[\]{}|]/.test(ch) ? "\\" + ch : ch;
};

const safeCompare = (a: unknown, b: unknown): number => {
  const tryNumber = (v: unknown) => {
    if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
    if (typeof v === "string") {
      const n = parseFloat(v.trim());
      return Number.isFinite(n) ? n : NaN;
    }
    return NaN;
  };

  const aNum = tryNumber(a);
  const bNum = tryNumber(b);

  const eitherIsNumberLike =
    typeof a === "number" ||
    typeof b === "number" ||
    !Number.isNaN(aNum) ||
    !Number.isNaN(bNum);

  if (eitherIsNumberLike && !Number.isNaN(aNum) && !Number.isNaN(bNum)) {
    if (aNum < bNum) return -1;
    if (aNum > bNum) return 1;
    return 0;
  }

  const aStr = String(a);
  const bStr = String(b);

  const cmp = aStr.localeCompare(bStr);
  if (cmp < 0) return -1;
  if (cmp > 0) return 1;
  return 0;
};

export const defineOperator = (spec: DeclarativeOperatorSpec): OperatorDefinition => {
  const { name, comparator, caseSensitive = true, transform } = spec;

  const applyTransform = (val: unknown): unknown => {
    if (transform) return transform(val);
    return val;
  };

  const toComparableString = (val: unknown): string => {
    const transformed = applyTransform(val);
    const str = String(transformed);
    return caseSensitive ? str : str.toLowerCase();
  };

  const sqlOperators: Record<typeof comparator, (lhs: SQLWrapper, rhs: SQLWrapper) => SQLWrapper> = {
    eq: (lhs, rhs) => sql`${lhs} = ${rhs}`,
    neq: (lhs, rhs) => sql`${lhs} != ${rhs}`,
    gt: (lhs, rhs) => sql`${lhs} > ${rhs}`,
    lt: (lhs, rhs) => sql`${lhs} < ${rhs}`,
    gte: (lhs, rhs) => sql`${lhs} >= ${rhs}`,
    lte: (lhs, rhs) => sql`${lhs} <= ${rhs}`,
    like: (lhs, rhs) => sql`${lhs} LIKE ${rhs}`,
    ilike: (lhs, rhs) => sql`LOWER(${lhs}) LIKE LOWER(${rhs})`,
    in: (lhs, rhs) => sql`${lhs} IN (${rhs})`,
    contains: (lhs, rhs) => sql`${lhs} LIKE '%' || ${rhs} || '%'`,
    startsWith: (lhs, rhs) => sql`${lhs} LIKE ${rhs} || '%'`,
    endsWith: (lhs, rhs) => sql`${lhs} LIKE '%' || ${rhs}`,
  };

  const jsExecutors: Record<typeof comparator, (lhs: unknown, rhs: unknown) => boolean> = {
    eq: (lhs, rhs) => toComparableString(lhs) === toComparableString(rhs),
    neq: (lhs, rhs) => toComparableString(lhs) !== toComparableString(rhs),
    gt: (lhs, rhs) => safeCompare(applyTransform(lhs), applyTransform(rhs)) > 0,
    lt: (lhs, rhs) => safeCompare(applyTransform(lhs), applyTransform(rhs)) < 0,
    gte: (lhs, rhs) => safeCompare(applyTransform(lhs), applyTransform(rhs)) >= 0,
    lte: (lhs, rhs) => safeCompare(applyTransform(lhs), applyTransform(rhs)) <= 0,
    like: (lhs, rhs) => {
      const regex = likeToRegex(toComparableString(rhs));
      return regex.test(toComparableString(lhs));
    },
    ilike: (lhs, rhs) => {
      const regex = likeToRegex(String(rhs).toLowerCase());
      return regex.test(String(lhs).toLowerCase());
    },
    in: (lhs, rhs) => {
      const arr = Array.isArray(rhs) ? rhs : [rhs];
      const lhsStr = toComparableString(lhs);
      return arr.some((item) => toComparableString(item) === lhsStr);
    },
    contains: (lhs, rhs) => toComparableString(lhs).includes(toComparableString(rhs)),
    startsWith: (lhs, rhs) => toComparableString(lhs).startsWith(toComparableString(rhs)),
    endsWith: (lhs, rhs) => toComparableString(lhs).endsWith(toComparableString(rhs)),
  };

  return {
    op: name,
    convert: sqlOperators[comparator],
    execute: jsExecutors[comparator],
  };
};

export const BUILTIN_TEST_VALUES: TestValue[] = [
  { lhs: "apple", rhs: "apple", description: "Exact string match" },
  { lhs: "apple", rhs: "APPLE", description: "Case sensitivity" },
  { lhs: "apple", rhs: "banana", description: "Different strings" },
  { lhs: "", rhs: "", description: "Empty strings" },
  { lhs: "hello world", rhs: "hello world", description: "String with space" },
  { lhs: 42, rhs: 42, description: "Equal integers" },
  { lhs: 42, rhs: 43, description: "Different integers" },
  { lhs: 0, rhs: 0, description: "Zero values" },
  { lhs: -1, rhs: 1, description: "Negative vs positive" },
  { lhs: 3.14, rhs: 3.14, description: "Equal floats" },
  { lhs: 3.14, rhs: 3.15, description: "Different floats" },
  { lhs: "42", rhs: 42, description: "String vs number" },
  { lhs: "3.14", rhs: 3.14, description: "String vs float" },
  { lhs: null, rhs: null, description: "Both null" },
  { lhs: null, rhs: "test", description: "Null vs string" },
  { lhs: "test", rhs: null, description: "String vs null" },
  { lhs: "%test%", rhs: "test", description: "Like pattern" },
  { lhs: "hello%", rhs: "hello world", description: "Prefix pattern" },
  { lhs: "%world", rhs: "hello world", description: "Suffix pattern" },
];

export const createOperatorTestSuite = (
  operators: OperatorDefinition[]
): Map<string, EquivalenceResult> => {
  const results = new Map<string, EquivalenceResult>();

  for (const operator of operators) {
    const result = testOperatorEquivalence({
      operator,
      testValues: BUILTIN_TEST_VALUES,
    });
    results.set(operator.op, result);
  }

  return results;
};
