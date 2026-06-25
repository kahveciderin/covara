import { useSyncExternalStore, useRef, useEffect, useCallback, useState, useMemo, createElement, type ReactNode } from "react";
import type { LiveListResourceClient, SearchableResourceClient, SearchResponse, SearchOptions, LiveQueryLike, ResourceClient, AggregateOptions, AggregationResponse, CovaraClient } from "./types";
import { getClient, getAuthErrorHandler } from "./globals";
import { createLiveQuery, LiveQuery, LiveQueryOptions, LiveQueryState, LiveQueryMutations, statusLabel } from "./live-store";
import { createMutation, resourceMutationFn, MutationOptions, MutationState, ResourceMutationVars } from "./mutation";
import type { InvalidateTarget } from "./query-cache";
import { captchaController, loadCaptchaWidget, type CaptchaChallenge } from "./captcha";

export type LiveStatus = "loading" | "live" | "reconnecting" | "offline" | "error";

export interface UseLiveListOptions<
  T extends { id: string } = { id: string },
  K extends keyof T & string = keyof T & string,
> extends Omit<LiveQueryOptions, "select"> {
  enabled?: boolean;
  select?: K[];
}

export interface UseLiveListResult<
  T extends { id: string },
  TItem = T,
> {
  items: TItem[];
  status: LiveStatus;
  statusLabel: string;
  error: Error | null;
  pendingCount: number;
  isLoading: boolean;
  isLive: boolean;
  isOffline: boolean;
  isReconnecting: boolean;
  hasMore: boolean;
  totalCount?: number;
  isLoadingMore: boolean;
  mutate: LiveQueryMutations<T>;
  refresh: () => Promise<void>;
  loadMore: () => Promise<void>;
}

/**
 * Live list hook that handles real-time subscriptions, optimistic updates, and offline support.
 *
 * @example
 * // Using path string (requires client to be initialized)
 * const { items, status, mutate } = useLiveList<Todo>('/api/todos', { orderBy: 'position' });
 *
 * @example
 * // Using typed resource client (type is inferred automatically)
 * const { items, status, mutate } = useLiveList(client.resources.todos, { orderBy: 'position' });
 * // items type is inferred as Todo[]
 *
 * @example
 * // Using fluent LiveQuery with type-safe includes (recommended)
 * const { items } = useLiveList(client.resources.todos.filter('completed==true').include('category', 'tags'));
 * // items type: (todos & { category?: categories | null; tags?: tags[] })[]
 *
 * @example
 * // With projections for type-safe field selection
 * const { items } = useLiveList<User, 'id' | 'name' | 'avatar'>('/api/users', {
 *   select: ['id', 'name', 'avatar'],
 * });
 * // items type: { id: string; name: string; avatar: string }[]
 */
const EMPTY_STATE: LiveQueryState<never> = {
  items: [],
  status: "loading",
  error: null,
  pendingCount: 0,
  lastSeq: 0,
  hasMore: false,
  totalCount: undefined,
  isLoadingMore: false,
};

// Type guard to check if input is a LiveQueryLike object
function isLiveQueryLike<T extends { id: string }>(
  input: unknown
): input is LiveQueryLike<T> {
  return (
    input !== null &&
    typeof input === "object" &&
    "_path" in input &&
    "_options" in input &&
    typeof (input as LiveQueryLike<T>)._path === "string"
  );
}

// Overload: Accept LiveQueryLike for fluent API with type-safe includes and select
export function useLiveList<T extends { id: string }, Included = unknown, Selected extends keyof T = keyof T>(
  query: LiveQueryLike<T, Included, Selected>,
  options?: Omit<UseLiveListOptions<T>, "filter" | "orderBy" | "limit" | "select" | "include">
): UseLiveListResult<T, Pick<T, Selected> & Included>;

// Overload: Accept path string or ResourceClient
export function useLiveList<
  T extends { id: string },
  K extends keyof T & string = keyof T & string,
>(
  pathOrRepo: string | LiveListResourceClient<T>,
  options?: UseLiveListOptions<T, K>
): UseLiveListResult<T, Pick<T, K | "id">>;

// Implementation
export function useLiveList<
  T extends { id: string },
  K extends keyof T & string = keyof T & string,
