import { hashPassword } from "./password";
import {
  VerificationTokenStore,
  issueToken,
  verifyToken,
} from "./verification";

export interface PasswordResetOptions {
  store: VerificationTokenStore;
  ttlMs?: number;
  hashTokens?: boolean;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000;

export const issuePasswordResetToken = async (
  identifier: string,
  options: PasswordResetOptions
): Promise<{ token: string; expiresAt: Date }> => {
  return issueToken(options.store, identifier, options.ttlMs ?? DEFAULT_TTL_MS, {
    hash: options.hashTokens,
  });
};

export const verifyPasswordResetToken = async (
  identifier: string,
  token: string,
  options: PasswordResetOptions
): Promise<boolean> => {
  return verifyToken(options.store, identifier, token, {
    hash: options.hashTokens,
  });
};

export const hashNewPassword = async (password: string): Promise<string> => {
  return hashPassword(password);
};
