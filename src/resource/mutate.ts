import {
  Table,
  TableConfig,
  InferInsertModel,
  InferSelectModel,
  SQL,
  eq,
} from "drizzle-orm";
import { AnyColumn } from "drizzle-orm";
import {
  DrizzleDatabase,
  DrizzleTransaction,
  ProcedureContext,
  LifecycleHooks,
} from "./types";
import {
  executeBeforeCreate,
  executeAfterCreate,
  executeBeforeUpdate,
  executeAfterUpdate,
  executeBeforeDelete,
  executeAfterDelete,
} from "./procedures";
import {
  pushInsertsToSubscriptions,
  pushUpdatesToSubscriptions,
  pushDeletesToSubscriptions,
} from "./subscription";
import { Filter } from "./filter";

export interface ChangelogRecorder {
  recordCreate: (
    resource: string,
    objectId: string,
    object: Record<string, unknown>
  ) => Promise<void>;
  recordUpdate: (
    resource: string,
    objectId: string,
    object: Record<string, unknown>,
    previousObject?: Record<string, unknown>
  ) => Promise<void>;
  recordDelete: (
    resource: string,
    objectId: string,
    previousObject?: Record<string, unknown>
  ) => Promise<void>;
}

export interface MutationResult<T> {
  item: T;
  previousItem?: T;
}

export interface BatchMutationResult<T> {
  items: T[];
  previousItems?: Map<string, T>;
  count: number;
}

export interface MutationOptions {
  bypassScope?: boolean;
  bypassReason?: string;
  skipHooks?: boolean;
  skipChangelog?: boolean;
  skipSubscriptions?: boolean;
}

interface MutationPipelineConfig<TConfig extends TableConfig> {
  schema: Table<TConfig>;
  db: DrizzleDatabase;
  resourceName: string;
  idColumn: AnyColumn;
  idColumnName: string;
  hooks?: LifecycleHooks<TConfig>;
  filterer: Filter;
  changelogRecorder: ChangelogRecorder;
}

export interface MutationPipeline<TConfig extends TableConfig> {
  create(
    ctx: ProcedureContext<TConfig>,
    data: InferInsertModel<Table<TConfig>>,
    options?: MutationOptions
  ): Promise<MutationResult<InferSelectModel<Table<TConfig>>>>;

  update(
    ctx: ProcedureContext<TConfig>,
    id: string,
    data: Partial<InferSelectModel<Table<TConfig>>>,
    filter: SQL<unknown> | undefined,
    options?: MutationOptions
  ): Promise<MutationResult<InferSelectModel<Table<TConfig>>>>;

  replace(
    ctx: ProcedureContext<TConfig>,
    id: string,
    data: InferInsertModel<Table<TConfig>>,
    filter: SQL<unknown> | undefined,
    options?: MutationOptions
  ): Promise<MutationResult<InferSelectModel<Table<TConfig>>>>;

  delete(
    ctx: ProcedureContext<TConfig>,
    id: string,
    filter: SQL<unknown> | undefined,
    options?: MutationOptions
  ): Promise<MutationResult<InferSelectModel<Table<TConfig>>>>;

  batchCreate(
    ctx: ProcedureContext<TConfig>,
    items: InferInsertModel<Table<TConfig>>[],
    options?: MutationOptions
  ): Promise<BatchMutationResult<InferSelectModel<Table<TConfig>>>>;

  batchUpdate(
    ctx: ProcedureContext<TConfig>,
    filter: SQL<unknown> | undefined,
    data: Partial<InferSelectModel<Table<TConfig>>>,
    options?: MutationOptions
  ): Promise<BatchMutationResult<InferSelectModel<Table<TConfig>>>>;

  batchDelete(
    ctx: ProcedureContext<TConfig>,
    filter: SQL<unknown> | undefined,
    options?: MutationOptions
  ): Promise<BatchMutationResult<InferSelectModel<Table<TConfig>>>>;

  withTransaction<R>(
    fn: (tx: DrizzleTransaction) => Promise<R>
  ): Promise<R>;
}

