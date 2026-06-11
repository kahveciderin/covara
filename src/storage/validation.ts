import { ValidationError } from "@/resource/error";

export interface UploadValidationOptions {
  maxSize?: number;
  allowedTypes?: string[];
  blockedTypes?: string[];
}

export interface UploadValidationInput {
  contentType?: string;
  size?: number;
}

const matchesPattern = (contentType: string, pattern: string): boolean => {
  if (pattern === contentType) return true;
  if (pattern.endsWith("/*")) {
    const prefix = pattern.slice(0, -1);
    return contentType.startsWith(prefix);
  }
  return false;
};

const matchesAny = (contentType: string, patterns: string[]): boolean => {
  return patterns.some((pattern) => matchesPattern(contentType, pattern));
};

export const validateUpload = (
  input: UploadValidationInput,
  options: UploadValidationOptions
): void => {
  const { contentType, size } = input;
  const { maxSize, allowedTypes, blockedTypes } = options;

  if (typeof maxSize === "number" && typeof size === "number" && size > maxSize) {
    throw new ValidationError(
      `File too large. Maximum size: ${maxSize} bytes`,
      { maxSize, size }
    );
  }

  const normalizedType = contentType?.split(";")[0].trim().toLowerCase();

  if (blockedTypes && blockedTypes.length > 0) {
    if (!normalizedType) {
      throw new ValidationError("Content type is required", { blockedTypes });
    }
    if (matchesAny(normalizedType, blockedTypes.map((t) => t.toLowerCase()))) {
      throw new ValidationError(
        `File type not allowed: ${normalizedType}`,
        { contentType: normalizedType, blockedTypes }
      );
    }
  }

  if (allowedTypes && allowedTypes.length > 0) {
    if (!normalizedType) {
      throw new ValidationError("Content type is required", { allowedTypes });
    }
    if (!matchesAny(normalizedType, allowedTypes.map((t) => t.toLowerCase()))) {
      throw new ValidationError(
        `File type not allowed. Allowed types: ${allowedTypes.join(", ")}`,
        { contentType: normalizedType, allowedTypes }
      );
    }
  }
};