>(
  pathOrRepoOrQuery: string | LiveListResourceClient<T> | LiveQueryLike<T>,
  options?: UseLiveListOptions<T, K>
): UseLiveListResult<T, Pick<T, K | "id">> {
  // Handle LiveQueryLike input - extract path and options as stable primitives
  const isLiveQuery = isLiveQueryLike(pathOrRepoOrQuery);
  const liveQueryInput = isLiveQuery ? pathOrRepoOrQuery as LiveQueryLike<T> : null;

  // Extract stable primitive values from LiveQuery to avoid reference instability
  const lqPath = liveQueryInput?._path;
  const lqFilter = liveQueryInput?._options.filter;
  const lqOrderBy = liveQueryInput?._options.orderBy;
  const lqLimit = liveQueryInput?._options.limit;
  const lqSelect = liveQueryInput?._options.select;
  const lqInclude = liveQueryInput?._options.include;
  const lqSelectKey = lqSelect ? JSON.stringify(lqSelect) : undefined;

  // Merge options from LiveQuery with passed options - use primitive dependencies
  const mergedOptions = useMemo(() => {
    if (isLiveQuery) {
      return {
        ...options,
        filter: lqFilter ?? (options as UseLiveListOptions<T, K>)?.filter,
        orderBy: lqOrderBy ?? (options as UseLiveListOptions<T, K>)?.orderBy,
        limit: lqLimit ?? (options as UseLiveListOptions<T, K>)?.limit,
        select: lqSelect ?? (options as UseLiveListOptions<T, K>)?.select,
        include: lqInclude ?? (options as UseLiveListOptions<T, K>)?.include,
      };
    }
    return options;
  }, [isLiveQuery, lqFilter, lqOrderBy, lqLimit, lqSelectKey, lqInclude, options]);

  const { enabled = true, select, ...queryOptions } = mergedOptions ?? {};
  const liveQueryRef = useRef<LiveQuery<T> | null>(null);
  const [pendingCount, setPendingCount] = useState(0);

  // Get client and repo - use stable dependencies only
  // For LiveQuery: use lqPath (stable string)
  // For string: use the string itself (stable)
  // For ResourceClient: store in ref to maintain stability
  const client = (isLiveQuery || typeof pathOrRepoOrQuery === "string") ? getClient() : null;
  const isString = typeof pathOrRepoOrQuery === "string";
  const stringPath = isString ? pathOrRepoOrQuery : null;

  // Store ResourceClient in ref to avoid re-creating repo on every render
  // This is needed because ResourceClient passed inline would be unstable
  const resourceClientRef = useRef<LiveListResourceClient<T> | null>(null);
  if (!isLiveQuery && !isString) {
    resourceClientRef.current = pathOrRepoOrQuery as LiveListResourceClient<T>;
  }

  const repo = useMemo(() => {
    if (isLiveQuery && lqPath) {
      return getClient().resource<T>(lqPath);
    }
    if (stringPath) {
      return getClient().resource<T>(stringPath);
    }
    // ResourceClient case - use ref for stability
    return resourceClientRef.current;
  }, [isLiveQuery, lqPath, stringPath]);

  const optionsKey = JSON.stringify({ ...queryOptions, select });

  // Update pending count periodically
  useEffect(() => {
    if (!client) return;

    const updatePending = async () => {
      const count = await client.getPendingCount();
      setPendingCount(count);
    };

    updatePending();
    const interval = setInterval(updatePending, 2000);
    return () => clearInterval(interval);
  }, [client]);

  // The path used to key the shared cache (only when resolvable from a string/LiveQuery).
  const cachePath = isLiveQuery ? lqPath : stringPath;
  const cacheOptionsRef = useRef<LiveQueryOptions | null>(null);

  useEffect(() => {
    if (!repo || !enabled) {
      liveQueryRef.current?.destroy();
      liveQueryRef.current = null;
      return;
    }

    const authErrorHandler = getAuthErrorHandler();

    const liveQueryOptions: LiveQueryOptions = {
      ...queryOptions,
      select: select as string[] | undefined,
    };

    // Path-based queries go through the shared cache so client.invalidate /
    // client.prefetch can reach them. Direct ResourceClient instances keep the
    // legacy per-component store (can't be keyed by path).
    if (client && cachePath) {
      cacheOptionsRef.current = liveQueryOptions;
      liveQueryRef.current = client.queryCache.acquire(cachePath, liveQueryOptions);
      return () => {
        client.queryCache.release(cachePath, liveQueryOptions);
        liveQueryRef.current = null;
      };
    }

    liveQueryRef.current = createLiveQuery(repo, liveQueryOptions, {
      onAuthError: authErrorHandler ?? undefined,
      getPendingCount: client ? () => client.getPendingCount() : undefined,
    });

    return () => {
      liveQueryRef.current?.destroy();
      liveQueryRef.current = null;
    };
  }, [repo, optionsKey, enabled, client, cachePath]);

  const subscribe = useCallback((listener: () => void) => {
    if (!liveQueryRef.current) return () => {};
    return liveQueryRef.current.subscribe(listener);
  }, []);

  const getSnapshot = useCallback((): LiveQueryState<T> => {
    if (!liveQueryRef.current) {
      return EMPTY_STATE as LiveQueryState<T>;
    }
    return liveQueryRef.current.getSnapshot();
  }, []);

  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const mutate: LiveQueryMutations<T> = useMemo(() => ({
    create: (data) => {
      if (!liveQueryRef.current) throw new Error("LiveQuery not initialized");
      return liveQueryRef.current.mutate.create(data);
    },
    update: (id, data) => liveQueryRef.current?.mutate.update(id, data),
    delete: (id) => liveQueryRef.current?.mutate.delete(id),
  }), []);

  const refresh = useCallback(async () => {
    await liveQueryRef.current?.refresh();
  }, []);

  const loadMore = useCallback(async () => {
    await liveQueryRef.current?.loadMore();
  }, []);

  // Use state's pending count if available, otherwise use polled count
  const effectivePendingCount = state.pendingCount > 0 ? state.pendingCount : pendingCount;

  return {
    items: state.items,
    status: state.status,
    statusLabel: statusLabel(state.status, effectivePendingCount),
    error: state.error,
    pendingCount: effectivePendingCount,
    isLoading: state.status === "loading",
    isLive: state.status === "live",
    isOffline: state.status === "offline",
    isReconnecting: state.status === "reconnecting",
    hasMore: state.hasMore,
    totalCount: state.totalCount,
    isLoadingMore: state.isLoadingMore,
    mutate,
    refresh,
    loadMore,
  };
}

