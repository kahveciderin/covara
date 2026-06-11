import type { ResourceClient, ProcedureDef, AnyProcedures } from "./types";
import type { InvalidateTarget } from "./query-cache";

export type MutationStatus = "idle" | "loading" | "success" | "error";

export interface MutationFnContext<T extends { id: string }> {
  resource: ResourceClient<T>;
  invalidate: (target: InvalidateTarget) => void;
}

export type MutationFn<TVars, TData, T extends { id: string }> = (
  vars: TVars,
  ctx: MutationFnContext<T>
) => Promise<TData>;

export interface MutationOptions<TVars, TData> {
  onSuccess?: (data: TData, vars: TVars) => void;
  onError?: (error: Error, vars: TVars) => void;
  onSettled?: (data: TData | undefined, error: Error | null, vars: TVars) => void;
  /** Query paths/predicates to invalidate after a successful mutation. */
  invalidates?: InvalidateTarget[];
}

export interface MutationState<TData> {
  status: MutationStatus;
  error: Error | null;
  data: TData | undefined;
}

export interface MutationController<TVars, TData> {
  getSnapshot: () => MutationState<TData>;
  subscribe: (listener: () => void) => () => void;
  mutate: (vars: TVars) => void;
  mutateAsync: (vars: TVars) => Promise<TData>;
  reset: () => void;
}

export interface CreateMutationConfig<TVars, TData, T extends { id: string }> {
  resource: ResourceClient<T>;
  fn: MutationFn<TVars, TData, T>;
  invalidate: (target: InvalidateTarget) => void;
  options?: MutationOptions<TVars, TData>;
}

/**
 * Framework-agnostic mutation controller. Tracks status/error/data, runs the
 * mutation function with an invalidation-aware context, and fires
 * onSuccess/onError/onSettled plus any configured `invalidates` targets.
 */
export const createMutation = <TVars, TData, T extends { id: string }>(
  config: CreateMutationConfig<TVars, TData, T>
): MutationController<TVars, TData> => {
  const listeners = new Set<() => void>();
  let snapshot: MutationState<TData> = { status: "idle", error: null, data: undefined };

  const set = (next: MutationState<TData>) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };

  const ctx: MutationFnContext<T> = {
    resource: config.resource,
    invalidate: config.invalidate,
  };

  const mutateAsync = async (vars: TVars): Promise<TData> => {
    set({ status: "loading", error: null, data: undefined });
    try {
      const data = await config.fn(vars, ctx);
      set({ status: "success", error: null, data });
      for (const target of config.options?.invalidates ?? []) {
        config.invalidate(target);
      }
      config.options?.onSuccess?.(data, vars);
      config.options?.onSettled?.(data, null, vars);
      return data;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      set({ status: "error", error, data: undefined });
      config.options?.onError?.(error, vars);
      config.options?.onSettled?.(undefined, error, vars);
      throw error;
    }
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    mutate: (vars) => {
      void mutateAsync(vars).catch(() => {
        // Swallowed: error is surfaced via state/onError. mutateAsync rejects for callers who await.
      });
    },
    mutateAsync,
    reset: () => set({ status: "idle", error: null, data: undefined }),
  };
};

export type ResourceMutationKind = "create" | "update" | "replace" | "delete";

export type ResourceMutationVars<T extends { id: string }> =
  | { kind: "create"; data: Partial<Omit<T, "id">> }
  | { kind: "update"; id: string; data: Partial<T> }
  | { kind: "replace"; id: string; data: Omit<T, "id"> }
  | { kind: "delete"; id: string };

/**
 * Build the default mutation function for a resource, dispatching to
 * create/update/replace/delete. Used by `useMutation(resource)`.
 */
export const resourceMutationFn = <
  T extends { id: string },
  P extends Record<keyof P, ProcedureDef> = AnyProcedures
>(): MutationFn<ResourceMutationVars<T>, T | void, T> => {
  return async (vars, ctx) => {
    const resource = ctx.resource as ResourceClient<T, P>;
    switch (vars.kind) {
      case "create":
        return resource.create(vars.data);
      case "update":
        return resource.update(vars.id, vars.data);
      case "replace":
        return resource.replace(vars.id, vars.data);
      case "delete":
        return resource.delete(vars.id);
    }
  };
};
