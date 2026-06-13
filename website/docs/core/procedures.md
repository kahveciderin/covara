---
id: procedures
title: Procedures & lifecycle hooks
sidebar_label: Procedures & hooks
description: Custom Zod-validated RPC endpoints and before/after lifecycle hooks on every CRUD operation, with automatic mutation tracking and hook composition helpers.
---

# Procedures & lifecycle hooks

Covara gives you two extension points for business logic on a resource: **RPC procedures** (custom validated endpoints) and **lifecycle hooks** (before/after every CRUD operation).

## RPC procedures

`defineProcedure` creates a Zod-validated endpoint mounted at `POST /rpc/:name`.

```typescript
import { defineProcedure } from "covara";
import { z } from "zod";
import { eq } from "drizzle-orm";

useResource(postsTable, {
  id: postsTable.id,
  db,
  procedures: {
    publish: defineProcedure({
      input: z.object({ id: z.string(), scheduledAt: z.string().datetime().optional() }),
      output: z.object({ success: z.boolean(), publishedAt: z.string().datetime() }),
      handler: async (ctx, input) => {
        if (!ctx.user) throw new Error("Not authenticated");
        const publishedAt = input.scheduledAt ?? new Date().toISOString();
        await ctx.db
          .update(postsTable)
          .set({ published: true, publishedAt: new Date(publishedAt) })
          .where(eq(postsTable.id, input.id))
          .returning();
        return { success: true, publishedAt };
      },
    }),
  },
});
```

```bash
POST /api/posts/rpc/publish
Content-Type: application/json

{ "id": "post-123" }
```

Input is validated against the `input` schema (`422` on failure) and the result against `output`.

### Procedure context

```typescript
interface ProcedureContext {
  db: TrackedDatabase;      // tracked db — mutations auto-recorded for this resource
  schema: Table;            // the Drizzle table
  user: UserContext | null; // authenticated user
  req: Request | null;      // raw web Request
  context: Context | null;  // Hono Context (headers, cookies, ...)
}
```

`ctx.db` is automatically [tracked](../realtime/mutation-tracking.md) for the current resource, so mutations made through it record to the changelog and push to subscribers with no extra code.

### Multi-table tracking

If a procedure mutates several tables, wrap your db once at startup and pass it as `config.db`:

```typescript
import { trackMutations } from "covara";

const trackedDb = trackMutations(baseDb, {
  posts: { table: postsTable, id: postsTable.id },
  notifications: { table: notificationsTable, id: notificationsTable.id },
});

useResource(postsTable, {
  id: postsTable.id,
  db: trackedDb, // already tracked — not double-wrapped
  procedures: {
    publish: defineProcedure({
      handler: async (ctx, input) => {
        await ctx.db.update(postsTable).set({ published: true }).where(eq(postsTable.id, input.id)).returning();
        await ctx.db.insert(notificationsTable).values({ type: "post_published", postId: input.id }).returning();
        return { success: true };
      },
    }),
  },
});
```

See [Mutation tracking](../realtime/mutation-tracking.md).

:::warning Deprecated
The `writeEffects` property is deprecated. Use `trackMutations` and `ctx.db` for accurate subscription updates.
:::

## Lifecycle hooks

Run code before/after each operation. `onBefore*` hooks can transform the payload (return the modified data) or throw to cancel.

```typescript
useResource(postsTable, {
  id: postsTable.id,
  db,
  hooks: {
    onBeforeCreate: async (ctx, data) => ({ ...data, authorId: ctx.user?.id, createdAt: new Date() }),
    onAfterCreate: async (ctx, created) => { await sendNotification("New post"); },
    onBeforeUpdate: async (ctx, id, data) => ({ ...data, updatedAt: new Date() }),
    onAfterUpdate: async (ctx, updated) => { await reindex(updated); },
    onBeforeDelete: async (ctx, id) => {
      const post = await db.query.posts.findFirst({ where: eq(postsTable.id, id) });
      if (post?.protected) throw new Error("Cannot delete protected post");
    },
    onAfterDelete: async (ctx, deleted) => { await cleanupComments(deleted.id); },
  },
});
```

Hooks run for the equivalent batch operations too (`onBeforeCreate` per item on `POST /batch`, etc.). Field stripping from [`fields.writable`](./fields.md) happens **before** `onBefore*` hooks, so a hook can still set protected columns.

## Composing hooks

```typescript
import { composeHooks, createTimestampHooks } from "covara";

const auditHooks = {
  onAfterCreate: async (ctx, created) => logAudit("create", ctx.user?.id, created.id),
  onAfterUpdate: async (ctx, updated) => logAudit("update", ctx.user?.id, updated.id),
  onAfterDelete: async (ctx, deleted) => logAudit("delete", ctx.user?.id, deleted.id),
};

useResource(postsTable, {
  id: postsTable.id,
  db,
  hooks: composeHooks(
    createTimestampHooks(),                                  // createdAt/updatedAt
    auditHooks,                                              // audit logging
    { onBeforeCreate: async (ctx, data) => ({ ...data, slug: slugify(data.title) }) },
  ),
});
```

`composeHooks` runs `onBefore*` hooks left-to-right (each receiving the previous one's output) and `onAfter*` hooks in order.

## Related

- [Mutation tracking](../realtime/mutation-tracking.md) · [Subscriptions](../realtime/subscriptions.md)
- [Fields](./fields.md) · [Authorization scopes](../auth/scopes.md) · [Background tasks](../platform/tasks.md)