/**
 * Returns a stable `invalidate(target)` function that marks matching cached
 * LiveQuery stores stale and refetches them. Target is a resource path/prefix
 * string or a predicate over (path, options).
 *
 * @example
 * const invalidate = useInvalidate();
 * await save();
 * invalidate('/api/todos');
 */
export function useInvalidate(): (target: InvalidateTarget) => number {
  return useCallback((target: InvalidateTarget) => {
    try {
      return getClient().invalidate(target);
    } catch {
      return 0;
    }
  }, []);
}

export interface UseInfiniteListResult<T extends { id: string }, TItem = T>
  extends UseLiveListResult<T, TItem> {
  /** Fetch the next page; accumulates into `items`. No-op when no more pages. */
  fetchNextPage: () => Promise<void>;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
}

/**
 * Infinite/paginated live list built on cursor pagination. Pages accumulate in
 * `items` and the list stays realtime-aware (new items still arrive via the
 * subscription). Defaults to `strict` subscription mode (paginated semantics).
 *
 * @example
 * const { items, fetchNextPage, hasNextPage, isFetchingNextPage } =
 *   useInfiniteList<Todo>('/api/todos', { limit: 20, orderBy: 'createdAt:desc' });
 */
export function useInfiniteList<
  T extends { id: string },
  K extends keyof T & string = keyof T & string,
>(
  pathOrRepo: string | LiveListResourceClient<T>,
  options?: UseLiveListOptions<T, K>
): UseInfiniteListResult<T, Pick<T, K | "id">> {
  const base = useLiveList<T, K>(pathOrRepo as string, options);
  const [isFetchingNextPage, setIsFetchingNextPage] = useState(false);

  const fetchNextPage = useCallback(async () => {
    if (isFetchingNextPage || !base.hasMore) return;
    setIsFetchingNextPage(true);
    try {
      await base.loadMore();
    } finally {
      setIsFetchingNextPage(false);
    }
  }, [base.loadMore, base.hasMore, isFetchingNextPage]);

  return {
    ...base,
    fetchNextPage,
    hasNextPage: base.hasMore,
    isFetchingNextPage: isFetchingNextPage || base.isLoadingMore,
  };
}

export interface UseLiveAggregateOptions extends AggregateOptions {
  enabled?: boolean;
}

export interface UseLiveAggregateResult {
  data: AggregationResponse | null;
  groups: AggregationResponse["groups"];
  status: LiveStatus;
  error: Error | null;
  isLoading: boolean;
  isLive: boolean;
  isReconnecting: boolean;
}

/**
 * Subscribe to a live aggregation. The server streams the aggregate result and
 * re-emits it whenever the resource is mutated, so grouped counts/sums/avgs stay
 * realtime without refetching.
 *
 * @example
 * const { groups, isLive } = useLiveAggregate('/api/todos', {
 *   groupBy: ['status'],
 *   count: true,
 * });
 */
