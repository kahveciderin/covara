import {
  OIDCClientConfig,
  AuthState,
  OIDCUserInfo,
  TokenSet,
  AuthEventListener,
  AuthManagerEvents,
} from "./types";
import { OIDCClient, createOIDCClient } from "./oidc-client";
import {
  TokenManager,
  MemoryStorage,
  createTokenManager,
} from "./token-manager";
import { AuthTransport, createAuthTransport } from "./auth-transport";

export class AuthManager {
  private oidcClient: OIDCClient | null = null;
  private tokenManager: TokenManager | null = null;
  private authTransport: AuthTransport | null = null;
  private config: OIDCClientConfig | null = null;
  private state: AuthState = {
    status: "initializing",
    user: null,
    isAuthenticated: false,
    error: null,
    accessToken: null,
  };
  private listeners = new Map<keyof AuthManagerEvents, Set<AuthEventListener<keyof AuthManagerEvents>>>();

  configure(config: OIDCClientConfig): void {
    this.config = config;
    this.oidcClient = createOIDCClient(config);

    const storage = config.storage ?? new MemoryStorage();
    this.tokenManager = createTokenManager(storage, this.oidcClient, config);

    this.tokenManager.setCallbacks(
      (tokens) => this.handleTokenRefresh(tokens),
      (error) => this.handleError(error)
    );

    this.authTransport = createAuthTransport(this.tokenManager, {
      onUnauthorized: () => this.handleUnauthorized(),
    });

    this.updateState({ status: "unauthenticated" });
  }

  async initialize(): Promise<AuthState> {
    if (!this.tokenManager || !this.oidcClient) {
      throw new Error("Auth not configured. Call configure() first.");
    }

    try {
      const tokens = await this.tokenManager.initialize();
      if (tokens) {
        const user = await this.fetchUserInfo(tokens.accessToken);
        this.updateState({
          status: "authenticated",
          user,
          isAuthenticated: true,
          accessToken: tokens.accessToken,
        });
      } else {
        this.updateState({ status: "unauthenticated" });
      }
    } catch (error) {
      this.updateState({
        status: "error",
        error: error as Error,
      });
    }

    return this.state;
  }

  /**
   * Build the authorization URL without redirecting. Useful for React Native
   * where you need to handle navigation differently (e.g., using Linking or WebBrowser).
   */
  async getAuthorizationUrl(options?: { prompt?: "none" | "login" | "consent" }): Promise<string> {
    if (!this.oidcClient || !this.tokenManager) {
      throw new Error("Auth not configured. Call configure() first.");
    }

    const challenge = await this.oidcClient.generatePKCEChallenge();
    await this.tokenManager.storePKCEChallenge(challenge);

    const authUrl = await this.oidcClient.buildAuthorizationUrl(challenge);
    return options?.prompt ? `${authUrl}&prompt=${options.prompt}` : authUrl;
  }

  async login(options?: { prompt?: "none" | "login" | "consent" }): Promise<void> {
    if (!this.oidcClient || !this.tokenManager || !this.config) {
      throw new Error("Auth not configured. Call configure() first.");
    }

    this.updateState({ status: "authenticating" });

    try {
      const finalUrl = await this.getAuthorizationUrl(options);

      if (this.config.flowType === "popup") {
        await this.loginWithPopup(finalUrl);
      } else {
        // Browser redirect flow
        if (typeof window !== "undefined" && "location" in window) {
          window.location.href = finalUrl;
        } else {
          throw new Error(
            "Browser redirect not available. Use getAuthorizationUrl() for React Native " +
            "and handle navigation with Linking or expo-web-browser."
          );
        }
      }
    } catch (error) {
      this.updateState({
        status: "error",
        error: error as Error,
      });
      throw error;
    }
  }