export const createMutationPipeline = <TConfig extends TableConfig>(
  pipelineConfig: MutationPipelineConfig<TConfig>
): MutationPipeline<TConfig> => {
  const {
    schema,
    db,
    resourceName,
    idColumn,
    idColumnName,
    hooks,
    filterer,
    changelogRecorder,
  } = pipelineConfig;

  type SelectModel = InferSelectModel<Table<TConfig>>;
  type InsertModel = InferInsertModel<Table<TConfig>>;

  const logBypass = (reason: string | undefined, operation: string) => {
    if (reason) {
      console.warn(
        JSON.stringify({
          level: "warn",
          type: "mutation_bypass",
          operation,
          reason,
          resource: resourceName,
          timestamp: new Date().toISOString(),
        })
      );
    }
  };

  const pipeline: MutationPipeline<TConfig> = {
    async create(
      ctx: ProcedureContext<TConfig>,
      data: InsertModel,
      options?: MutationOptions
    ): Promise<MutationResult<SelectModel>> {
      if (options?.bypassScope || options?.bypassReason) {
        logBypass(options.bypassReason, "create");
      }

      return db.transaction(async (tx: DrizzleTransaction) => {
        let processedData = data;

        if (!options?.skipHooks && hooks) {
          const result = await executeBeforeCreate(hooks, ctx, data);
          if (result) {
            processedData = result;
          }
        }

        const insertResult = await tx.insert(schema).values(processedData).returning();
        const created = insertResult[0] as SelectModel;
        const createdObj = created as unknown as Record<string, unknown>;
        const id = String(createdObj[idColumnName]);

        if (!options?.skipChangelog) {
          await changelogRecorder.recordCreate(resourceName, id, createdObj);
        }

        if (!options?.skipHooks && hooks) {
          await executeAfterCreate(hooks, ctx, created);
        }

        if (!options?.skipSubscriptions) {
          await pushInsertsToSubscriptions(
            resourceName,
            filterer as any,
            [createdObj],
            idColumnName
          );
        }

        return { item: created };
      });
    },

    async update(
      ctx: ProcedureContext<TConfig>,
      id: string,
      data: Partial<SelectModel>,
      filter: SQL<unknown> | undefined,
      options?: MutationOptions
    ): Promise<MutationResult<SelectModel>> {
      if (options?.bypassScope || options?.bypassReason) {
        logBypass(options.bypassReason, "update");
      }

      return db.transaction(async (tx: DrizzleTransaction) => {
        const existingResult = await tx.select().from(schema).where(filter);
        const existing = existingResult[0] as SelectModel | undefined;

        if (!existing) {
          throw new Error(`Resource ${resourceName} with id '${id}' not found`);
        }

        let processedData = data;

        if (!options?.skipHooks && hooks) {
          const result = await executeBeforeUpdate(hooks, ctx, id, data);
          if (result) {
            processedData = result;
          }
        }

        const updateResult = await tx
          .update(schema)
          .set(processedData as any)
          .where(filter)
          .returning();
        const updated = updateResult[0] as SelectModel;
        const updatedObj = updated as unknown as Record<string, unknown>;
        const existingObj = existing as unknown as Record<string, unknown>;

        if (!options?.skipChangelog) {
          await changelogRecorder.recordUpdate(
            resourceName,
            id,
            updatedObj,
            existingObj
          );
        }

        if (!options?.skipHooks && hooks) {
          await executeAfterUpdate(hooks, ctx, updated);
        }

        if (!options?.skipSubscriptions) {
          const previousMap = new Map<string, Record<string, unknown>>();
          previousMap.set(id, existingObj);
          await pushUpdatesToSubscriptions(
            resourceName,
            filterer as any,
            [updatedObj],
            idColumnName,
            previousMap
          );
        }

        return { item: updated, previousItem: existing };
      });
    },

    async replace(
      ctx: ProcedureContext<TConfig>,
      id: string,
      data: InsertModel,
      filter: SQL<unknown> | undefined,
      options?: MutationOptions
    ): Promise<MutationResult<SelectModel>> {
      return pipeline.update(ctx, id, data as Partial<SelectModel>, filter, options);
    },

    async delete(
      ctx: ProcedureContext<TConfig>,
      id: string,
      filter: SQL<unknown> | undefined,
      options?: MutationOptions
    ): Promise<MutationResult<SelectModel>> {
      if (options?.bypassScope || options?.bypassReason) {
        logBypass(options.bypassReason, "delete");
      }

      return db.transaction(async (tx: DrizzleTransaction) => {
        const existingResult = await tx.select().from(schema).where(filter);
        const existing = existingResult[0] as SelectModel | undefined;

        if (!existing) {
          throw new Error(`Resource ${resourceName} with id '${id}' not found`);
        }

        if (!options?.skipHooks && hooks) {
          await executeBeforeDelete(hooks, ctx, id);
        }

        await tx.delete(schema).where(filter);

        const existingObj = existing as unknown as Record<string, unknown>;

        if (!options?.skipChangelog) {
          await changelogRecorder.recordDelete(resourceName, id, existingObj);
        }

        if (!options?.skipHooks && hooks) {
          await executeAfterDelete(hooks, ctx, existing);
        }

        if (!options?.skipSubscriptions) {
          await pushDeletesToSubscriptions(resourceName, [id]);
        }

        return { item: existing };
      });
    },

    async batchCreate(
      ctx: ProcedureContext<TConfig>,
      items: InsertModel[],
      options?: MutationOptions
    ): Promise<BatchMutationResult<SelectModel>> {
      if (options?.bypassScope || options?.bypassReason) {
        logBypass(options.bypassReason, "batchCreate");
      }

      return db.transaction(async (tx: DrizzleTransaction) => {
        const processedItems: InsertModel[] = [];

        for (const item of items) {
          let processedData = item;
          if (!options?.skipHooks && hooks) {
            const result = await executeBeforeCreate(hooks, ctx, item);
            if (result) {
              processedData = result;
            }
          }
          processedItems.push(processedData);
        }

        const insertResult = await tx.insert(schema).values(processedItems).returning();
        const created = insertResult as SelectModel[];

        for (const item of created) {
          const itemObj = item as unknown as Record<string, unknown>;
          const id = String(itemObj[idColumnName]);

          if (!options?.skipChangelog) {
            await changelogRecorder.recordCreate(resourceName, id, itemObj);
          }

          if (!options?.skipHooks && hooks) {
            await executeAfterCreate(hooks, ctx, item);
          }
        }

        if (!options?.skipSubscriptions) {
          await pushInsertsToSubscriptions(
            resourceName,
            filterer as any,
            created as unknown as Record<string, unknown>[],
            idColumnName
          );
        }

        return { items: created, count: created.length };
      });
    },

    async batchUpdate(
      ctx: ProcedureContext<TConfig>,
      filter: SQL<unknown> | undefined,
      data: Partial<SelectModel>,
      options?: MutationOptions
    ): Promise<BatchMutationResult<SelectModel>> {
      if (options?.bypassScope || options?.bypassReason) {
        logBypass(options.bypassReason, "batchUpdate");
      }

      return db.transaction(async (tx: DrizzleTransaction) => {
        const beforeItems = await tx.select().from(schema).where(filter);
        const previousMap = new Map<string, Record<string, unknown>>();

        let processedData = data;
        for (const item of beforeItems) {
          const itemObj = item as unknown as Record<string, unknown>;
          const id = String(itemObj[idColumnName]);
          previousMap.set(id, itemObj);

          if (!options?.skipHooks && hooks) {
            const result = await executeBeforeUpdate(hooks, ctx, id, data);
            if (result) {
              processedData = result;
            }
          }
        }

        await tx.update(schema).set(processedData as any).where(filter);

        const ids = beforeItems.map(
          (item: unknown) => (item as Record<string, unknown>)[idColumnName]
        );

        const afterItems = await tx
          .select()
          .from(schema)
          .where(
            ids.length > 0
              ? eq(idColumn, ids[0])
              : filter
          );

        for (const item of afterItems) {
          const itemObj = item as unknown as Record<string, unknown>;
          const id = String(itemObj[idColumnName]);
          const previousObj = previousMap.get(id);

          if (!options?.skipChangelog) {
            await changelogRecorder.recordUpdate(
              resourceName,
              id,
              itemObj,
              previousObj
            );
          }

          if (!options?.skipHooks && hooks) {
            await executeAfterUpdate(hooks, ctx, item as SelectModel);
          }
        }

        if (!options?.skipSubscriptions) {
          await pushUpdatesToSubscriptions(
            resourceName,
            filterer as any,
            afterItems as unknown as Record<string, unknown>[],
            idColumnName,
            previousMap
          );
        }

        return {
          items: afterItems as SelectModel[],
          previousItems: previousMap as Map<string, SelectModel>,
          count: afterItems.length,
        };
      });
    },

    async batchDelete(
      ctx: ProcedureContext<TConfig>,
      filter: SQL<unknown> | undefined,
      options?: MutationOptions
    ): Promise<BatchMutationResult<SelectModel>> {
      if (options?.bypassScope || options?.bypassReason) {
        logBypass(options.bypassReason, "batchDelete");
      }

      return db.transaction(async (tx: DrizzleTransaction) => {
        const items = await tx.select().from(schema).where(filter);
        const deletedIds: string[] = [];

        for (const item of items) {
          const itemObj = item as unknown as Record<string, unknown>;
          const id = String(itemObj[idColumnName]);
          deletedIds.push(id);

          if (!options?.skipHooks && hooks) {
            await executeBeforeDelete(hooks, ctx, id);
          }
        }

        await tx.delete(schema).where(filter);

        for (const item of items) {
          const itemObj = item as unknown as Record<string, unknown>;
          const id = String(itemObj[idColumnName]);

          if (!options?.skipChangelog) {
            await changelogRecorder.recordDelete(resourceName, id, itemObj);
          }

          if (!options?.skipHooks && hooks) {
            await executeAfterDelete(hooks, ctx, item as SelectModel);
          }
        }

        if (!options?.skipSubscriptions) {
          await pushDeletesToSubscriptions(resourceName, deletedIds);
        }

        return { items: items as SelectModel[], count: items.length };
      });
    },

    async withTransaction<R>(
      fn: (tx: DrizzleTransaction) => Promise<R>
    ): Promise<R> {
      return db.transaction(fn);
    },
  };

  return pipeline;
};

export const createChangelogRecorder = (
  recordCreate: (
    resource: string,
    objectId: string,
    object: Record<string, unknown>
  ) => Promise<unknown>,
  recordUpdate: (
    resource: string,
    objectId: string,
    object: Record<string, unknown>,
    previousObject?: Record<string, unknown>
  ) => Promise<unknown>,
  recordDelete: (
    resource: string,
    objectId: string,
    previousObject?: Record<string, unknown>
  ) => Promise<unknown>
): ChangelogRecorder => ({
  recordCreate: async (resource, objectId, object) => {
    await recordCreate(resource, objectId, object);
  },
  recordUpdate: async (resource, objectId, object, previousObject) => {
    await recordUpdate(resource, objectId, object, previousObject);
  },
  recordDelete: async (resource, objectId, previousObject) => {
    await recordDelete(resource, objectId, previousObject);
  },
});
