import { Hono, type Context } from "hono";
import { Table, TableConfig, InferSelectModel, InferInsertModel } from "drizzle-orm";
import { readJsonBody } from "@/server/request";
import { ZodError } from "zod";
import {
  ProcedureDefinition,
  ProcedureContext,
  LifecycleHooks,
  WriteEffect,
  UserContext,
  DrizzleDatabase,
} from "./types";
import { ValidationError, ResourceError } from "./error";

export interface ProcedureRegistry<TConfig extends TableConfig = TableConfig> {
  procedures: Record<string, ProcedureDefinition>;
  hooks: LifecycleHooks<TConfig>;
}

export const executeProcedure = async <TInput, TOutput>(
  procedure: ProcedureDefinition<TInput, TOutput>,
  ctx: ProcedureContext,
  rawInput: unknown
): Promise<TOutput> => {
  let input: TInput;
  if (procedure.input) {
    try {
      input = procedure.input.parse(rawInput);
    } catch (error) {
      if (error instanceof ZodError) {
        throw new ValidationError("Invalid procedure input", {
          errors: error.issues.map((e) => ({
            path: e.path.join("."),
            message: e.message,
          })),
        });
      }
      throw error;
    }
  } else {
    input = rawInput as TInput;
  }

  const output = await procedure.handler(ctx, input);

  if (procedure.output) {
    try {
      return procedure.output.parse(output);
    } catch (error) {
      if (error instanceof ZodError) {
        console.error("Procedure output validation failed:", error.issues);
        throw new ResourceError(
          "Internal error: procedure output validation failed",
          500,
          "OUTPUT_VALIDATION_ERROR"
        );
      }
      throw error;
    }
  }

  return output;
};

export const createProcedureRouter = <TConfig extends TableConfig>(
  resourceName: string,
  schema: Table<TConfig>,
  procedures: Record<string, ProcedureDefinition>,
  getDb: () => unknown,
  getUser: (c: Context) => UserContext | null
): Hono => {
  const router = new Hono();

  for (const [name, procedure] of Object.entries(procedures)) {
    router.post(`/${name}`, async (c) => {
      const user = getUser(c);
      const ctx: ProcedureContext<TConfig> = {
        db: getDb(),
        schema,
        user,
        req: c.req.raw,
        context: c,
      };

      const result = await executeProcedure(procedure, ctx, await readJsonBody(c));
      return c.json({ data: result });
    });
  }

  return router;
};

export const executeBeforeCreate = async <TConfig extends TableConfig>(
  hooks: LifecycleHooks<TConfig> | undefined,
  ctx: ProcedureContext<TConfig>,
  data: InferInsertModel<Table<TConfig>>
): Promise<InferInsertModel<Table<TConfig>>> => {
  if (!hooks?.onBeforeCreate) return data;
  const result = await hooks.onBeforeCreate(ctx, data);
  return result ?? data;
};

export const executeAfterCreate = async <TConfig extends TableConfig>(
  hooks: LifecycleHooks<TConfig> | undefined,
  ctx: ProcedureContext<TConfig>,
  created: InferSelectModel<Table<TConfig>>
): Promise<void> => {
  if (!hooks?.onAfterCreate) return;
  await hooks.onAfterCreate(ctx, created);
};

export const executeBeforeUpdate = async <TConfig extends TableConfig>(
  hooks: LifecycleHooks<TConfig> | undefined,
  ctx: ProcedureContext<TConfig>,
  id: string,
  data: Partial<InferSelectModel<Table<TConfig>>>
): Promise<Partial<InferSelectModel<Table<TConfig>>>> => {
  if (!hooks?.onBeforeUpdate) return data;
  const result = await hooks.onBeforeUpdate(ctx, id, data);
  return result ?? data;
};

export const executeAfterUpdate = async <TConfig extends TableConfig>(
  hooks: LifecycleHooks<TConfig> | undefined,
  ctx: ProcedureContext<TConfig>,
  updated: InferSelectModel<Table<TConfig>>
): Promise<void> => {
  if (!hooks?.onAfterUpdate) return;
  await hooks.onAfterUpdate(ctx, updated);
};

export const executeBeforeDelete = async <TConfig extends TableConfig>(
  hooks: LifecycleHooks<TConfig> | undefined,
  ctx: ProcedureContext<TConfig>,
  id: string
): Promise<void> => {
  if (!hooks?.onBeforeDelete) return;
  await hooks.onBeforeDelete(ctx, id);
};

export const executeAfterDelete = async <TConfig extends TableConfig>(
  hooks: LifecycleHooks<TConfig> | undefined,
  ctx: ProcedureContext<TConfig>,
  deleted: InferSelectModel<Table<TConfig>>
): Promise<void> => {
  if (!hooks?.onAfterDelete) return;
  await hooks.onAfterDelete(ctx, deleted);
};