  private async loginWithPopup(authUrl: string): Promise<void> {
    // Popup flow only works in browser environments
    if (typeof window === "undefined" || typeof window.open !== "function") {
      throw new Error(
        "Popup login is not available in this environment. " +
        "Use getAuthorizationUrl() for React Native."
      );
    }

    return new Promise((resolve, reject) => {
      const width = 500;
      const height = 600;
      const left = (window.screenX ?? 0) + ((window.outerWidth ?? 800) - width) / 2;
      const top = (window.screenY ?? 0) + ((window.outerHeight ?? 600) - height) / 2;

      const popup = window.open(
        authUrl,
        "oidc-login",
        `width=${width},height=${height},left=${left},top=${top}`
      );

      if (!popup) {
        reject(new Error("Failed to open popup window"));
        return;
      }

      const checkClosed = setInterval(() => {
        if (popup.closed) {
          clearInterval(checkClosed);
          this.updateState({ status: "unauthenticated" });
          reject(new Error("Popup closed by user"));
        }
      }, 500);

      const messageHandler = async (event: MessageEvent) => {
        if (event.origin !== window.location.origin) return;
        if (event.data?.type !== "oidc-callback") return;

        clearInterval(checkClosed);
        window.removeEventListener("message", messageHandler);
        popup.close();

        if (event.data.error) {
          reject(new Error(event.data.errorDescription ?? event.data.error));
        } else {
          try {
            await this.handleCallback(event.data.url);
            resolve();
          } catch (error) {
            reject(error);
          }
        }
      };

      window.addEventListener("message", messageHandler);
    });
  }

  async handleCallback(callbackUrl?: string): Promise<AuthState> {
    if (!this.oidcClient || !this.tokenManager) {
      throw new Error("Auth not configured. Call configure() first.");
    }

    let url = callbackUrl;
    if (!url) {
      if (typeof window !== "undefined" && "location" in window) {
        url = window.location.href;
      } else {
        throw new Error(
          "callbackUrl is required in non-browser environments. " +
          "Pass the callback URL from your deep link handler."
        );
      }
    }
    const params = this.oidcClient.parseCallbackParams(url);

    if (params.error) {
      const error = new Error(params.errorDescription ?? params.error);
      this.updateState({
        status: "error",
        error,
      });
      throw error;
    }

    if (!params.code) {
      throw new Error("No authorization code in callback");
    }

    const challenge = await this.tokenManager.getPKCEChallenge();
    if (!challenge) {
      throw new Error("No PKCE challenge found");
    }

    if (challenge.state !== params.state) {
      throw new Error("State mismatch - possible CSRF attack");
    }

    try {
      const tokenResponse = await this.oidcClient.exchangeCodeForTokens(
        params.code,
        challenge.codeVerifier
      );

      const tokens: TokenSet = {
        accessToken: tokenResponse.access_token,
        refreshToken: tokenResponse.refresh_token,
        idToken: tokenResponse.id_token,
        expiresAt: Math.floor(Date.now() / 1000) + tokenResponse.expires_in,
        scope: tokenResponse.scope,
      };

      await this.tokenManager.setTokens(tokens);
      await this.tokenManager.clearPKCEChallenge();

      const user = await this.fetchUserInfo(tokens.accessToken);

      this.updateState({
        status: "authenticated",
        user,
        isAuthenticated: true,
        accessToken: tokens.accessToken,
      });

      // Clean up URL in browser environments (remove auth params)
      if (typeof window !== "undefined" && !callbackUrl && "history" in window && "location" in window) {
        try {
          const cleanUrl = window.location.origin + window.location.pathname;
          const title = typeof document !== "undefined" ? document.title : "";
          window.history.replaceState({}, title, cleanUrl);
        } catch {
          // Ignore errors - URL cleanup is not critical
        }
      }

      return this.state;
    } catch (error) {
      this.updateState({
        status: "error",
        error: error as Error,
      });
      throw error;
    }
  }

  /**
   * Build the logout URL without redirecting. Useful for React Native
   * where you need to handle navigation differently.
   */
  async getLogoutUrl(): Promise<string | null> {
    if (!this.oidcClient || !this.tokenManager) {
      return null;
    }

    const idToken = this.tokenManager.getTokens()?.idToken;
    if (!idToken) return null;

    try {
      return await this.oidcClient.buildLogoutUrl(idToken);
    } catch {
      return null;
    }
  }

