import { createHash, randomBytes } from "node:crypto";
import { ValidationError } from "./error";

export interface DryRunResult<T = unknown> {
  count: number;
  sampleIds: string[];
  sampleItems?: T[];
  confirmToken: string;
  message: string;
  operation: BatchOperation;
  filter?: string;
  expiresAt: number;
}

export type BatchOperation = "batch_update" | "batch_delete" | "batch_create";

export interface ConfirmTokenPayload {
  operation: BatchOperation;
  filter?: string;
  affectedIds: string[];
  timestamp: number;
  signature: string;
  expiresAt: number;
}

const SECRET_KEY = process.env.COVARA_BATCH_SECRET || randomBytes(32).toString("hex");
const TOKEN_EXPIRY_MS = 5 * 60 * 1000;

const sign = (data: string): string => {
  return createHash("sha256")
    .update(data + SECRET_KEY)
    .digest("hex")
    .slice(0, 16);
};

export const generateConfirmToken = (
  operation: BatchOperation,
  filter: string | undefined,
  affectedIds: string[]
): string => {
  const timestamp = Date.now();
  const expiresAt = timestamp + TOKEN_EXPIRY_MS;

  const payload: Omit<ConfirmTokenPayload, "signature"> = {
    operation,
    filter,
    affectedIds,
    timestamp,
    expiresAt,
  };

  const dataToSign = JSON.stringify(payload);
  const signature = sign(dataToSign);

  const fullPayload: ConfirmTokenPayload = {
    ...payload,
    signature,
  };

  return Buffer.from(JSON.stringify(fullPayload)).toString("base64url");
};

export interface TokenValidationResult {
  valid: boolean;
  error?: "expired" | "invalid_signature" | "malformed" | "filter_mismatch" | "operation_mismatch";
  payload?: ConfirmTokenPayload;
}

export const validateConfirmToken = (
  token: string,
  expectedOperation: BatchOperation,
  expectedFilter?: string
): TokenValidationResult => {
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf-8");
    const payload = JSON.parse(decoded) as ConfirmTokenPayload;

    if (!payload.operation || !payload.timestamp || !payload.signature) {
      return { valid: false, error: "malformed" };
    }

    if (payload.expiresAt < Date.now()) {
      return { valid: false, error: "expired" };
    }

    const { signature, ...payloadWithoutSignature } = payload;
    const expectedSignature = sign(JSON.stringify(payloadWithoutSignature));

    if (signature !== expectedSignature) {
      return { valid: false, error: "invalid_signature" };
    }

    if (payload.operation !== expectedOperation) {
      return { valid: false, error: "operation_mismatch" };
    }

    const normalizeFilter = (f: string | undefined) => (f ?? "").trim();
    if (normalizeFilter(payload.filter) !== normalizeFilter(expectedFilter)) {
      return { valid: false, error: "filter_mismatch" };
    }

    return { valid: true, payload };
  } catch {
    return { valid: false, error: "malformed" };
  }
};

export const createDryRunResult = <T>(
  operation: BatchOperation,
  filter: string | undefined,
  affectedItems: T[],
  idExtractor: (item: T) => string,
  sampleSize: number = 10
): DryRunResult<T> => {
  const affectedIds = affectedItems.map(idExtractor);
  const confirmToken = generateConfirmToken(operation, filter, affectedIds);
  const expiresAt = Date.now() + TOKEN_EXPIRY_MS;

  return {
    count: affectedItems.length,
    sampleIds: affectedIds.slice(0, sampleSize),
    sampleItems: affectedItems.slice(0, sampleSize),
    confirmToken,
    message: `This operation will affect ${affectedItems.length} records. Send confirmToken header to execute.`,
    operation,
    filter,
    expiresAt,
  };
};

export interface BatchGuardConfig {
  requireConfirmation?: boolean;
  allowDangerousHeader?: boolean;
  maxAffectedRecords?: number;
}

const DEFAULT_BATCH_GUARD_CONFIG: BatchGuardConfig = {
  requireConfirmation: true,
  allowDangerousHeader: true,
  maxAffectedRecords: 1000,
};

export const checkBatchGuard = (
  confirmToken: string | undefined,
  dangerousHeader: boolean,
  affectedCount: number,
  config: BatchGuardConfig = DEFAULT_BATCH_GUARD_CONFIG
): void => {
  const { requireConfirmation, allowDangerousHeader, maxAffectedRecords } = {
    ...DEFAULT_BATCH_GUARD_CONFIG,
    ...config,
  };

  if (maxAffectedRecords && affectedCount > maxAffectedRecords) {
    throw new ValidationError(
      `Batch operation affects too many records (${affectedCount})`,
      {
        affectedCount,
        maxAllowed: maxAffectedRecords,
        suggestion: "Use a more specific filter or increase the limit",
      }
    );
  }

  if (!requireConfirmation) {
    return;
  }

  if (confirmToken) {
    return;
  }

  if (allowDangerousHeader && dangerousHeader) {
    console.warn(
      JSON.stringify({
        level: "warn",
        type: "dangerous_batch_operation",
        affectedCount,
        timestamp: new Date().toISOString(),
      })
    );
    return;
  }

  throw new ValidationError(
    "Batch operations with filters require dry-run first",
    {
      suggestion:
        "Send request with ?dryRun=true first, then use the confirmToken header",
      alternative: "Send X-Dangerous-Operation: true header to skip (dangerous)",
    }
  );
};

export const validateBatchOperation = (
  operation: BatchOperation,
  filter: string | undefined,
  confirmToken: string | undefined,
  dangerousHeader: boolean
): { requiresDryRun: boolean; validatedPayload?: ConfirmTokenPayload } => {
  if (!filter) {
    return { requiresDryRun: false };
  }

  if (dangerousHeader) {
    console.warn(
      JSON.stringify({
        level: "warn",
        type: "dangerous_batch_bypass",
        operation,
        filter,
        timestamp: new Date().toISOString(),
      })
    );
    return { requiresDryRun: false };
  }

  if (!confirmToken) {
    return { requiresDryRun: true };
  }

  const validation = validateConfirmToken(confirmToken, operation, filter);

  if (!validation.valid) {
    const errorMessages: Record<NonNullable<typeof validation.error>, string> = {
      expired: "Confirm token has expired. Please run dry-run again.",
      invalid_signature: "Confirm token signature is invalid.",
      malformed: "Confirm token is malformed.",
      filter_mismatch: "Filter has changed since dry-run. Please run dry-run again.",
      operation_mismatch: "Operation does not match the confirm token.",
    };

    throw new ValidationError(
      errorMessages[validation.error!] ?? "Invalid confirm token",
      {
        error: validation.error,
        suggestion: "Run the operation with ?dryRun=true first",
      }
    );
  }

  return { requiresDryRun: false, validatedPayload: validation.payload };
};

export const CONFIRM_TOKEN_HEADER = "x-confirm-token";
export const DANGEROUS_OPERATION_HEADER = "x-dangerous-operation";