export function useLiveAggregate(
  pathOrRepo: string | ResourceClient<any>,
  options: UseLiveAggregateOptions = {}
): UseLiveAggregateResult {
  const { enabled = true, filter, groupBy, count, sum, avg, min, max } = options;

  const aggOptions: AggregateOptions = useMemo(
    () => ({ filter, groupBy, count, sum, avg, min, max }),
    [filter, JSON.stringify(groupBy), count, JSON.stringify(sum), JSON.stringify(avg), JSON.stringify(min), JSON.stringify(max)]
  );

  const [data, setData] = useState<AggregationResponse | null>(null);
  const [status, setStatus] = useState<LiveStatus>("loading");
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!enabled) {
      setStatus("loading");
      return;
    }

    const resource =
      typeof pathOrRepo === "string"
        ? getClient().resource<any>(pathOrRepo)
        : pathOrRepo;

    setStatus("loading");
    setError(null);

    const sub = resource.subscribeAggregate(aggOptions, {
      onData: (next) => {
        setData(next);
        setStatus("live");
        setError(null);
      },
      onConnectionChange: (connected) => {
        setStatus((prev) => (connected ? "live" : prev === "loading" ? "loading" : "reconnecting"));
      },
      onError: (err) => {
        setError(err);
        setStatus("error");
      },
    });

    return () => sub.unsubscribe();
  }, [typeof pathOrRepo === "string" ? pathOrRepo : pathOrRepo, aggOptions, enabled]);

  return {
    data,
    groups: data?.groups ?? [],
    status,
    error,
    isLoading: status === "loading",
    isLive: status === "live",
    isReconnecting: status === "reconnecting",
  };
}

export interface UseMutationResult<TVars, TData> {
  mutate: (vars: TVars) => void;
  mutateAsync: (vars: TVars) => Promise<TData>;
  status: MutationState<TData>["status"];
  isLoading: boolean;
  isSuccess: boolean;
  isError: boolean;
  error: Error | null;
  data: TData | undefined;
  reset: () => void;
}

const EMPTY_MUTATION_STATE: MutationState<unknown> = {
  status: "idle",
  error: null,
  data: undefined,
};

/**
 * Standalone mutation hook usable outside a list. Integrates with optimistic
 * updates + the offline queue (via the resource repository) and the invalidation
 * API. Pass a resource path to get create/update/replace/delete dispatch, or a
 * custom async function for full control.
 *
 * @example
 * // Resource-bound: vars describe the operation
 * const { mutate, status } = useMutation<Todo>('/api/todos', {
 *   invalidates: ['/api/todos'],
 *   onSuccess: () => toast('Saved'),
 * });
 * mutate({ kind: 'create', data: { title: 'New' } });
 *
 * @example
 * // Custom function
 * const { mutateAsync } = useMutation(async ({ id }: { id: string }, ctx) => {
 *   await ctx.resource.delete(id);
 *   ctx.invalidate('/api/todos');
 * }, { resource: '/api/todos' });
 */
export function useMutation<
  T extends { id: string },
  TData = T | void,
>(
  resource: string,
  options?: MutationOptions<ResourceMutationVars<T>, TData>
): UseMutationResult<ResourceMutationVars<T>, TData>;
export function useMutation<TVars, TData, T extends { id: string } = { id: string }>(
  fn: (vars: TVars, ctx: { resource: ResourceClient<T>; invalidate: (t: InvalidateTarget) => void }) => Promise<TData>,
  options: MutationOptions<TVars, TData> & { resource: string }
): UseMutationResult<TVars, TData>;
export function useMutation(
  resourceOrFn: string | ((vars: any, ctx: any) => Promise<any>),
  options?: any
): UseMutationResult<unknown, unknown> {
  // Keep the latest options/fn in a ref so callbacks always see current values
  // without recreating the controller (which would reset status mid-flight).
  const latestRef = useRef<{
    fn: ((vars: any, ctx: any) => Promise<any>) | undefined;
    options: any;
  }>({ fn: undefined, options: undefined });
  latestRef.current = {
    fn: typeof resourceOrFn === "function" ? resourceOrFn : undefined,
    options,
  };

  const resourcePath = (typeof resourceOrFn === "string" ? resourceOrFn : options?.resource) as string;

  const controller = useMemo(() => {
    const client = getClient();
    const resource = client.resource(resourcePath);
    return createMutation({
      resource,
      fn: (vars, ctx) => {
        const liveFn = latestRef.current.fn;
        if (liveFn) return liveFn(vars, ctx);
        return resourceMutationFn()(vars as any, ctx as any);
      },
      invalidate: (target) => client.invalidate(target),
      options: {
        onSuccess: (data, vars) => latestRef.current.options?.onSuccess?.(data, vars),
        onError: (error, vars) => latestRef.current.options?.onError?.(error, vars),
        onSettled: (data, error, vars) => latestRef.current.options?.onSettled?.(data, error, vars),
        get invalidates() {
          return (latestRef.current.options?.invalidates as InvalidateTarget[] | undefined) ?? [];
        },
      } as Parameters<typeof createMutation>[0]["options"],
    });
  }, [resourcePath]);

  const subscribe = useCallback((listener: () => void) => controller.subscribe(listener), [controller]);
  const getSnapshot = useCallback(
    () => controller.getSnapshot() as MutationState<unknown>,
    [controller]
  );
  const state = useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_MUTATION_STATE);

  const mutate = useCallback((vars: unknown) => controller.mutate(vars), [controller]);
  const mutateAsync = useCallback((vars: unknown) => controller.mutateAsync(vars), [controller]);
  const reset = useCallback(() => controller.reset(), [controller]);

  return {
    mutate,
    mutateAsync,
    status: state.status,
    isLoading: state.status === "loading",
    isSuccess: state.status === "success",
    isError: state.status === "error",
    error: state.error,
    data: state.data,
    reset,
  };
}

