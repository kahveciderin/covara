import {
  ResourceClient,
  PaginatedResponse,
  AggregationResponse,
  SearchResponse,
  ListOptions,
  ListOptionsWithSelect,
  GetOptions,
  GetOptionsWithSelect,
  AggregateOptions,
  SearchOptions,
  CreateOptions,
  UpdateOptions,
  DeleteOptions,
  SubscribeOptions,
  SubscriptionCallbacks,
  Subscription,
  ProcedureDef,
  AnyProcedures,
} from "./types";
import { Transport } from "./transport";
import { createSubscription } from "./subscription-manager";
import { OfflineManager } from "./offline";
import { ResourceQueryBuilder } from "./resource-query-builder";

export interface RepositoryConfig {
  transport: Transport;
  resourcePath: string;
  idField?: string;
  offline?: OfflineManager;
}

export class Repository<
  T extends { id: string },
  P extends Record<keyof P, ProcedureDef> = AnyProcedures
> implements ResourceClient<T, P> {
  private transport: Transport;
  private resourcePath: string;
  private idField: keyof T;
  private offline?: OfflineManager;

  constructor(config: RepositoryConfig) {
    this.transport = config.transport;
    this.resourcePath = config.resourcePath;
    this.idField = (config.idField ?? "id") as keyof T;
    this.offline = config.offline;
  }

  list<K extends keyof T>(
    options: ListOptionsWithSelect<T, K>
  ): Promise<PaginatedResponse<Pick<T, K>>>;
  list(options?: ListOptions): Promise<PaginatedResponse<T>>;
  async list(
    options: ListOptions | ListOptionsWithSelect<T, keyof T> = {}
  ): Promise<PaginatedResponse<Partial<T>>> {
    const params: Record<string, string | number | boolean | string[]> = {};

    if (options.filter) params.filter = options.filter;
    if (options.select) params.select = options.select.join(",");
    if (options.include) params.include = options.include;
    if (options.cursor) params.cursor = options.cursor;
    if (options.limit) params.limit = options.limit;
    if (options.orderBy) params.orderBy = options.orderBy;
    if (options.totalCount) params.totalCount = true;

    const response = await this.transport.request<PaginatedResponse<T>>({
      method: "GET",
      path: this.resourcePath,
      params,
    });

    return response.data;
  }

  get<K extends keyof T>(
    id: string,
    options: GetOptionsWithSelect<T, K>
  ): Promise<Pick<T, K>>;
  get(id: string, options?: GetOptions): Promise<T>;
  async get(
    id: string,
    options: GetOptions | GetOptionsWithSelect<T, keyof T> = {}
  ): Promise<Partial<T>> {
    const params: Record<string, string | string[]> = {};

    if (options.select) params.select = options.select.join(",");
    if (options.include) params.include = options.include;

    const response = await this.transport.request<T>({
      method: "GET",
      path: `${this.resourcePath}/${id}`,
      params,
    });

    return response.data;
  }

  async count(filter?: string): Promise<number> {
    const params: Record<string, string> = {};
    if (filter) params.filter = filter;

    const response = await this.transport.request<{ count: number }>({
      method: "GET",
      path: `${this.resourcePath}/count`,
      params,
    });

    return response.data.count;
  }

  async aggregate(options: AggregateOptions): Promise<AggregationResponse> {
    const params: Record<string, string | boolean> = {};

    if (options.filter) params.filter = options.filter;
    if (options.groupBy) params.groupBy = options.groupBy.join(",");
    if (options.count) params.count = true;
    if (options.sum) params.sum = options.sum.join(",");
    if (options.avg) params.avg = options.avg.join(",");
    if (options.min) params.min = options.min.join(",");
    if (options.max) params.max = options.max.join(",");

    const response = await this.transport.request<AggregationResponse>({
      method: "GET",
      path: `${this.resourcePath}/aggregate`,
      params,
    });

    return response.data;
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchResponse<T>> {
    const params: Record<string, string | number | boolean> = {
      q: query,
    };

    if (options.filter) params.filter = options.filter;
    if (options.limit) params.limit = options.limit;
    if (options.offset) params.offset = options.offset;
    if (options.highlight) params.highlight = true;

    const response = await this.transport.request<SearchResponse<T>>({
      method: "GET",
      path: `${this.resourcePath}/search`,
      params,
    });

    return response.data;
  }

  async create(data: Partial<Omit<T, "id">>, options: CreateOptions = {}): Promise<T> {
    const optimisticId = options.optimisticId ?? `optimistic_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Default to optimistic when offline manager is present (opt-out with optimistic: false)
    const useOptimistic = this.offline && options.optimistic !== false;

    if (useOptimistic) {
      const optimisticResult = { ...data, id: optimisticId } as T;

      // Fire off background sync
      this.backgroundCreate(data, optimisticId);

      return optimisticResult;
    }

    // Non-optimistic: wait for server response
    const response = await this.transport.request<T>({
      method: "POST",
      path: this.resourcePath,
      body: data,
    });
    return response.data;
  }

  private backgroundCreate(data: Partial<Omit<T, "id">>, optimisticId: string): void {
    this.transport.request<T & { _optimisticId?: string }>({
      method: "POST",
      path: this.resourcePath,
      body: data,
      headers: {
        "X-Covara-Optimistic-Id": optimisticId,
        "X-Idempotency-Key": optimisticId,
      },
    }).then(response => {
      // Success: remap ID if different
      const serverId = response.data.id;
      if (serverId !== optimisticId) {
        this.offline!.registerIdMapping(optimisticId, serverId);
      }
    }).catch(() => {
      // Failure: queue for retry
      this.offline!.queueMutation("create", this.resourcePath, data, undefined, optimisticId);
    });
  }

  async update(id: string, data: Partial<T>, options: UpdateOptions = {}): Promise<T> {
    // Default to optimistic when offline manager is present (opt-out with optimistic: false)
    const useOptimistic = this.offline && options.optimistic !== false;

    if (useOptimistic) {
      const optimisticResult = { ...data, id } as T;

      // Fire off background sync
      this.backgroundUpdate(id, data);

      return optimisticResult;
    }

    // Non-optimistic: wait for server response
    const response = await this.transport.request<T>({
      method: "PATCH",
      path: `${this.resourcePath}/${id}`,
      body: data,
    });
    return response.data;
  }

  private backgroundUpdate(id: string, data: Partial<T>): void {
    // Resolve optimistic ID to server ID if needed
    const resolvedId = this.offline!.resolveId(id);

    this.transport.request<T>({
      method: "PATCH",
      path: `${this.resourcePath}/${resolvedId}`,
      body: data,
    }).catch(() => {
      // Failure: queue for retry (use original id, will be resolved during sync)
      this.offline!.queueMutation("update", this.resourcePath, data, id);
    });
  }

  async replace(id: string, data: Omit<T, "id">, options: UpdateOptions = {}): Promise<T> {
    // Default to optimistic when offline manager is present (opt-out with optimistic: false)
    const useOptimistic = this.offline && options.optimistic !== false;

    if (useOptimistic) {
      const optimisticResult = { ...data, id } as T;

      // Fire off background sync
      this.backgroundReplace(id, data);

      return optimisticResult;
    }

    // Non-optimistic: wait for server response
    const response = await this.transport.request<T>({
      method: "PUT",
      path: `${this.resourcePath}/${id}`,
      body: data,
    });
    return response.data;
  }

  private backgroundReplace(id: string, data: Omit<T, "id">): void {
    // Resolve optimistic ID to server ID if needed
    const resolvedId = this.offline!.resolveId(id);

    this.transport.request<T>({
      method: "PUT",
      path: `${this.resourcePath}/${resolvedId}`,
      body: data,
    }).catch(() => {
      // Failure: queue for retry
      this.offline!.queueMutation("update", this.resourcePath, data, id);
    });
  }

  async delete(id: string, options: DeleteOptions = {}): Promise<void> {
    // Default to optimistic when offline manager is present (opt-out with optimistic: false)
    const useOptimistic = this.offline && options.optimistic !== false;

    if (useOptimistic) {
      // Fire off background sync
      this.backgroundDelete(id);
      return;
    }

    // Non-optimistic: wait for server response
    await this.transport.request<void>({
      method: "DELETE",
      path: `${this.resourcePath}/${id}`,
    });
  }

  private backgroundDelete(id: string): void {
    // Resolve optimistic ID to server ID if needed
    const resolvedId = this.offline!.resolveId(id);

    this.transport.request<void>({
      method: "DELETE",
      path: `${this.resourcePath}/${resolvedId}`,
    }).catch(() => {
      // Failure: queue for retry
      this.offline!.queueMutation("delete", this.resourcePath, undefined, id);
    });
  }

  async batchCreate(items: Partial<Omit<T, "id">>[]): Promise<T[]> {
    const response = await this.transport.request<{ items: T[] }>({
      method: "POST",
      path: `${this.resourcePath}/batch`,
      body: { items },
    });

    return response.data.items;
  }

  async batchUpdate(filter: string, data: Partial<T>): Promise<{ count: number }> {
    const response = await this.transport.request<{ count: number }>({
      method: "PATCH",
      path: `${this.resourcePath}/batch`,
      params: { filter },
      body: data,
    });

    return response.data;
  }

  async batchDelete(filter: string): Promise<{ count: number }> {
    const response = await this.transport.request<{ count: number }>({
      method: "DELETE",
      path: `${this.resourcePath}/batch`,
      params: { filter },
    });

    return response.data;
  }

  subscribe(
    options: SubscribeOptions = {},
    callbacks: SubscriptionCallbacks<T> = {}
  ): Subscription<T> {
    return createSubscription({
      transport: this.transport,
      resourcePath: this.resourcePath,
      idField: this.idField,
      options,
      callbacks,
    });
  }

  rpc<N extends keyof P>(name: N, input: P[N]["input"]): Promise<P[N]["output"]>;
  rpc<TInput = unknown, TOutput = unknown>(
    name: [keyof P] extends [never] ? string : never,
    input: TInput
  ): Promise<TOutput>;
  async rpc(name: PropertyKey, input: unknown): Promise<unknown> {
    const response = await this.transport.request<{ data: unknown }>({
      method: "POST",
      path: `${this.resourcePath}/rpc/${String(name)}`,
      body: input,
    });

    return response.data.data;
  }

  query(): ResourceQueryBuilder<T> {
    return new ResourceQueryBuilder<T>(this.transport, this.resourcePath);
  }
}

export const createRepository = <
  T extends { id: string },
  P extends Record<keyof P, ProcedureDef> = AnyProcedures
>(
  config: RepositoryConfig
): ResourceClient<T, P> => {
  return new Repository<T, P>(config);
};
