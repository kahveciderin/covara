import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  createJWTClient,
  JWTClient,
  JWTClientConfig,
  JWTAuthState,
  JWTUser,
  JWTTokens,
} from "./jwt";

let globalJWTClient: JWTClient | null = null;

export const getJWTClient = (): JWTClient => {
  if (!globalJWTClient) {
    throw new Error("JWT client not initialized. Call createJWTClient first.");
  }
  return globalJWTClient;
};

export const initJWTClient = (config: JWTClientConfig): JWTClient => {
  if (typeof globalThis !== "undefined" && (globalThis as Record<string, unknown>).__covaraJWTClient) {
    return (globalThis as Record<string, unknown>).__covaraJWTClient as JWTClient;
  }
  globalJWTClient = createJWTClient(config);
  if (typeof globalThis !== "undefined") {
    (globalThis as Record<string, unknown>).__covaraJWTClient = globalJWTClient;
  }
  return globalJWTClient;
};

export interface UseJWTAuthResult<TUser = JWTUser> {
  user: TUser | null;
  accessToken: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<JWTTokens>;
  signup: (email: string, password: string, name?: string) => Promise<JWTTokens & { user: TUser }>;
  logout: () => Promise<void>;
  refresh: () => Promise<JWTTokens>;
}

export function useJWTAuth<TUser = JWTUser>(): UseJWTAuthResult<TUser> {
  const client = useMemo(() => getJWTClient(), []);
  const [state, setState] = useState<JWTAuthState>(client.getState());
  const [isLoading, setIsLoading] = useState(true);
  const initializedRef = useRef(false);

  useEffect(() => {
    const unsubscribe = client.subscribe(setState);

    if (!initializedRef.current) {
      initializedRef.current = true;
      if (state.accessToken) {
        client.getUser().finally(() => setIsLoading(false));
      } else {
        setIsLoading(false);
      }
    }

    return unsubscribe;
  }, [client, state.accessToken]);

  const login = useCallback(
    async (email: string, password: string) => {
      setIsLoading(true);
      try {
        return await client.login(email, password);
      } finally {
        setIsLoading(false);
      }
    },
    [client]
  );

  const signup = useCallback(
    async (email: string, password: string, name?: string) => {
      setIsLoading(true);
      try {
        return await client.signup(email, password, name) as JWTTokens & { user: TUser };
      } finally {
        setIsLoading(false);
      }
    },
    [client]
  );

  const logout = useCallback(async () => {
    await client.logout();
  }, [client]);

  const refresh = useCallback(async () => {
    return await client.refresh();
  }, [client]);

  return {
    user: state.user as TUser | null,
    accessToken: state.accessToken,
    isAuthenticated: state.isAuthenticated,
    isLoading,
    login,
    signup,
    logout,
    refresh,
  };
}
