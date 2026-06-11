import {
  TokenSet,
  TokenStorage,
  OIDCClientConfig,
  PKCEChallenge,
} from "./types";
import { OIDCClient } from "./oidc-client";

const STORAGE_KEYS = {
  tokens: "covara_auth_tokens",
  pkce: "covara_auth_pkce",
} as const;

export class MemoryStorage implements TokenStorage {
  private data = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }

  async remove(key: string): Promise<void> {
    this.data.delete(key);
  }

  async clear(): Promise<void> {
    this.data.clear();
  }
}

export class LocalStorageAdapter implements TokenStorage {
  constructor(private prefix: string = "covara_") {}

  async get(key: string): Promise<string | null> {
    if (typeof localStorage === "undefined") return null;
    return localStorage.getItem(this.prefix + key);
  }

  async set(key: string, value: string): Promise<void> {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(this.prefix + key, value);
  }

  async remove(key: string): Promise<void> {
    if (typeof localStorage === "undefined") return;
    localStorage.removeItem(this.prefix + key);
  }

  async clear(): Promise<void> {
    if (typeof localStorage === "undefined") return;
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(this.prefix)) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach((key) => localStorage.removeItem(key));
  }
}

export class SessionStorageAdapter implements TokenStorage {
  constructor(private prefix: string = "covara_") {}

  async get(key: string): Promise<string | null> {
    if (typeof sessionStorage === "undefined") return null;
    return sessionStorage.getItem(this.prefix + key);
  }

  async set(key: string, value: string): Promise<void> {
    if (typeof sessionStorage === "undefined") return;
    sessionStorage.setItem(this.prefix + key, value);
  }

  async remove(key: string): Promise<void> {
    if (typeof sessionStorage === "undefined") return;
    sessionStorage.removeItem(this.prefix + key);
  }

  async clear(): Promise<void> {
    if (typeof sessionStorage === "undefined") return;
    const keysToRemove: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key?.startsWith(this.prefix)) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach((key) => sessionStorage.removeItem(key));
  }
}

export class TokenManager {
  private tokens: TokenSet | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshPromise: Promise<TokenSet> | null = null;
  private onRefresh?: (tokens: TokenSet) => void;
  private onError?: (error: Error) => void;

  constructor(
    private storage: TokenStorage,
    private oidcClient: OIDCClient,
    private config: OIDCClientConfig
  ) {}

  setCallbacks(
    onRefresh: (tokens: TokenSet) => void,
    onError: (error: Error) => void
  ): void {
    this.onRefresh = onRefresh;
    this.onError = onError;
  }

  async initialize(): Promise<TokenSet | null> {
    const stored = await this.storage.get(STORAGE_KEYS.tokens);
    if (stored) {
      try {
        const tokens = JSON.parse(stored) as TokenSet;
        if (this.isExpired(tokens)) {
          if (tokens.refreshToken) {
            return this.refreshTokens(tokens.refreshToken);
          }
          await this.clearTokens();
          return null;
        }
        this.tokens = tokens;
        this.scheduleRefresh();
        return tokens;
      } catch {
        await this.clearTokens();
      }
    }
    return null;
  }

  async storePKCEChallenge(challenge: PKCEChallenge): Promise<void> {
    await this.storage.set(STORAGE_KEYS.pkce, JSON.stringify(challenge));
  }

  async getPKCEChallenge(): Promise<PKCEChallenge | null> {
    const stored = await this.storage.get(STORAGE_KEYS.pkce);
    if (!stored) return null;
    try {
      return JSON.parse(stored) as PKCEChallenge;
    } catch {
      return null;
    }
  }

  async clearPKCEChallenge(): Promise<void> {
    await this.storage.remove(STORAGE_KEYS.pkce);
  }

  async setTokens(tokens: TokenSet): Promise<void> {
    this.tokens = tokens;
    await this.storage.set(STORAGE_KEYS.tokens, JSON.stringify(tokens));
    this.scheduleRefresh();
  }

  getTokens(): TokenSet | null {
    return this.tokens;
  }

  getAccessToken(): string | null {
    if (!this.tokens) return null;
    if (this.isExpired(this.tokens)) return null;
    return this.tokens.accessToken;
  }

  async clearTokens(): Promise<void> {
    this.tokens = null;
    this.cancelRefresh();
    await this.storage.remove(STORAGE_KEYS.tokens);
  }

  isExpired(tokens: TokenSet = this.tokens!): boolean {
    if (!tokens) return true;
    const bufferSeconds = this.config.refreshBufferSeconds ?? 60;
    return Date.now() >= (tokens.expiresAt - bufferSeconds) * 1000;
  }

  async refreshTokens(refreshToken?: string): Promise<TokenSet> {
    const token = refreshToken ?? this.tokens?.refreshToken;
    if (!token) {
      throw new Error("No refresh token available");
    }

    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = (async () => {
      try {
        const response = await this.oidcClient.refreshTokens(token);
        const tokens: TokenSet = {
          accessToken: response.access_token,
          refreshToken: response.refresh_token ?? token,
          idToken: response.id_token,
          expiresAt: Math.floor(Date.now() / 1000) + response.expires_in,
          scope: response.scope,
        };

        await this.setTokens(tokens);
        this.onRefresh?.(tokens);
        return tokens;
      } catch (error) {
        await this.clearTokens();
        this.onError?.(error as Error);
        throw error;
      } finally {
        this.refreshPromise = null;
      }
    })();

    return this.refreshPromise;
  }

  private scheduleRefresh(): void {
    if (!this.tokens || !this.tokens.refreshToken) return;
    if (this.config.autoRefresh === false) return;

    this.cancelRefresh();

    const bufferSeconds = this.config.refreshBufferSeconds ?? 60;
    const expiresIn = this.tokens.expiresAt - Math.floor(Date.now() / 1000);
    const refreshIn = Math.max((expiresIn - bufferSeconds) * 1000, 0);

    if (refreshIn > 0) {
      this.refreshTimer = setTimeout(() => {
        this.refreshTokens().catch(() => {});
      }, refreshIn);
    }
  }

  private cancelRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }
}

export const createTokenManager = (
  storage: TokenStorage,
  oidcClient: OIDCClient,
  config: OIDCClientConfig
): TokenManager => {
  return new TokenManager(storage, oidcClient, config);
};
