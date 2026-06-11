import { ValidationError } from "@/resource/error";

export interface PasswordPolicyOptions {
  minLength?: number;
  maxLength?: number;
  requireUppercase?: boolean;
  requireLowercase?: boolean;
  requireNumber?: boolean;
  requireSymbol?: boolean;
  denylist?: string[];
  useBuiltInDenylist?: boolean;
}

const BUILT_IN_DENYLIST = [
  "password",
  "password1",
  "123456",
  "12345678",
  "123456789",
  "qwerty",
  "abc123",
  "111111",
  "letmein",
  "iloveyou",
  "admin",
  "welcome",
  "monkey",
  "dragon",
  "sunshine",
  "princess",
  "football",
  "654321",
  "passw0rd",
  "changeme",
];

const DEFAULTS = {
  minLength: 8,
  requireUppercase: false,
  requireLowercase: false,
  requireNumber: false,
  requireSymbol: false,
  useBuiltInDenylist: true,
} as const;

export interface PasswordStrengthResult {
  valid: boolean;
  errors: string[];
}

export const validatePasswordStrength = (
  password: string,
  options: PasswordPolicyOptions = {}
): PasswordStrengthResult => {
  const errors: string[] = [];
  const minLength = options.minLength ?? DEFAULTS.minLength;

  if (typeof password !== "string" || password.length < minLength) {
    errors.push(`Password must be at least ${minLength} characters long`);
  }

  if (options.maxLength !== undefined && password.length > options.maxLength) {
    errors.push(`Password must be at most ${options.maxLength} characters long`);
  }

  if (options.requireUppercase && !/[A-Z]/.test(password)) {
    errors.push("Password must contain an uppercase letter");
  }

  if (options.requireLowercase && !/[a-z]/.test(password)) {
    errors.push("Password must contain a lowercase letter");
  }

  if (options.requireNumber && !/[0-9]/.test(password)) {
    errors.push("Password must contain a number");
  }

  if (options.requireSymbol && !/[^A-Za-z0-9]/.test(password)) {
    errors.push("Password must contain a symbol");
  }

  const useBuiltIn = options.useBuiltInDenylist ?? DEFAULTS.useBuiltInDenylist;
  const denylist = [
    ...(useBuiltIn ? BUILT_IN_DENYLIST : []),
    ...(options.denylist ?? []),
  ];
  if (denylist.some((entry) => entry.toLowerCase() === password.toLowerCase())) {
    errors.push("Password is too common");
  }

  return { valid: errors.length === 0, errors };
};

export const enforcePasswordStrength = (
  password: string,
  options: PasswordPolicyOptions = {}
): void => {
  const result = validatePasswordStrength(password, options);
  if (!result.valid) {
    throw new ValidationError("Password does not meet requirements", {
      errors: result.errors.map((message) => ({ field: "password", message })),
    });
  }
};

export const builtInPasswordDenylist = (): string[] => [...BUILT_IN_DENYLIST];
