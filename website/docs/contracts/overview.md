# Covara Contracts

This folder contains the formal contracts (guarantees and non-guarantees) for the Covara framework. These contracts are:

1. **Testable** - Each guarantee has corresponding tests that enforce it
2. **Versioned** - Breaking changes to contracts require major version bumps
3. **Explicit** - We document what we DON'T promise as clearly as what we DO

## Documents

- [subscriptions.md](./subscriptions.md) - Subscription ordering, resume, and delivery guarantees
- [tasks.md](./tasks.md) - Task execution semantics, retry, and delivery guarantees
- [pagination.md](./pagination.md) - Cursor integrity and consistency guarantees
- [auth.md](./auth.md) - Authentication and authorization threat model
- [billing.md](./billing.md) - Billing and metering guarantees
- [email.md](./email.md) - Email delivery and formatting guarantees
- [etag.md](./etag.md) - ETag emission, conditional requests, and optimistic locking guarantees
- [offline-sync.md](./offline-sync.md) - Offline mutation and sync guarantees
- [environment-variables.md](./environment-variables.md) - Environment variable parsing and public exposure guarantees
- [search.md](./search.md) - Search endpoint and auto-indexing guarantees
- [storage.md](./storage.md) - File upload and storage adapter guarantees
- [track-mutations.md](./track-mutations.md) - Mutation tracking and changelog recording guarantees
- [abuse-protection.md](./abuse-protection.md) - Token-bucket budget and proof-of-work guarantees

## How to Read These Contracts

Each contract document has the following structure:

### Guarantees (What We Promise)
Behaviors you can rely on. We test these. Breaking them is a bug.

### Non-Guarantees (What We Explicitly Do Not Promise)
Behaviors that might work today but could change. Don't depend on these.

### Failure Modes
What happens when things go wrong. We aim for fail-safe behavior.

### Test Coverage
Links to tests that verify these contracts.