export type AuthStrategy = "cookie" | "jwt" | "bearer" | "apiKey" | "auto";

export interface UseAuthOptions {
  checkUrl?: string;
  logoutUrl?: string;
  strategy?: AuthStrategy;
  token?: string;
  apiKey?: string;
  baseUrl?: string;
  /** Social login route prefix (mounted server-side, default `/api/auth/social`). */
  socialBasePath?: string;
  /** Session auth route prefix (mounted server-side, default `/api/auth`). */
  authBasePath?: string;
}

export interface UseAuthResult<TUser = unknown> {
  user: TUser | null;
  status: "loading" | "authenticated" | "unauthenticated";
  isAuthenticated: boolean;
  isLoading: boolean;
  logout: () => Promise<void>;
  refetch: () => Promise<void>;
  accessToken: string | null;
  /** Email/password login; refreshes `user` on success. */
  login: (email: string, password: string) => Promise<void>;
  /** Email/password signup; refreshes `user` on success. */
  signup: (input: { email: string; password: string; name?: string }) => Promise<void>;
  /** Email confirmation: ask the server to email a verification token. */
  requestEmailVerification: (email: string) => Promise<void>;
  /** Email confirmation: confirm the token from the email link. */
  confirmEmail: (email: string, token: string) => Promise<void>;
  /**
   * Begin a social (Passport) login by navigating to the provider, e.g.
   * `signInWith("github")`. After the server completes the OAuth flow it sets the
   * session cookie and redirects back. Browser-only.
   */
  signInWith: (provider: string) => void;
}

/**
 * Auth hook that integrates with the Covara client and supports multiple auth strategies.
 *
 * Supports:
 * - `cookie` - Session-based auth (cookies like `session`, `connect.sid`, Auth.js/NextAuth cookies)
 * - `jwt` - JWT bearer token auth (uses the JWT client if configured)
 * - `bearer` - Manual bearer token auth (provide token in options)
 * - `apiKey` - API key auth (uses X-API-Key header)
 * - `auto` (default) - Automatically detects based on client configuration
 *
 * @example
 * // Auto-detect strategy (recommended when using createClient with jwt or auth config)
 * const { user, isAuthenticated, logout } = useAuth<User>();
 *
 * @example
 * // Explicit JWT strategy
 * const { user, isAuthenticated, logout, accessToken } = useAuth<User>({ strategy: 'jwt' });
 *
 * @example
 * // Manual bearer token
 * const { user, isAuthenticated } = useAuth<User>({ strategy: 'bearer', token: myToken });
 *
 * @example
 * // API key auth
 * const { user, isAuthenticated } = useAuth<User>({ strategy: 'apiKey', apiKey: 'my-api-key' });
 */
