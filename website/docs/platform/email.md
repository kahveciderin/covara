---
id: email
title: Email
sidebar_label: Email
description: A provider-agnostic email layer — Resend and Cloudflare Email Service adapters, durable queued delivery with retries and a DLQ, batch sending, and a fluent template builder that renders escaped responsive HTML plus a plaintext fallback.
---

# Email

Covara ships a small, provider-agnostic email layer: a unified `EmailAdapter` interface, adapters for **Resend** and the **Cloudflare Email Service**, and a fluent **template builder** that renders responsive, client-safe HTML plus a plaintext fallback. Import from `covara` or `covara/email`.

## Configure an adapter

```typescript
import { createResendAdapter, setGlobalEmail } from "covara/email";

setGlobalEmail(createResendAdapter({ apiKey: env.RESEND_API_KEY }));
```

On Cloudflare Workers, use the Email Service binding (no API key, no network egress). Pass the `EmailMessage` class from the `cloudflare:email` built-in as `messageClass` — production `send_email` requires a real `EmailMessage` instance (a plain object fails with a misleading *"text or html must have content"*):

```typescript
import { createCloudflareEmailAdapter, setGlobalEmail } from "covara/email";
import { EmailMessage } from "cloudflare:email";

setGlobalEmail(
  createCloudflareEmailAdapter({
    binding: env.EMAIL,
    from: "noreply@acme.com",
    messageClass: EmailMessage,
  })
);
```

`messageClass` is optional — if omitted, the adapter loads `cloudflare:email` dynamically at send time — but passing it explicitly is recommended (avoids the dynamic import and any bundler edge cases). Both adapters are Workers-safe (Resend via `fetch`, Cloudflare via the binding).

## Sending

```typescript
import { sendEmail, sendEmailBatch } from "covara/email";

await sendEmail({
  from: "Acme <noreply@acme.com>",
  to: "user@example.com",
  subject: "Welcome",
  html: "<h1>Welcome</h1>",
  text: "Welcome",
});

await sendEmailBatch([msg1, msg2]); // uses the adapter's batch API when available
```

