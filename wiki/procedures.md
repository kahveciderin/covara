# Procedures

Procedures allow you to define custom RPC endpoints and lifecycle hooks.

## RPC Procedures

Define custom endpoints on your resource:

```typescript
import { defineProcedure } from "@kahveciderin/concave";
import { z } from "zod";

useResource(postsTable, {
  id: postsTable.id,
  procedures: {
    publish: defineProcedure({
      input: z.object({
        id: z.string(),
        scheduledAt: z.string().datetime().optional(),
      }),
      output: z.object({
        success: z.boolean(),
        publishedAt: z.string().datetime(),
      }),
      handler: async (ctx, input) => {
        if (!ctx.user) {
          throw new Error("Not authenticated");
        }

        const publishedAt = input.scheduledAt ?? new Date().toISOString();

        // Use tracked db for automatic subscription updates
        await db.update(postsTable)
          .set({
            published: true,
            publishedAt: new Date(publishedAt)
          })
          .where(eq(postsTable.id, input.id))
          .returning();

        return { success: true, publishedAt };
      },
    }),
  },
});
```

Usage:

```bash
POST /posts/rpc/publish
{ "id": "post-123" }
```

## Lifecycle Hooks

Execute code before/after CRUD operations:

```typescript
useResource(postsTable, {
  id: postsTable.id,
  hooks: {
    // Before create - modify data or throw to cancel
    onBeforeCreate: async (ctx, data) => {
      return {
        ...data,
        authorId: ctx.user?.id,
        createdAt: new Date(),
      };
    },

    // After create - side effects
    onAfterCreate: async (ctx, created) => {
      await sendNotification("New post created");
      await indexForSearch(created);
    },

    // Before update - validate or modify
    onBeforeUpdate: async (ctx, id, data) => {
      return {
        ...data,
        updatedAt: new Date(),
      };
    },

    // After update
    onAfterUpdate: async (ctx, updated) => {
      await reindexForSearch(updated);
    },

    // Before delete - validation
    onBeforeDelete: async (ctx, id) => {
      const post = await db.query.posts.findFirst({ where: eq(posts.id, id) });
      if (post?.protected) {
        throw new Error("Cannot delete protected post");
      }
    },

    // After delete - cleanup
    onAfterDelete: async (ctx, deleted) => {
      await removeFromSearch(deleted.id);
      await cleanupComments(deleted.id);
    },
  },
});
```

## Composing Hooks

Combine multiple hook sets:

```typescript
import { composeHooks, createTimestampHooks } from "@kahveciderin/concave";

const auditHooks = {
  onAfterCreate: async (ctx, created) => {
    await logAudit("create", ctx.user?.id, created.id);
  },
  onAfterUpdate: async (ctx, updated) => {
    await logAudit("update", ctx.user?.id, updated.id);
  },
  onAfterDelete: async (ctx, deleted) => {
    await logAudit("delete", ctx.user?.id, deleted.id);
  },
};

useResource(postsTable, {
  id: postsTable.id,
  hooks: composeHooks(
    createTimestampHooks(),  // Adds createdAt/updatedAt
    auditHooks,              // Adds audit logging
    {                        // Custom hooks
      onBeforeCreate: async (ctx, data) => {
        return { ...data, slug: slugify(data.title) };
      },
    }
  ),
});
```

## Procedure Context

The context object provides:

```typescript
interface ProcedureContext {
  db: TrackedDatabase;       // Tracked database instance (mutations auto-recorded)
  schema: Table;             // Drizzle table schema
  user: UserContext | null;  // Authenticated user
  req: Request | null;       // Raw web Request
  context: Context | null;   // Hono Context (headers, cookies, etc.)
}
```

## Automatic Mutation Tracking

The `ctx.db` in procedures is automatically tracked for the current resource. Mutations made via `ctx.db` are recorded to the changelog and push updates to subscribers:

```typescript
defineProcedure({
  handler: async (ctx, input) => {
    // ctx.db is automatically tracked - mutations push to subscribers
    const [updated] = await ctx.db.update(postsTable)
      .set({ published: true })
      .where(eq(postsTable.id, input.id))
      .returning();

    return { success: true, post: updated };
  },
});
```

### Multi-Table Tracking

If your procedure modifies multiple tables, pass a pre-configured tracked db to `config.db`:

```typescript
import { trackMutations } from "@kahveciderin/concave";

// Wrap your db instance once at startup with all tables
const trackedDb = trackMutations(baseDb, {
  posts: { table: postsTable, id: postsTable.id },
  users: { table: usersTable, id: usersTable.id },
  notifications: { table: notificationsTable, id: notificationsTable.id },
});

// Pass the tracked db to useResource
app.route("/posts", useResource(postsTable, {
  id: postsTable.id,
  db: trackedDb,  // Already tracked - won't be double-wrapped
  procedures: {
    publish: defineProcedure({
      handler: async (ctx, input) => {
        // Both updates are tracked
        await ctx.db.update(postsTable)
          .set({ published: true })
          .where(eq(postsTable.id, input.id))
          .returning();

        await ctx.db.insert(notificationsTable)
          .values({ type: "post_published", postId: input.id })
          .returning();

        return { success: true };
      },
    }),
  },
}));
```

See [Mutation Tracking](./track-mutations.md) for full documentation.

## Legacy: Write Effects (Deprecated)

The `writeEffects` property is deprecated. Use `trackMutations` instead for automatic, accurate subscription updates.

```typescript
// ❌ Deprecated approach
defineProcedure({
  writeEffects: [
    { type: "update", resource: "posts" },
  ],
  handler: async (ctx, input) => {
    await db.update(postsTable).set({ ... }).where(...);
  },
});

// ✅ Recommended approach
defineProcedure({
  handler: async (ctx, input) => {
    // Use tracked db - updates are automatically recorded
    await trackedDb.update(postsTable).set({ ... }).where(...).returning();
  },
});
```