  async logout(options?: { localOnly?: boolean }): Promise<void> {
    if (!this.tokenManager) {
      throw new Error("Auth not configured. Call configure() first.");
    }

    const idToken = this.tokenManager.getTokens()?.idToken;
    await this.tokenManager.clearTokens();

    this.updateState({
      status: "unauthenticated",
      user: null,
      isAuthenticated: false,
      accessToken: null,
    });

    this.emit("loggedOut");

    if (!options?.localOnly && this.oidcClient && idToken) {
      try {
        const logoutUrl = await this.oidcClient.buildLogoutUrl(idToken);
        // Only redirect in browser environments
        if (typeof window !== "undefined" && "location" in window) {
          window.location.href = logoutUrl;
        }
        // In React Native, use getLogoutUrl() and handle with Linking
      } catch {
        // Ignore logout URL errors - local logout succeeded
      }
    }
  }

  async refreshTokens(): Promise<TokenSet> {
    if (!this.tokenManager) {
      throw new Error("Auth not configured. Call configure() first.");
    }

    const tokens = await this.tokenManager.refreshTokens();
    return tokens;
  }

  getState(): AuthState {
    return { ...this.state };
  }

  getAccessToken(): string | null {
    return this.tokenManager?.getAccessToken() ?? null;
  }

  getUser(): OIDCUserInfo | null {
    return this.state.user;
  }

  isAuthenticated(): boolean {
    return this.state.isAuthenticated;
  }

  getTransport(): AuthTransport | null {
    return this.authTransport;
  }

  subscribe(callback: (state: AuthState) => void): () => void {
    return this.on("stateChanged", callback);
  }

  on<K extends keyof AuthManagerEvents>(
    event: K,
    listener: AuthEventListener<K>
  ): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    const listeners = this.listeners.get(event) as Set<AuthEventListener<K>>;
    listeners.add(listener);

    return () => {
      listeners.delete(listener);
    };
  }

  private emit<K extends keyof AuthManagerEvents>(
    event: K,
    ...args: Parameters<AuthManagerEvents[K]>
  ): void {
    const listeners = this.listeners.get(event);
    if (listeners) {
      for (const listener of listeners) {
        try {
          (listener as (...args: unknown[]) => void)(...args);
        } catch (error) {
          console.error(`Error in auth event listener:`, error);
        }
      }
    }
  }

  private async fetchUserInfo(accessToken: string): Promise<OIDCUserInfo> {
    if (!this.oidcClient) {
      throw new Error("OIDC client not initialized");
    }

    const userInfo = await this.oidcClient.fetchUserInfo(accessToken);
    return userInfo as OIDCUserInfo;
  }

  private updateState(updates: Partial<AuthState>): void {
    this.state = { ...this.state, ...updates };
    this.emit("stateChanged", this.state);
  }

  private handleTokenRefresh(tokens: TokenSet): void {
    this.updateState({
      accessToken: tokens.accessToken,
    });
    this.emit("tokenRefreshed", tokens);
  }

  private handleError(error: Error): void {
    this.updateState({
      status: "error",
      error,
    });
    this.emit("error", error);
  }

  private handleUnauthorized(): void {
    this.updateState({
      status: "unauthenticated",
      user: null,
      isAuthenticated: false,
      accessToken: null,
    });
  }
}

export const createAuthManager = (): AuthManager => {
  return new AuthManager();
};

export {
  OIDCClient,
  createOIDCClient,
} from "./oidc-client";

export {
  TokenManager,
  MemoryStorage,
  LocalStorageAdapter,
  SessionStorageAdapter,
  createTokenManager,
} from "./token-manager";

export {
  AuthTransport,
  createAuthTransport,
} from "./auth-transport";

export type {
  OIDCClientConfig,
  TokenSet,
  OIDCUserInfo,
  AuthState,
  AuthStatus,
  TokenStorage,
  OIDCDiscoveryResponse,
  TokenResponse,
  PKCEChallenge,
  AuthCallbackParams,
  AuthManagerEvents,
} from "./types";
