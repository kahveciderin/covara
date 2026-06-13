# Server-rendered htmx — Overview

> **Beta.** Server-rendered htmx support is newer than Covara's JSON API and TypeScript client and may still change between releases. The JSON API and subscription engine it builds on are stable.

Covara can serve a complete, **server-rendered, real-time UI with htmx** — list, create, update, delete, live updates, live aggregates, optimistic updates and offline — from a **single JSX page**. You write the page; Covara generates the htmx endpoints.

The package subpath is `covara/htmx`.

## The idea: the JSX page is the spec

You register one JSX component per route with `app.page(path, Component)`. Inside it, **`<Live>` is the only special element** — it declares a resource, a query, and how a row renders. Everything else is plain JSX/HTML wired with **boring attribute helpers** from the row/region context (`c`). Covara introspects the page and **auto-generates the htmx endpoints** it needs:

| Generated endpoint | Purpose |
| --- | --- |
| `GET <page>` | Full server-side render of the page |
| `GET /__covara/live/<regionId>` | List / pagination fragment |
| `POST /__covara/live/<regionId>` | Create → returns the rendered row |
| `PATCH \| DELETE /__covara/live/<regionId>/<id>` | Update / delete |
| `GET /__covara/live/<regionId>/subscribe` | Live SSE stream of server-rendered fragments |

All generated endpoints reuse the resource's own query/validation/scope engine, and the live stream reuses the existing subscription engine — Covara only adds the HTML rendering. The generated endpoints live under the framework-internal `/__covara/live` namespace, so they never collide with your routes.

## A complete page

```tsx
app.page("/todos", ({ user }) => (
  <Live
    resource={todos}
    query={{ filter: "done==false", orderBy: "position", limit: 50 }}
    create={(c) => (
      <form {...c.create()}>
        <input name="title" />
        <button>Add</button>
      </form>
    )}
    container={(rows, c) => <ul {...c.container()}>{rows}</ul>}
    empty={() => <li class="muted">No todos</li>}
    render={(todo, c) => (
      <li {...c.row(todo.id)}>
        <input type="checkbox" name="done" hx-patch={`/api/todos/${todo.id}`} hx-vals='{"done":true}' />
        {todo.title}
        <button {...c.delete(todo.id)}>Delete</button>
      </li>
    )}
  />
));
```

Covara generates wiring, **not UI components**. You spread `c.create()`, `c.row(id)`, `c.update(id)`, `c.delete(id)`, `c.container()` onto your own elements.

## What the helpers emit

```ts
c.row("42")      // { id: "cv-todos-0-42", "data-covara-id": "42" }
c.create()       // { "hx-post": "/__covara/live/todos-0", "hx-target": "#cv-todos-0-list", "hx-swap": "beforeend" }
c.update("42")   // { "hx-patch": "/__covara/live/todos-0/42", "hx-target": "#cv-todos-0-42", "hx-swap": "outerHTML" }
c.delete("42")   // { "hx-delete": "/__covara/live/todos-0/42", "hx-target": "#cv-todos-0-42", "hx-swap": "outerHTML" }
c.container()    // { id, data-cv-region, data-cv-sse, data-cv-list, data-cv-template }
```

## Live updates

Each `<Live>` container connects to its generated SSE endpoint. When **anyone** mutates the resource (another tab, a background job, a raw query), the subscription engine pushes the change and the server renders just the affected row via your `render` closure. The client applies it by id:

- `added` → insert the rendered row,
- `changed` → replace the row in place,
- `removed` → remove the row,
- `invalidate` → refetch the list.

`<LiveAggregate>` works the same way for aggregates (it re-fetches its fragment when the resource changes).

## Optimistic updates & offline

A new row is inserted exactly once, by the region's live SSE `added` event (the create form posts with `hx-swap="none"`), so it appears identically in every open tab with no duplicate or phantom row. Deletes are optimistic (the row hides immediately and is restored on failure), and create mutations made while offline are queued and replayed on reconnect. Covara also ships a server-derived row `<template>` per page for custom client rendering.

This runs from the bundled client runtime (vendored htmx core + the Covara runtime), served automatically at `/__covara/live/_runtime.js` and injected into every page. See [Building pages](./pages.md) for setup and details.