export function useAuth<TUser = unknown>(options: UseAuthOptions = {}): UseAuthResult<TUser> {
  const [user, setUser] = useState<TUser | null>(null);
  const [status, setStatus] = useState<"loading" | "authenticated" | "unauthenticated">("loading");
  const [accessToken, setAccessToken] = useState<string | null>(null);
  // Bearer token captured from login/signup when the server uses a JWT session
  // strategy. Held in a ref so the immediately-following checkAuth() sees it.
  const sessionTokenRef = useRef<string | null>(null);

  const client = useMemo(() => {
    try {
      return getClient();
    } catch {
      return null;
    }
  }, []);

  const effectiveStrategy = useMemo((): AuthStrategy => {
    if (options.strategy && options.strategy !== "auto") {
      return options.strategy;
    }
    if (options.token) return "bearer";
    if (options.apiKey) return "apiKey";
    if (client?.jwt?.isAuthenticated?.() || client?.jwt?.getAccessToken?.()) {
      return "jwt";
    }
    if (client?.auth?.isAuthenticated?.()) {
      return "jwt";
    }
    return "cookie";
  }, [options.strategy, options.token, options.apiKey, client]);

  const baseUrl = useMemo(() => {
    if (options.baseUrl) return options.baseUrl;
    if (typeof window !== "undefined") return window.location.origin;
    return "";
  }, [options.baseUrl]);

  const getAuthHeaders = useCallback((): Record<string, string> => {
    const headers: Record<string, string> = {};

    // A JWT captured from login/signup (jwtSession) authenticates every request.
    if (sessionTokenRef.current) {
      headers["Authorization"] = `Bearer ${sessionTokenRef.current}`;
    }

    switch (effectiveStrategy) {
      case "jwt": {
        const token = client?.jwt?.getAccessToken?.() ?? client?.auth?.getAccessToken?.();
        if (token) {
          headers["Authorization"] = `Bearer ${token}`;
          setAccessToken(token);
        }
        break;
      }
      case "bearer": {
        if (options.token) {
          headers["Authorization"] = `Bearer ${options.token}`;
          setAccessToken(options.token);
        }
        break;
      }
      case "apiKey": {
        if (options.apiKey) {
          headers["X-API-Key"] = options.apiKey;
        }
        break;
      }
    }

    return headers;
  }, [effectiveStrategy, client, options.token, options.apiKey]);

  const checkAuth = useCallback(async () => {
    const authHeaders = getAuthHeaders();
    const checkUrl = options.checkUrl ?? "/api/auth/me";
    const fullUrl = checkUrl.startsWith("http") ? checkUrl : `${baseUrl}${checkUrl}`;

    try {
      const response = await fetch(fullUrl, {
        credentials: effectiveStrategy === "cookie" ? "include" : "same-origin",
        headers: authHeaders,
      });

      if (!response.ok) {
        setUser(null);
        setStatus("unauthenticated");
        return;
      }

      const data = await response.json();
      if (data.user) {
        setUser(data.user as TUser);
        setStatus("authenticated");
      } else {
        setUser(null);
        setStatus("unauthenticated");
      }
    } catch {
      setUser(null);
      setStatus("unauthenticated");
    }
  }, [baseUrl, options.checkUrl, effectiveStrategy, getAuthHeaders]);

  const logout = useCallback(async () => {
    const logoutUrl = options.logoutUrl ?? "/api/auth/logout";
    const fullUrl = logoutUrl.startsWith("http") ? logoutUrl : `${baseUrl}${logoutUrl}`;
    const authHeaders = getAuthHeaders();

    try {
      if (effectiveStrategy === "jwt" && client?.jwt) {
        await client.jwt.logout();
      } else {
        await fetch(fullUrl, {
          method: "POST",
          credentials: effectiveStrategy === "cookie" ? "include" : "same-origin",
          headers: authHeaders,
        });
      }
    } catch {
      // Ignore logout errors
    }

    sessionTokenRef.current = null;
    client?.clearAuthToken?.();
    setUser(null);
    setStatus("unauthenticated");
    setAccessToken(null);
  }, [baseUrl, options.logoutUrl, effectiveStrategy, getAuthHeaders, client]);

  const authBase = options.authBasePath ?? "/api/auth";

  const postAuth = useCallback(
    async (path: string, body?: unknown): Promise<unknown> => {
      const res = await fetch(`${baseUrl}${authBase}${path}`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        throw new Error(data?.error?.message ?? `Request failed (${res.status})`);
      }
      return res.json().catch(() => ({}));
    },
    [baseUrl, authBase]
  );

  // Capture a JWT access token from a login/signup response (jwtSession) so the
  // hook authenticates uniformly whether the server uses cookies or JWTs.
  const captureToken = useCallback(
    (body: unknown) => {
      const token = (body as { accessToken?: string } | null)?.accessToken;
      if (token) {
        sessionTokenRef.current = token;
        setAccessToken(token);
        client?.setAuthToken?.(token); // share with the client's transport
      }
    },
    [client]
  );

  const login = useCallback(
    async (email: string, password: string) => {
      captureToken(await postAuth("/login", { email, password }));
      await checkAuth();
    },
    [postAuth, checkAuth, captureToken]
  );

  const signup = useCallback(
    async (input: { email: string; password: string; name?: string }) => {
      captureToken(await postAuth("/signup", input));
      await checkAuth();
    },
    [postAuth, checkAuth, captureToken]
  );

  const requestEmailVerification = useCallback(
    async (email: string) => {
      await postAuth("/verify/request", { email });
    },
    [postAuth]
  );

  const confirmEmail = useCallback(
    async (email: string, token: string) => {
      await postAuth("/verify/confirm", { email, token });
    },
    [postAuth]
  );

  const signInWith = useCallback(
    (provider: string) => {
      if (client) {
        client.loginWithSocial(provider);
        return;
      }
      if (typeof window === "undefined" || !window.location) {
        throw new Error(
          "signInWith requires a browser. On React Native, navigate to the " +
            "social login URL yourself."
        );
      }
      const base = options.socialBasePath ?? "/api/auth/social";
      window.location.assign(`${baseUrl}${base}/${encodeURIComponent(provider)}`);
    },
    [client, baseUrl, options.socialBasePath]
  );

  useEffect(() => {
    if (effectiveStrategy === "jwt" && client?.jwt) {
      const unsubscribe = client.jwt.subscribe((state) => {
        if (state.isAuthenticated && state.user) {
          setUser(state.user as TUser);
          setStatus("authenticated");
          setAccessToken(state.accessToken ?? null);
        } else if (!state.isAuthenticated) {
          setUser(null);
          setStatus("unauthenticated");
          setAccessToken(null);
        }
      });

      const state = client.jwt.getState();
      if (state.isAuthenticated && state.user) {
        setUser(state.user as TUser);
        setStatus("authenticated");
        setAccessToken(state.accessToken ?? null);
      } else if (state.accessToken) {
        client.jwt.getUser().then((fetchedUser) => {
          if (fetchedUser) {
            setUser(fetchedUser as TUser);
            setStatus("authenticated");
            setAccessToken(state.accessToken ?? null);
          } else {
            setStatus("unauthenticated");
          }
        }).catch(() => {
          setStatus("unauthenticated");
        });
      } else {
        setStatus("unauthenticated");
      }

      return unsubscribe;
    }

    checkAuth();
  }, [effectiveStrategy, client, checkAuth]);

  return {
    user,
    status,
    isAuthenticated: status === "authenticated",
    isLoading: status === "loading",
    logout,
    refetch: checkAuth,
    accessToken,
    login,
    signup,
    requestEmailVerification,
    confirmEmail,
    signInWith,
  };
}

