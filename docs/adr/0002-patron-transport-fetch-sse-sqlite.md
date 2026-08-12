# ADR 0002: Patron Transport v1 uses Fetch/SSE contracts and a SQLite reference adapter

- Status: accepted
- Date: 2026-08-11
- Scope: Patron Transport v1 only

## Context

Runtime Boundary v0 is a dependency-light TypeScript library beside a plain static guidebook. The checked-in Cloudflare configuration serves only `public/`; it does not define a Worker entry point, Durable Object, D1 database, identity provider, or server framework. Runtime v0 deliberately had process-local storage and accepted caller-provided patron scope.

Patron Transport v1 must add authenticated HTTP/SSE ingress, durable patron-partitioned state, reconnect/resume, and restart-safe replay without adding executable capabilities or coupling domain policy to a transport framework, storage vendor, identity provider, or model provider.

## Decision

1. `PatronTransportHttpAdapter` accepts standard Fetch `Request` objects and returns standard Fetch `Response` objects containing validated AG-UI events as SSE. It is a library adapter, not a listener, framework application, or deployment.
2. `PatronIdentityVerifier` is an explicit provider-neutral interface. The included `DeterministicTestIdentityAdapter` verifies HMAC-authenticated test tokens and is named and documented as test-only. No production authentication claim is made.
3. Approval/resume authorizations are HMAC-SHA-256 authenticated bearer messages. Each message binds version, purpose, issuer, audience, tenant, patron, identity session, thread, original run, action, interrupt, capability, decision, nonce, not-before time, and expiration.
4. The adapter derives tenant and patron scope only from the verified identity. Route and body thread IDs must agree; client-supplied tools, contexts, arbitrary state, forwarded properties, binary content, and extra fields are rejected.
5. `RuntimeStore` and `TransportStateStore` are vendor-neutral contracts. Runtime decision semantics remain in shared domain code. `SqliteRuntimeStore` is the durable Node reference adapter because Node 22.22.3 is present, `node:sqlite` requires no new package, SQLite transactions provide deterministic local restart and locking tests, and the existing Cloudflare static deployment has no configured server-side storage binding.
6. Every SQLite table containing patron state includes tenant and patron partition columns. Pending decision plus reminder creation is one `BEGIN IMMEDIATE` transaction. Nonce consumption and request replay records are durable.
7. POST requests require an `Idempotency-Key` equal to the AG-UI input `runId`. Completed transport responses are stored without approval bearer tokens; replay and reconnect issue fresh decision-bound tokens.
8. The existing executable registry remains exactly `search_help_catalog` and `create_reminder`. The authority lint now discovers both `runtime/` and `transport/`, permits only the declared protocol/schema/crypto/SQLite modules, and continues to reject shell, generic filesystem, arbitrary outbound network, dynamic module load, and MCP-like escape primitives.

## Alternatives not selected

- Express, Hono, Fastify, or another server framework: unnecessary for a two-route reference adapter and unrelated to the existing repository.
- Cloudflare D1, Durable Objects, KV, or a Worker entry point: no such deployment boundary is configured, and selecting one would couple v1 to a vendor and imply a production deployment the user did not authorize.
- An application-visible filesystem store: weaker concurrent decision semantics and too close to a general filesystem primitive. SQLite is internal persistence and is never exposed as a capability.
- Caller-asserted patron headers: they would preserve the exact forged-authority defect v1 is meant to close.
- Unsigned approval payloads or possession of an interrupt ID: insufficient binding against altered decisions, cross-scope substitution, expiry, and replay.

## Consequences

The reference adapter can be integrated behind a future HTTP server or Worker-specific shim without changing domain policy. Tests prove durable local restart and crash reclaim, single-host transaction behavior, strict scope and stored-row binding, canonical cryptographic message binding, strict HTTP parsing, bounded buffered SSE validation, and fail-closed lock/schema behavior. The static guidebook and `wrangler.jsonc` remain unchanged.

This is not production authentication or production hosting. A real identity adapter, secret management and rotation, multi-instance storage selection, TLS/proxy/rate-limit policy, retention, observability review, and deployment-specific verification remain explicit prerequisites.