export const defineProcedure = <
  TInput,
  TOutput,
  TDb extends DrizzleDatabase = DrizzleDatabase,
>(
  definition: ProcedureDefinition<TInput, TOutput, TDb>
): ProcedureDefinition<TInput, TOutput, TDb> => definition;

export const procedureBuilder =
  <TDb extends DrizzleDatabase>() =>
  <TInput, TOutput>(
    definition: ProcedureDefinition<TInput, TOutput, TDb>
  ): ProcedureDefinition<TInput, TOutput, TDb> =>
    definition;

export const checkWritePermissions = (
  procedure: ProcedureDefinition,
  userPermissions: Set<string>
): boolean => {
  if (!procedure.writeEffects || procedure.writeEffects.length === 0) {
    return true;
  }

  for (const effect of procedure.writeEffects) {
    const permission = `${effect.type}:${effect.resource}`;
    if (!userPermissions.has(permission)) {
      return false;
    }
  }

  return true;
};

export const getWriteEffects = (
  procedure: ProcedureDefinition
): WriteEffect[] => {
  return procedure.writeEffects ?? [];
};

export const createTimestampHooks = <
  TConfig extends TableConfig,
>(): LifecycleHooks<TConfig> => ({
  onBeforeCreate: async (_ctx, data) => ({
    ...data,
    createdAt: new Date(),
    updatedAt: new Date(),
  }),
  onBeforeUpdate: async (_ctx, _id, data) => ({
    ...data,
    updatedAt: new Date(),
  }),
});

export const composeHooks = <TConfig extends TableConfig>(
  ...hookSets: (LifecycleHooks<TConfig> | undefined)[]
): LifecycleHooks<TConfig> => {
  const composed: LifecycleHooks<TConfig> = {};

  const beforeCreateHooks = hookSets
    .map((h) => h?.onBeforeCreate)
    .filter((h): h is NonNullable<typeof h> => h !== undefined);
  if (beforeCreateHooks.length > 0) {
    composed.onBeforeCreate = async (ctx, data) => {
      let result = data;
      for (const hook of beforeCreateHooks) {
        const hookResult = await hook(ctx, result);
        if (hookResult) result = hookResult;
      }
      return result;
    };
  }

  const afterCreateHooks = hookSets
    .map((h) => h?.onAfterCreate)
    .filter((h): h is NonNullable<typeof h> => h !== undefined);
  if (afterCreateHooks.length > 0) {
    composed.onAfterCreate = async (ctx, created) => {
      for (const hook of afterCreateHooks) {
        await hook(ctx, created);
      }
    };
  }

  const beforeUpdateHooks = hookSets
    .map((h) => h?.onBeforeUpdate)
    .filter((h): h is NonNullable<typeof h> => h !== undefined);
  if (beforeUpdateHooks.length > 0) {
    composed.onBeforeUpdate = async (ctx, id, data) => {
      let result = data;
      for (const hook of beforeUpdateHooks) {
        const hookResult = await hook(ctx, id, result);
        if (hookResult) result = hookResult;
      }
      return result;
    };
  }

  const afterUpdateHooks = hookSets
    .map((h) => h?.onAfterUpdate)
    .filter((h): h is NonNullable<typeof h> => h !== undefined);
  if (afterUpdateHooks.length > 0) {
    composed.onAfterUpdate = async (ctx, updated) => {
      for (const hook of afterUpdateHooks) {
        await hook(ctx, updated);
      }
    };
  }

  const beforeDeleteHooks = hookSets
    .map((h) => h?.onBeforeDelete)
    .filter((h): h is NonNullable<typeof h> => h !== undefined);
  if (beforeDeleteHooks.length > 0) {
    composed.onBeforeDelete = async (ctx, id) => {
      for (const hook of beforeDeleteHooks) {
        await hook(ctx, id);
      }
    };
  }

  const afterDeleteHooks = hookSets
    .map((h) => h?.onAfterDelete)
    .filter((h): h is NonNullable<typeof h> => h !== undefined);
  if (afterDeleteHooks.length > 0) {
    composed.onAfterDelete = async (ctx, deleted) => {
      for (const hook of afterDeleteHooks) {
        await hook(ctx, deleted);
      }
    };
  }

  return composed;
};

export const getProcedureNames = (
  procedures: Record<string, ProcedureDefinition>
): string[] => Object.keys(procedures);

export const getProcedureInfo = (
  name: string,
  procedure: ProcedureDefinition
): {
  name: string;
  hasInput: boolean;
  hasOutput: boolean;
  writeEffects: WriteEffect[];
} => ({
  name,
  hasInput: procedure.input !== undefined,
  hasOutput: procedure.output !== undefined,
  writeEffects: procedure.writeEffects ?? [],
});
