# Email

Concave ships a small, provider-agnostic email layer: a unified `EmailAdapter`
interface, adapters for **Resend** and the **Cloudflare Email Service**, and a
fluent **template builder** that renders responsive, client-safe HTML plus a
plaintext fallback.

Import from `@kahveciderin/concave` or the `@kahveciderin/concave/email` subpath.

## Configure an adapter

```typescript
import { createResendAdapter, setGlobalEmail } from "@kahveciderin/concave/email";

setGlobalEmail(createResendAdapter({ apiKey: process.env.RESEND_API_KEY! }));
```

On Cloudflare Workers, use the Email Service binding (no API key, no network
egress):

```typescript
import { createCloudflareEmailAdapter, setGlobalEmail } from "@kahveciderin/concave/email";

// `env.EMAIL` is your configured Email Service binding (wrangler.toml).
setGlobalEmail(createCloudflareEmailAdapter({ binding: env.EMAIL, from: "noreply@acme.com" }));
```

## Sending

```typescript
import { sendEmail, sendEmailBatch } from "@kahveciderin/concave/email";

await sendEmail({
  from: "Acme <noreply@acme.com>",
  to: "user@example.com",
  subject: "Welcome",
  html: "<h1>Welcome</h1>",
  text: "Welcome",
});

await sendEmailBatch([msg1, msg2]); // uses the adapter's batch API when available
```

`EmailMessage` fields: `from`, `to`, `subject`, `html`, `text`, `cc`, `bcc`,
`replyTo`, `attachments` (`{ filename, content, contentType }`), `headers`,
`tags`. Addresses accept `"a@b.com"`, `{ email, name }`, or arrays of either.

`sendEmail` returns `{ id?, provider }`.

## Template builder

`createEmail(theme?)` returns a fluent builder. `.build()` returns
`{ html, text }`. All user-supplied content is HTML-escaped automatically.

```typescript
import { createEmail, sendEmail } from "@kahveciderin/concave/email";

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

`heading(text, level?)`, `text(text)`, `button(label, url)`, `link(label, url)`,
`divider()`, `spacer(px?)`, `image(url, alt?)`, `code(text)`, `footer(text)`,
`raw(html, text)`, and `preview(text)` (hidden inbox preview line).

### Theme (`EmailTheme`)

`brandColor`, `textColor`, `mutedColor`, `backgroundColor`, `bodyColor`,
`fontFamily`, `borderRadius`, `width`, `logoUrl`, `logoAlt`. All optional; sane
defaults are applied.

## Using with auth flows

The auth verification / password-reset / magic-link flows take app-provided
`sendToken`/`sendLink` callbacks — render an email with the builder and send it:

```typescript
useAuth({
  // ...
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

## Notes

- Sends are best-effort and return the provider's message id; there is no
  built-in retry queue. For guaranteed delivery, send from a [background
  task](./tasks.md) (which gives you retries + DLQ) rather than inline in a
  request handler.
- Both adapters are Workers-safe (Resend via `fetch`, Cloudflare via the binding).
