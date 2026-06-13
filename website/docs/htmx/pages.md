# Building pages

> **Beta.** The server-rendered htmx layer is newer than the rest of Covara and its API may still change.

## Enable JSX

The `<Live>`/`<LiveAggregate>` elements are [hono/jsx](https://hono.dev/docs/guides/jsx) components. Configure your app's `tsconfig.json` for hono's JSX runtime:

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "hono/jsx"
  }
}
```

You can also skip JSX entirely and call `jsx()` / use the `html` tagged template — the closures only need to return a string-coercible value. JSX is recommended.

## Register a page

```tsx
import { createCovara } from "covara/server";
import { Live } from "covara/htmx";
import { todos } from "./schema";

const app = createCovara()
  .resource("/todos", todos, { id: todos.id, db })
  .page("/todos", ({ user }) => (
    <Live
      resource={todos}
      query={{ orderBy: "position" }}
      create={(c) => (
        <form {...c.create()}>
          <input name="title" />
          <button>Add</button>
        </form>
      )}
      container={(rows, c) => <ul {...c.container()}>{rows}</ul>}
      render={(t, c) => (
        <li {...c.row(t.id)}>
          {t.title}
          <button {...c.delete(t.id)}>Delete</button>
        </li>
      )}
    />
  ));
```

`GET /todos` now returns a full server-rendered page, and the generated endpoints under `/__covara/live/todos-0` handle list/create/update/delete/subscribe. The page must reference a resource that was registered with `.resource(...)` on the same app.

## The client bundle

A bundle (vendored htmx core + the Covara live runtime) is served at `/__covara/live/_runtime.js` and a `<script>` for it is appended to every page automatically — nothing to wire up. To serve/inline it yourself:

```ts
import { serveHtmxBundle, htmxBundle } from "covara/htmx";

app.get("/assets/covara.js", serveHtmxBundle());
// or: const js = htmxBundle();
```

## Pages must render synchronously

A page component runs synchronously: each `<Live>` returns a placeholder immediately and the framework fetches that region's data afterwards. Don't use async components in the page shell (data fetching is per-`<Live>`, handled for you). Page components must also be **pure functions of their context** — they are re-run to resolve regions for the generated endpoints.

## Filters are display refinements, not security

`query.filter` is a UX refinement (e.g. `done==false`), captured per request. **Row-level access control must come from the resource's `auth` scope** — it is enforced on every generated endpoint (list, mutate, subscribe), because they run through the resource engine. Never rely on a `<Live>` filter for security.

When an update moves a row out of a region's filter (e.g. toggling `done` on a `done==false` list), the update endpoint returns an empty body so the row is removed for the acting client; other clients get the correct `removed` event over SSE.

## Live updates

The container connects to its SSE endpoint and applies server-rendered fragments by id. The initial rows are SSR'd, so the stream uses `skipExisting` and the client de-duplicates by row id. Reconnection, sequence-gap recovery and backpressure are handled by the existing subscription engine.

## Live updates, optimism & offline

- **Create** is inserted exactly once by the region's live SSE `added` event — the same path every connected client uses. The create form posts with `hx-swap="none"` (its response is not swapped in), so there is no duplicate or phantom row, and the new row appears identically in every open tab.
- **Delete** hides the row immediately (optimistic) and removes it on success; on failure the row is restored.
- **Update** swaps the affected row in place from the server's response and is reconciled by the SSE `changed` event.
- **Offline**: failed create mutations are queued in `localStorage` and replayed on reconnect, after which affected regions resync.

The server still ships a per-region `<template>` of the row markup (derived from your `render` closure); it is available for custom client behavior but the default flow relies on the SSE insert to keep create duplication-free.

## Live aggregates

```tsx
import { LiveAggregate } from "covara/htmx";

app.page("/stats", () => (
  <LiveAggregate
    resource={todos}
    groupBy={["done"]}
    render={(data) => <span>{(data?.groups ?? []).length} groups</span>}
  />
));
```

The aggregate fragment is server-rendered on load and re-fetched whenever the underlying resource changes.

## CSP

The page and generated endpoints inherit your app's security headers. The attribute-driven htmx + the served runtime need `script-src 'self'` and `connect-src 'self'` (for the SSE stream); no `'unsafe-inline'` is required.
