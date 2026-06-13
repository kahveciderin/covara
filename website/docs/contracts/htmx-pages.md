# Contract: Server-rendered htmx pages

> **Beta.** The htmx page layer is newer than the rest of Covara; these invariants may evolve while it stabilizes.

Invariants for `app.page(...)` and the `covara/htmx` layer. See [Overview](../htmx/overview.md) and [Building pages](../htmx/pages.md) for usage.

## Region identity

- A page registered at `path` with regions in source order assigns each region a deterministic id: `regionId = slug(path) + "-" + index`, where `slug` lowercases and replaces non-alphanumerics with `-` (`/` → `root`).
- `regionId` is stable across requests and deploys **as long as region order is unchanged**. Reordering regions changes ids; an in-flight client reconnect then refetches rather than mis-targets.

## DOM ids

- Container: `cv-<regionId>-list`. Row: `cv-<regionId>-<domSafeId(id)>`. Template: `cv-<regionId>-tmpl`.
- `domSafeId` preserves `[A-Za-z0-9_-]` and hex-escapes other characters, collision-free.

## Generated endpoints (under `/__covara/live`)

- `GET /__covara/live/<regionId>` — list/pagination fragment (rows only, no shell). Honors `?cursor=`.
- `POST /__covara/live/<regionId>` — create; on success returns the rendered row (HTTP 201).
- `PATCH /__covara/live/<regionId>/<id>` — update; returns the rendered row, **or an empty body** when the updated row no longer matches the region's display filter (so an `outerHTML` swap removes it).
- `DELETE /__covara/live/<regionId>/<id>` — delete; returns an empty body.
- `GET /__covara/live/<regionId>/subscribe` — SSE stream.
- `GET /__covara/live/_runtime.js` — the client bundle (htmx core + Covara runtime).
- Aggregate regions reject create/update/delete (404) and their list endpoint returns the aggregate fragment.

All generated endpoints run through the resource engine, inheriting its scope/validation/etag/masking. Auth is forwarded from the inbound request (cookie/authorization) on the in-process dispatch.

## SSE wire format

The live stream reuses the resource's own `/subscribe` endpoint with a one-shot HTML renderer injected via the internal `__cvRenderer` token; the resource's scope/resume/heartbeat/backpressure logic is unchanged. Named events:

| Event | `data` | Client action |
| --- | --- | --- |
| `added`, `changed` | rendered row HTML | upsert by row id |
| `removed` | the row's DOM id | remove that element |
| `aggregate`-region change | `invalidate` (no payload) | refetch the aggregate fragment |
| `invalidate` | optional reason | refetch the list |

The JSON wire format of `/subscribe` is unchanged when no `__cvRenderer` token is present (the per-handler renderer defaults to JSON).

## Optimistic / offline

- **Create is inserted once, by the region's live SSE `added` event.** The create form posts with `hx-swap="none"` (its HTML response is not swapped in), so the new row is never inserted twice — it appears via the same SSE path in every connected client, including the acting one. No optimistic placeholder is used for create (an earlier placeholder caused a duplicate/phantom row).
- **Delete** is optimistic: the row is hidden immediately and restored if the request fails; on success it is removed by the response swap / SSE `removed` event.
- Per-request optimistic state is correlated across the `htmx:beforeRequest`/`htmx:afterRequest` events via the shared `xhr` (their `event.detail` objects are NOT shared).
- The SSE `added`/`changed` handlers upsert by row id, so a row already present is replaced rather than duplicated.
- Each page also ships a `<template id="cv-<regionId>-tmpl">` whose contents are the row markup with `{{field}}` slots (derived by rendering the row closure against a field-recording proxy; the sentinel uses only `[A-Za-z0-9_]` so it survives HTML text, `domSafeId`, and URL-encoding, normalized to `{{field}}`) — available for custom client rendering.
- Offline create mutations are queued in `localStorage` (`cv-offline-queue`) and replayed on `online`, after which affected regions resync.

## Rendering rules

- Page shells render synchronously; data fetching is per-region. Async page shells throw.
- Page components must be pure functions of their context (re-run to resolve regions for the generated endpoints).
- `query.filter` is a display refinement, not a security boundary; row-level access is enforced by the resource's `auth` scope.
