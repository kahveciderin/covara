import { TableConfig, Table } from "drizzle-orm";
import { LifecycleHooks, ProcedureContext } from "@/resource/types";
import { TaskDefinition, ScheduleOptions } from "./types";
import { TaskScheduler, getTaskScheduler } from "./scheduler";

export interface ResourceTaskTrigger<TInput = unknown> {
  task: TaskDefinition<TInput>;
  when?: (data: unknown) => boolean;
  transform?: (data: unknown) => TInput;
  delay?: number;
}

export interface ResourceTaskConfig {
  onCreate?: ResourceTaskTrigger[];
  onUpdate?: ResourceTaskTrigger[];
  onDelete?: ResourceTaskTrigger[];
}

export const createTaskTriggerHooks = <TConfig extends TableConfig>(
  schedulerOrConfig: TaskScheduler | ResourceTaskConfig,
  configOrUndefined?: ResourceTaskConfig
): LifecycleHooks<TConfig> => {
  const scheduler =
    "enqueue" in schedulerOrConfig
      ? schedulerOrConfig
      : getTaskScheduler();
  const config =
    "enqueue" in schedulerOrConfig ? configOrUndefined! : schedulerOrConfig;

  const triggerTasks = async (
    triggers: ResourceTaskTrigger[] | undefined,
    event: string,
    data: unknown,
    ctx: ProcedureContext<TConfig>
  ): Promise<void> => {
    if (!triggers) return;

    for (const trigger of triggers) {
      if (trigger.when && !trigger.when(data)) continue;

      const input = trigger.transform
        ? trigger.transform(data)
        : {
            event,
            resource: (ctx.schema as Table<TConfig>)._?.name ?? "unknown",
            data,
            userId: ctx.user?.id,
          };

      const options: ScheduleOptions = {};
      if (trigger.delay) {
        options.delay = trigger.delay;
      }

      if (trigger.delay) {
        await scheduler.schedule(trigger.task as TaskDefinition, input, options);
      } else {
        await scheduler.enqueue(trigger.task as TaskDefinition, input);
      }
    }
  };

  return {
    onAfterCreate: config.onCreate
      ? async (ctx, created) => {
          await triggerTasks(config.onCreate, "create", created, ctx);
        }
      : undefined,

    onAfterUpdate: config.onUpdate
      ? async (ctx, updated) => {
          await triggerTasks(config.onUpdate, "update", updated, ctx);
        }
      : undefined,

    onAfterDelete: config.onDelete
      ? async (ctx, deleted) => {
          await triggerTasks(config.onDelete, "delete", deleted, ctx);
        }
      : undefined,
  };
};

export const composeHooks = <TConfig extends TableConfig>(
  ...hooks: (LifecycleHooks<TConfig> | undefined)[]
): LifecycleHooks<TConfig> => {
  const compose = <T extends keyof LifecycleHooks<TConfig>>(
    hookName: T
  ): LifecycleHooks<TConfig>[T] | undefined => {
    const fns = hooks
      .filter((h): h is LifecycleHooks<TConfig> => h !== undefined)
      .map((h) => h[hookName])
      .filter(
        (fn): fn is NonNullable<LifecycleHooks<TConfig>[T]> => fn !== undefined
      );

    if (fns.length === 0) return undefined;

    if (hookName === "onBeforeCreate" || hookName === "onBeforeUpdate") {
      return (async (ctx: ProcedureContext<TConfig>, data: unknown) => {
        let result = data;
        for (const fn of fns) {
          const transformed = await (fn as (...args: unknown[]) => unknown)(ctx, result);
          if (transformed !== undefined) {
            result = transformed;
          }
        }
        return result;
      }) as LifecycleHooks<TConfig>[T];
    }

    return (async (ctx: ProcedureContext<TConfig>, ...args: unknown[]) => {
      for (const fn of fns) {
        await (fn as (...args: unknown[]) => unknown)(ctx, ...args);
      }
    }) as LifecycleHooks<TConfig>[T];
  };

  return {
    onBeforeCreate: compose("onBeforeCreate"),
    onAfterCreate: compose("onAfterCreate"),
    onBeforeUpdate: compose("onBeforeUpdate"),
    onAfterUpdate: compose("onAfterUpdate"),
    onBeforeDelete: compose("onBeforeDelete"),
    onAfterDelete: compose("onAfterDelete"),
  };
};