`EmailMessage` fields: `from`, `to`, `subject`, `html`, `text`, `cc`, `bcc`, `replyTo`, `attachments` (`{ filename, content, contentType }`), `headers`, `tags`. Addresses accept `"a@b.com"`, `{ email, name }`, or arrays of either. `sendEmail(message, { idempotencyKey? })` returns `{ id?, provider }` (plus `status` / `taskId` from a [durable adapter](#durable-delivery)). Plain adapters are best-effort: a failure throws once with no retry.

## Template builder

`createEmail(theme?)` returns a fluent builder; `.build()` returns `{ html, text }`. All user-supplied content is HTML-escaped automatically.

```typescript
import { createEmail, sendEmail } from "covara/email";

const { html, text } = createEmail({ brandColor: "#4f46e5", logoUrl: "https://cdn.acme.com/logo.png" })
  .preview("Confirm your email address")
  .heading("Confirm your email")
  .text("Tap the button below to verify your account.")
  .button("Verify email", `https://acme.com/verify?token=${token}`)
  .divider()
  .text("Or use this code:")
  .code("123456")
  .footer("If you didn't sign up, you can ignore this email.")
  .build();

await sendEmail({ from: "noreply@acme.com", to: email, subject: "Confirm your email", html, text });
```

### Blocks

`heading(text, level?)`, `text(text)`, `button(label, url)`, `link(label, url)`, `divider()`, `spacer(px?)`, `image(url, alt?)`, `code(text)`, `footer(text)`, `raw(html, text)`, and `preview(text)` (hidden inbox preview line).

### Theme (`EmailTheme`)

`brandColor`, `textColor`, `mutedColor`, `backgroundColor`, `bodyColor`, `fontFamily`, `borderRadius`, `width`, `logoUrl`, `logoAlt` — all optional with sane defaults.

## Using with auth flows

The auth [verification / password-reset](../auth/account-security.md) / [magic-link](../auth/magic-links.md) flows either take app-provided `sendToken`/`sendLink` callbacks, or a `composeEmail` that returns a message for Covara to send through `useAuth({ email: { adapter } })` (default: the global adapter) with a token-derived idempotency key — see [sending the emails](../auth/account-security.md#sending-the-emails). With a callback, render with the builder and send:

```typescript
useAuth({
  verification: {
    async sendToken({ identifier, token }) {
      const { html, text } = createEmail()
        .heading("Verify your email")
        .button("Verify", `https://acme.com/verify?token=${token}`)
        .build();
      await sendEmail({ from: "noreply@acme.com", to: identifier, subject: "Verify your email", html, text });
    },
  },
});
```

## Durable delivery

A plain adapter's `send` is a single HTTP call: if the provider is down or rate-limits you, the error surfaces once and the email is lost. Wrap the adapter with `durableEmail` (alias of `createDurableEmailAdapter`) to route every send through the [task system](./tasks.md):

```typescript
import { createResendAdapter, durableEmail, sendEmail, setGlobalEmail } from "covara/email";
import { createTaskRegistry, createTaskScheduler, startTaskWorkers } from "covara/tasks";

const registry = createTaskRegistry();
const scheduler = createTaskScheduler(kv, registry);

const email = durableEmail(createResendAdapter({ apiKey: env.RESEND_API_KEY }), {
  queue: scheduler,
  retry: { maxAttempts: 6, initialDelayMs: 10_000, maxDelayMs: 15 * 60_000 },
  onDeliveryFailed: ({ messageId, error, attempts, permanent }) =>
    alert(`email ${messageId} dead-lettered after ${attempts} attempt(s): ${error.message}`),
});

registry.register(email.task);
setGlobalEmail(email);
await startTaskWorkers(kv, registry);

const { id, status, taskId } = await sendEmail(message, { idempotencyKey: `welcome:${user.id}` });
// status === "queued"; id is the message id (the idempotency key)
```

`send` serializes the message, enqueues a `covara.email.send` task, and resolves with `{ id, provider, status: "queued", taskId }` without contacting the provider. A worker then performs the real send:

| Failure | Behaviour |
|---------|-----------|
| `4xx` validation / auth (`400`, `401`, `403`, `404`, `422`, …) | **Permanent** — no retry; straight to the DLQ |
| `408`, `409`, `425`, `429`, `5xx`, network errors, unknown throws | **Transient** — retried with exponential backoff + jitter |
| Provider sends `Retry-After` (seconds or HTTP-date) | Next attempt is scheduled exactly that far out, capped at `retry.maxRetryAfterMs` (default 1h) |
| `retry.maxAttempts` (default 6) exhausted | Lands in the task DLQ; `onDeliveryFailed` fires once |

Adapters signal this by throwing `EmailDeliveryError` (`status`, `retryAfterMs`, `permanent`, `provider`, `code`). Throw it from a custom adapter to get the same classification; any other error is treated as transient.

### Idempotency

Every message carries an idempotency key — `send(message, { idempotencyKey })`, or a random UUID when omitted. It is used three ways:

- the task's idempotency key (`covara:email:<key>`), so enqueuing the same key twice while the first is pending returns the same task, and a re-run after completion is skipped;
- passed to the provider adapter: Resend receives it as the `Idempotency-Key` header, so a worker that crashes after Resend accepted the message but before acknowledging the task does not double-send;
- a KV "sent" marker (`covara:email:sent:<key>`, kept for `dedupeTtlMs`, default 7 days) written right after the provider accepts, checked before every attempt. This covers adapters without provider-side idempotency (Cloudflare Email Service). It uses `kv`, or the global KV when one is set; pass `kv: null` to disable it.

### Payload limits

The serialized message (including base64 attachments) must fit in `maxPayloadBytes` (default 120,000 bytes — under the 128 KB Cloudflare Queues message limit). Larger messages are rejected at `send` time with a permanent `EmailDeliveryError` (`code: "payload_too_large"`) and nothing is enqueued; link large files instead of attaching them. `Uint8Array` attachments survive the JSON round-trip and reach the adapter as bytes again.

### Cloudflare Workers

Pass a Cloudflare Queues producer as the queue and run the consumer from your `queue()` handler:

```typescript
const email = durableEmail(
  createCloudflareEmailAdapter({ binding: env.EMAIL, messageClass: EmailMessage }),
  { queue: createCloudflareQueueProducer(env.EMAIL_QUEUE), kv }
);
registry.register(email.task);

export default {
  fetch: app.fetch,
  queue: (batch, env) => createQueueConsumer({ kv, registry }).process(batch),
};
```

A transient failure calls `message.retry({ delaySeconds })` with the backoff (or `Retry-After`), capped at the 12h Queues maximum.

### Without a queue

`durableEmail(adapter)` with no `queue` still works: it sends inline with a small bounded retry (`inline.maxAttempts` 3, 250ms → 2s backoff; a `Retry-After` above `inline.maxRetryAfterMs`, default 5s, gives up immediately) and logs a one-time warning that delivery is **not durable**. Permanent errors are not retried. When all attempts fail, `onDeliveryFailed` fires with `mode: "inline"` and `send` rejects.

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `queue` | — | `TaskScheduler` or Cloudflare Queues producer (anything with `enqueue(task, input)`) |
| `kv` | global KV | KV for the sent-marker; `null` disables it |
| `retry` | `{ maxAttempts: 6, initialDelayMs: 10000, maxDelayMs: 900000, maxRetryAfterMs: 3600000 }` | Queued retry policy |
| `inline` | `{ maxAttempts: 3, initialDelayMs: 250, maxDelayMs: 2000, maxRetryAfterMs: 5000 }` | Inline retry policy (no queue) |
| `maxPayloadBytes` | `120000` | Maximum serialized message size when queued |
| `dedupeTtlMs` | 7 days | Lifetime of the sent-marker |
| `taskName` | `"covara.email.send"` | Task name (register `email.task` on the worker's registry) |
| `priority`, `timeoutMs` | `50`, `30000` | Task priority and per-attempt timeout |
| `onDeliveryFailed` | — | Called once per message that is dead-lettered (or fails inline); errors in the hook are ignored |
| `logger` | `console` | Receives the one-time inline warning |

## Related

- [Background tasks](./tasks.md) · [Account security](../auth/account-security.md) · [Magic links](../auth/magic-links.md)
- [Email contract](../contracts/email.md)
