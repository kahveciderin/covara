import type { CovaraClient } from "./types";

let globalClient: CovaraClient | null = null;
let globalAuthErrorHandler: (() => void) | null = null;

export const getClient = (): CovaraClient => {
  // Check globalThis first for HMR stability
  if (typeof globalThis !== "undefined" && (globalThis as Record<string, unknown>).__covaraClient) {
    return (globalThis as Record<string, unknown>).__covaraClient as CovaraClient;
  }
  if (!globalClient) {
    throw new Error("Covara client not initialized. Call createClient() first.");
  }
  return globalClient;
};

export const setGlobalClient = (client: CovaraClient): void => {
  globalClient = client;
  if (typeof globalThis !== "undefined") {
    (globalThis as Record<string, unknown>).__covaraClient = client;
  }
};

export const getAuthErrorHandler = (): (() => void) | null => globalAuthErrorHandler;

export const setAuthErrorHandler = (handler: () => void): void => {
  globalAuthErrorHandler = handler;
};
