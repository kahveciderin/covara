import { SearchAdapter } from "./types";

let globalSearchAdapter: SearchAdapter | null = null;

export const setGlobalSearch = (adapter: SearchAdapter): void => {
  globalSearchAdapter = adapter;
};

export const getGlobalSearch = (): SearchAdapter => {
  if (!globalSearchAdapter) {
    throw new Error(
      "No global search adapter configured. Call setGlobalSearch() first."
    );
  }
  return globalSearchAdapter;
};

export const hasGlobalSearch = (): boolean => {
  return globalSearchAdapter !== null;
};

export const clearGlobalSearch = (): void => {
  globalSearchAdapter = null;
};

export * from "./types";
export * from "./memory";
export * from "./opensearch";
export * from "./sqlite-fts";
export * from "./postgres-fts";
