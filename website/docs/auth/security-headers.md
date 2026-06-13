---
id: security-headers
title: Security headers
sidebar_label: Security headers
description: HSTS, X-Frame-Options, MIME-sniffing protection, Referrer-Policy, and COOP auto-mounted by createCovara, with opt-in Content-Security-Policy.
---

# Security headers

`createCovara` auto-mounts a security-headers middleware that sets sensible defaults on every response. You can tune it, and opt into a Content-Security-Policy (off by default so it never silently blocks your frontend).

## Defaults

| Header | Default value |
|--------|---------------|
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `X-DNS-Prefetch-Control` | `off` |
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `Strict-Transport-Security` | `max-age=15552000; includeSubDomains` (on HTTPS or in production) |
| `Content-Security-Policy` | **not set** (opt-in) |

Each header is set only if absent, so your own routes can override any of them. HSTS is emitted only for HTTPS requests or when `isProduction()` is true.

## Configuring

Pass `securityHeaders` options (the same shape as the standalone middleware):

```typescript
import { createSecurityHeaders, STRICT_API_CSP } from "covara/middleware/securityHeaders";

const headers = createSecurityHeaders({
  contentSecurityPolicy: STRICT_API_CSP, // or your own policy string, or false
  contentTypeOptions: true,
  frameOptions: "DENY",                  // "DENY" | "SAMEORIGIN" | false
  referrerPolicy: "strict-origin-when-cross-origin", // or false
  dnsPrefetchControl: "off",             // or false
  crossOriginOpenerPolicy: "same-origin",// or false
  hsts: { maxAge: 15552000, includeSubDomains: true, preload: false }, // or false
});

app.use("*", headers);
```

## Content-Security-Policy

CSP is **off by default** because it is application-specific — a strict policy right for a JSON-only API will break an app that serves its own frontend. Enable it by passing a policy string.

For a pure JSON API, `STRICT_API_CSP` is a good starting point:

```typescript
import { STRICT_API_CSP } from "covara/middleware/securityHeaders";
// STRICT_API_CSP === "default-src 'none'; frame-ancestors 'none'"

createSecurityHeaders({ contentSecurityPolicy: STRICT_API_CSP });
```

For an app that serves a frontend, write a policy that allows your scripts/styles/connect sources.

## Disabling a header

Set any option to `false` to omit that header (e.g. `frameOptions: false` if you embed the app in an iframe, `hsts: false` to never send HSTS).

## Related

- [Middleware](../tooling/middleware.md) · [Account security](./account-security.md) · [CORS](../core/resources-and-app.md#createcovara)