export interface UsePublicEnvOptions {
  baseUrl?: string;
  envPath?: string;
  refreshInterval?: number;
  enabled?: boolean;
}

export interface UsePublicEnvResult<T> {
  env: T | null;
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

export function usePublicEnv<T = unknown>(
  options: UsePublicEnvOptions = {}
): UsePublicEnvResult<T> {
  const {
    baseUrl = typeof window !== "undefined" ? window.location.origin : "",
    envPath = "/api/env",
    refreshInterval,
    enabled = true,
  } = options;

  const [env, setEnv] = useState<T | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchEnv = useCallback(async () => {
    if (!enabled) return;

    try {
      setIsLoading(true);
      setError(null);
      const response = await fetch(`${baseUrl}${envPath}`, {
        credentials: "include",
      });
      if (!response.ok) {
        throw new Error(`Failed to fetch env: ${response.status}`);
      }
      const data = await response.json();
      setEnv(data as T);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setIsLoading(false);
    }
  }, [baseUrl, envPath, enabled]);

  useEffect(() => {
    fetchEnv();
  }, [fetchEnv]);

  useEffect(() => {
    if (!refreshInterval || !enabled) return;

    const interval = setInterval(fetchEnv, refreshInterval);
    return () => clearInterval(interval);
  }, [fetchEnv, refreshInterval, enabled]);

  return {
    env,
    isLoading,
    error,
    refetch: fetchEnv,
  };
}

export interface UseSearchOptions extends SearchOptions {
  debounceMs?: number;
  enabled?: boolean;
}

export interface UseSearchResult<T> {
  items: T[];
  total: number;
  highlights?: Record<string, Record<string, string[]>>;
  isSearching: boolean;
  error: Error | null;
  search: (query: string) => void;
  clear: () => void;
}

/**
 * Search hook that handles debounced search requests.
 *
 * @example
 * const { items, isSearching, search, clear } = useSearch<Todo>('/api/todos');
 *
 * // In your component:
 * <input onChange={(e) => search(e.target.value)} />
 * {items.map(item => <div key={item.id}>{item.title}</div>)}
 */
export function useSearch<T extends { id: string }>(
  pathOrRepo: string | SearchableResourceClient<T>,
  options: UseSearchOptions = {}
): UseSearchResult<T> {
  const { debounceMs = 300, enabled = true, ...searchOptions } = options;

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResponse<T> | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const repo = useMemo(() => {
    if (typeof pathOrRepo === "string") {
      return getClient().resource<T>(pathOrRepo);
    }
    return pathOrRepo;
  }, [pathOrRepo]);

  useEffect(() => {
    if (!enabled || !query.trim()) {
      setResults(null);
      setIsSearching(false);
      return;
    }

    setIsSearching(true);
    setError(null);

    const timeoutId = setTimeout(async () => {
      try {
        const response = await repo.search(query, searchOptions);
        setResults(response);
      } catch (err) {
        setError(err instanceof Error ? err : new Error(String(err)));
        setResults(null);
      } finally {
        setIsSearching(false);
      }
    }, debounceMs);

    return () => clearTimeout(timeoutId);
  }, [query, repo, debounceMs, enabled, JSON.stringify(searchOptions)]);

  const search = useCallback((newQuery: string) => {
    setQuery(newQuery);
  }, []);

  const clear = useCallback(() => {
    setQuery("");
    setResults(null);
    setError(null);
  }, []);

  return {
    items: results?.items ?? [],
    total: results?.total ?? 0,
    highlights: results?.highlights,
    isSearching,
    error,
    search,
    clear,
  };
}

export { statusLabel } from "./live-store";
export type { LiveQueryStatus, LiveQueryState, LiveQueryMutations, LiveQuery, SubscriptionMode } from "./live-store";

export type {
  MutationStatus,
  MutationState,
  MutationOptions,
  MutationFn,
  MutationFnContext,
  ResourceMutationVars,
} from "./mutation";
export type { InvalidateTarget } from "./query-cache";

export {
  useFileUpload,
  useFile,
  useFiles,
} from "./react-files";
export type {
  UseFileUploadOptions,
  UseFileUploadResult,
  UseFileOptions,
  UseFileResult,
  UseFilesOptions,
  UseFilesResult,
  UploadedFile,
  UploadProgress,
  FileUploadOptions,
} from "./react-files";

export {
  useJWTAuth,
  initJWTClient,
  getJWTClient,
} from "./react-jwt";
export type {
  UseJWTAuthResult,
} from "./react-jwt";

export {
  useCredits,
  useSubscription,
  useCheckout,
} from "./react-billing";
export type {
  UseCreditsResult,
  UseSubscriptionResult,
  UseCheckoutResult,
} from "./react-billing";
export type {
  BillingClient,
  BillingSubscription,
  SubscriptionStatus,
  CheckoutInput,
  CheckoutResult,
  PortalResult,
} from "./billing";

// ---------------------------------------------------------------------------
// CAPTCHA (BETA)
// ---------------------------------------------------------------------------

const safeGetClient = (explicit?: CovaraClient): CovaraClient | null => {
  if (explicit) return explicit;
  try {
    return getClient();
  } catch {
    return null;
  }
};

/**
 * Observe the pending CAPTCHA challenge (if any). Useful for building a custom
 * CAPTCHA UI; resolve it with `captchaController.resolveCurrent(token)`.
 */
export function useCaptcha(): { pending: CaptchaChallenge | null } {
  const current = useSyncExternalStore(
    captchaController.subscribe,
    captchaController.getCurrent,
    captchaController.getCurrent
  );
  return { pending: current?.challenge ?? null };
}

export interface CovaraCaptchaProps {
  /** Client to register the solver on (defaults to the global client). */
  client?: CovaraClient;
  /** Class for the overlay wrapper. */
  className?: string;
  /** Class for the widget container. */
  containerClassName?: string;
  /** Heading text shown above the widget. */
  title?: string;
}

const overlayStyle = {
  position: "fixed",
  inset: "0",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(0,0,0,0.5)",
  zIndex: 2147483647,
} as const;

const cardStyle = {
  background: "#fff",
  borderRadius: "12px",
  padding: "20px",
  boxShadow: "0 10px 40px rgba(0,0,0,0.2)",
  maxWidth: "90vw",
} as const;

/**
 * Mount once near the app root. Registers a CAPTCHA solver on the client; when
 * the server issues a CAPTCHA challenge it renders the provider widget in a
 * modal (or silently, for invisible providers) and resolves the token so the
 * transport retries transparently.
 */
export function CovaraCaptcha(props: CovaraCaptchaProps): ReactNode {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const { pending } = useCaptcha();

  useEffect(() => {
    const client = safeGetClient(props.client);
    if (!client) return;
    client.transport.setCaptchaSolver(captchaController.solver);
    return () => client.transport.setCaptchaSolver(undefined);
  }, [props.client]);

  useEffect(() => {
    if (!pending || !containerRef.current) return;
    let cancelled = false;
    loadCaptchaWidget(pending, containerRef.current)
      .then((token) => {
        if (!cancelled) captchaController.resolveCurrent(token);
      })
      .catch(() => {
        if (!cancelled) captchaController.resolveCurrent(null);
      });
    return () => {
      cancelled = true;
    };
  }, [pending]);

  if (!pending) return null;
  return createElement(
    "div",
    { className: props.className, style: overlayStyle },
    createElement(
      "div",
      { style: cardStyle },
      createElement("p", { style: { margin: "0 0 12px", font: "500 14px system-ui" } },
        props.title ?? "Please complete the verification"),
      createElement("div", { ref: containerRef, className: props.containerClassName })
    )
  );
}

export { captchaController, loadCaptchaWidget } from "./captcha";
export type { CaptchaChallenge, CaptchaSolver, PendingCaptcha } from "./captcha";
