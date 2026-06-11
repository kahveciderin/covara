export interface JWTClientConfig {
  baseUrl: string;
  authPath?: string;
  storage?: TokenStorage;
  onAuthChange?: (authenticated: boolean) => void;
}

export interface TokenStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export class MemoryTokenStorage implements TokenStorage {
  private store = new Map<string, string>();
  get(key: string) { return this.store.get(key) ?? null; }
  set(key: string, value: string) { this.store.set(key, value); }
  remove(key: string) { this.store.delete(key); }
}

/**
 * LocalStorage-based token storage. Only works in browser environments.
 * For React Native, use a custom TokenStorage implementation with AsyncStorage
 * or use MemoryTokenStorage for testing.
 */
export class LocalStorageTokenStorage implements TokenStorage {
  constructor(private prefix = "covara_jwt_") {
    if (typeof localStorage === "undefined") {
      console.warn(
        "LocalStorageTokenStorage: localStorage is not available. " +
        "Use MemoryTokenStorage or provide a custom TokenStorage implementation for React Native."
      );
    }
  }

  private getStorage(): Storage | null {
    return typeof localStorage !== "undefined" ? localStorage : null;
  }

  get(key: string) {
    return this.getStorage()?.getItem(this.prefix + key) ?? null;
  }

  set(key: string, value: string) {
    this.getStorage()?.setItem(this.prefix + key, value);
  }

  remove(key: string) {
    this.getStorage()?.removeItem(this.prefix + key);
  }
}

export interface JWTTokens {
  accessToken: string;
  expiresIn: number;
  tokenType: string;
}

export interface JWTUser {
  id: string;
  email?: string | null;
  name?: string | null;
  image?: string | null;
}

export interface JWTAuthState {
  accessToken: string | null;
  expiresAt: Date | null;
  user: JWTUser | null;
  isAuthenticated: boolean;
}

export interface JWTClient {
  getState(): JWTAuthState;
  getAccessToken(): string | null;
  isAuthenticated(): boolean;
  login(email: string, password: string): Promise<JWTTokens>;
  signup(email: string, password: string, name?: string): Promise<JWTTokens & { user: JWTUser }>;
  refresh(): Promise<JWTTokens>;
  logout(): Promise<void>;
  getUser(): Promise<JWTUser | null>;
  subscribe(listener: (state: JWTAuthState) => void): () => void;
}

export const createJWTClient = (config: JWTClientConfig): JWTClient => {
  const {
    baseUrl,
    authPath = "/api/auth",
    storage = typeof localStorage !== "undefined"
      ? new LocalStorageTokenStorage()
      : new MemoryTokenStorage(),
    onAuthChange,
  } = config;

  const listeners = new Set<(state: JWTAuthState) => void>();
  let currentState: JWTAuthState = {
    accessToken: storage.get("accessToken"),
    expiresAt: storage.get("expiresAt") ? new Date(storage.get("expiresAt")!) : null,
    user: storage.get("user") ? JSON.parse(storage.get("user")!) : null,
    isAuthenticated: !!storage.get("accessToken"),
  };

  const notify = () => {
    listeners.forEach((l) => l(currentState));
    onAuthChange?.(currentState.isAuthenticated);
  };

  const setState = (updates: Partial<JWTAuthState>) => {
    const wasAuthenticated = currentState.isAuthenticated;
    currentState = { ...currentState, ...updates };

    if (updates.accessToken !== undefined) {
      if (updates.accessToken) {
        storage.set("accessToken", updates.accessToken);
      } else {
        storage.remove("accessToken");
      }
    }
    if (updates.expiresAt !== undefined) {
      if (updates.expiresAt) {
        storage.set("expiresAt", updates.expiresAt.toISOString());
      } else {
        storage.remove("expiresAt");
      }
    }
    if (updates.user !== undefined) {
      if (updates.user) {
        storage.set("user", JSON.stringify(updates.user));
      } else {
        storage.remove("user");
      }
    }

    if (wasAuthenticated !== currentState.isAuthenticated) {
      notify();
    }
  };

  const request = async <T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> => {
    const response = await fetch(`${baseUrl}${authPath}${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      credentials: "include",
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error?.message ?? "Request failed");
    }

    return data;
  };

  const handleTokenResponse = (tokens: JWTTokens) => {
    const expiresAt = new Date(Date.now() + tokens.expiresIn * 1000);
    setState({
      accessToken: tokens.accessToken,
      expiresAt,
      isAuthenticated: true,
    });
  };

  return {
    getState: () => currentState,

    getAccessToken: () => currentState.accessToken,

    isAuthenticated: () => currentState.isAuthenticated,

    async login(email: string, password: string) {
      const tokens = await request<JWTTokens>("POST", "/login", { email, password });
      handleTokenResponse(tokens);
      const user = await this.getUser();
      setState({ user });
      return tokens;
    },

    async signup(email: string, password: string, name?: string) {
      const result = await request<JWTTokens & { user: JWTUser }>("POST", "/signup", {
        email,
        password,
        name,
      });
      handleTokenResponse(result);
      setState({ user: result.user });
      return result;
    },

    async refresh() {
      const tokens = await request<JWTTokens>("POST", "/refresh", {});
      handleTokenResponse(tokens);
      return tokens;
    },

    async logout() {
      try {
        await request("POST", "/logout", {});
      } catch {
        // Ignore logout errors
      }
      setState({
        accessToken: null,
        expiresAt: null,
        user: null,
        isAuthenticated: false,
      });
    },

    async getUser() {
      if (!currentState.accessToken) return null;
      try {
        const { user } = await fetch(`${baseUrl}${authPath}/me`, {
          headers: { Authorization: `Bearer ${currentState.accessToken}` },
        }).then((r) => r.json());
        if (user) {
          setState({ user });
        }
        return user;
      } catch {
        return null;
      }
    },

    subscribe(listener: (state: JWTAuthState) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};
