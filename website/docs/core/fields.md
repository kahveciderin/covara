---
id: fields
title: "Fields: masking, writable, computed"
sidebar_label: Fields & masking
description: Field-level read masking, enforced writable allowlists (mass-assignment protection), filterable/sortable allowlists, strictInput, generated fields, and computed virtual fields.
---

# Fields: masking, writable, computed

The `fields` config controls, per column, what clients can **read**, **write**, **filter**, and **sort** by. Combined with `computed`, `generatedFields`, and `strictInput`, it gives you defense against mass-assignment and over-exposure with no extra code.

```typescript
useResource(usersTable, {
  id: usersTable.id,
  db,
  fields: {
    readable: ["id", "name", "email", "createdAt"],
    writable: ["name", "email"],
    filterable: ["name", "email", "createdAt"],
    sortable: ["name", "createdAt"],
  },
});
```

## Read masking — `fields.readable`

When set, `readable` is an **allowlist of table columns** that may leave the server. Any column not listed is stripped from **every** response — list, get, create, update, batch, search — and from **every** subscription event (`existing`, `added`, `changed`) and the initial snapshot.

The mask is applied server-side, so a client **cannot** recover a hidden column via `?select=` or by subscribing:

```typescript
fields: {
  // passwordHash, internalNotes, etc. are never returned, regardless of ?select=
  readable: ["id", "name", "email", "createdAt"],
}
```

Only **table columns** are masked. [Relation keys](./relations.md) (loaded via `?include=`), [computed values](#computed-fields), and internal markers like `_etag`/`_optimisticId` always pass through, so includes keep working. See the [auth contract](../contracts/auth.md) for the guarantee.

## Write enforcement — `fields.writable` (mass-assignment protection) {#write-enforcement-fieldswritable-mass-assignment-protection}

When set, `writable` is an **enforced allowlist** of table columns a client may set on create/update. Any table column not listed is silently stripped from the incoming body **before** it reaches lifecycle hooks or the database — on `POST /`, `PATCH /:id`, `PUT /:id`, `POST /batch`, `PATCH /batch`, and `POST /batch/upsert`.

This stops a malicious client from setting protected columns (e.g. `role`, `isAdmin`, `ownerId`) by smuggling them into a body.

**Exemptions:**

- The **primary key** (`id`) is never stripped.
- Columns in [`generatedFields`](#generated-fields) are never stripped.
- Non-column keys (relation payloads for [nested writes](./nested-writes.md), etc.) always pass through — only real table columns are subject to the allowlist.

Stripping happens **before** hooks run, so a server-side `onBeforeCreate`/`onBeforeUpdate` can still set a protected field itself:

```typescript
hooks: {
  onBeforeCreate: async (ctx, data) => ({ ...data, ownerId: ctx.user.id }), // ownerId set server-side
}
```

See [Secure queries](../auth/secure-queries.md) for the broader pattern.

## Filter & sort allowlists

- `fields.filterable` — only these columns may appear in [`?filter=`](./filtering.md); others return a `400 FilterParseError`.
- `fields.sortable` — only these columns may appear in `?orderBy=`.

Use these to prevent clients from filtering/sorting on sensitive or unindexed columns.

## `strictInput`

By default, unknown fields in a body are silently ignored. Set `strictInput: true` to reject them with a `422` (Zod strict mode):

```typescript
{ strictInput: true }
```

`generatedFields` may still be omitted. Combine `strictInput` (reject unknown fields) with `fields.writable` (strip known-but-not-writable columns) for the strictest input handling.

## Generated fields

`generatedFields` marks columns the server fills in (id, timestamps, ownership). They are:

- exempt from `fields.writable` stripping (a hook can set them),
- optional in inbound bodies even under `strictInput`.

```typescript
{ generatedFields: ["id", "userId", "createdAt", "updatedAt"] }
```

## Computed fields

Virtual fields added to every response and subscription event, computed from the **full, unmasked row** and never persisted:

```typescript
computed: {
  fullName: (row) => `${row.firstName} ${row.lastName}`,
  isOverdue: (row) => row.dueAt != null && Date.parse(row.dueAt) < Date.now(),
}
```

Computed fields:

- appear in list, get, create, update, batch, and search responses, plus every subscription event and the initial snapshot;
- can derive from columns that `fields.readable` hides (they read the unmasked row);
- are **exempt from read masking** (not table columns), so the `readable` allowlist never strips them;
- are not written to the database.

## Related

- [Authorization scopes](../auth/scopes.md) · [Secure queries](../auth/secure-queries.md)
- [Filtering](./filtering.md) · [Relations](./relations.md) · [Auth contract](../contracts/auth.md)
