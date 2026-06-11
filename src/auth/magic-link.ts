import {
  VerificationTokenStore,
  issueToken,
  verifyToken,
} from "./verification";

export interface MagicLinkOptions {
  store: VerificationTokenStore;
  ttlMs?: number;
  hashTokens?: boolean;
  tokenLength?: number;
}

const DEFAULT_TTL_MS = 15 * 60 * 1000;

export const issueMagicLinkToken = async (
  identifier: string,
  options: MagicLinkOptions
): Promise<{ token: string; expiresAt: Date }> => {
  return issueToken(options.store, identifier, options.ttlMs ?? DEFAULT_TTL_MS, {
    hash: options.hashTokens,
    tokenLength: options.tokenLength,
  });
};

export const consumeMagicLinkToken = async (
  identifier: string,
  token: string,
  options: MagicLinkOptions
): Promise<boolean> => {
  return verifyToken(options.store, identifier, token, {
    hash: options.hashTokens,
  });
};
