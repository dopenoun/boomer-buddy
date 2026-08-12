# Boomer Buddy Patron Transport v1 threat model

Date: 2026-08-11

## Security statement

Patron Transport v1 closes the hosted-adapter gaps that Runtime Boundary v0 intentionally left open for authenticated ingress, signed approval messages, durable local persistence, restart recovery, nonce replay, and request idempotency. It does not widen the executable capability registry and it does not claim production identity, production hosting, or provider-process isolation.

The reference boundary is: hostile HTTP input -> time-bounded identity verification over a bodyless request view -> strict verified-identity and AG-UI/local envelope validation -> patron scope derived server-side -> signed approval verification and durable nonce check -> unchanged runtime policy -> atomic durable decision/reminder state -> validated, bounded AG-UI SSE output.

## Assets and authority invariants

- A patron may read, reconnect to, decide, or replay only records in the exact verified tenant/patron partition and exact thread.
- `create_reminder` remains the only mutating capability and still requires semantic confirmation. `search_help_catalog` remains the only read-only capability.
- A decision is authorized only by an unexpired, currently valid, cryptographically authenticated message bound to its purpose, audience, tenant, patron, identity session, thread, original run, action, interrupt, capability, decision, and nonce.
- A nonce is single-use across storage restart. A reclaimed request may reuse that nonce only when patron, idempotency key, request digest, request kind, purpose, token digest, and expiration all match the previously verified request exactly.
- A pending decision and reminder creation commit atomically. Concurrent approve/reject attempts cannot both finalize the action.
- The model provider cannot register tools, select an unregistered tool, modify arguments after approval, choose identity scope, mint authorization, consume nonce state, write persistence directly through its proposal, or emit unvalidated AG-UI/UI output.
- Receipts and audit records contain projected identifiers, outcomes, safe codes, and hashes—not raw messages, authorization headers, identity tokens, approval tokens, reminder arguments, or secrets.

## Hostile inputs

All authorization and accept headers, content types and lengths, URL paths, query strings, route identifiers, AG-UI bodies, forwarded properties, messages, resume decisions, provider proposals, stored JSON records, and events read for replay are treated as hostile. Controls are exact route regexes with no query/fragment/userinfo; request byte and declared-length checks; official AG-UI parsing followed by stricter local schemas; closed content and field sets; ASCII non-placeholder identity identifiers; server-derived patron scope; canonical JSON/base64url HMAC verification with constant-time equal-length signature comparison; exact claim binding; durable nonce uniqueness; patron-partitioned queries; stored-record-to-column rebinding; schema version/shape/foreign-key checks; and final AG-UI validation before bounded SSE serialization.

## Routes and reconnect semantics

- `POST /v1/threads/:threadId/runs` starts or resumes one strict AG-UI run input. `Idempotency-Key` must equal the body `runId`.
- `GET /v1/threads/:threadId/interrupts/:interruptId/events` reconstructs a still-pending interrupt for the verified patron and issues fresh short-lived, decision-specific authorization messages.
- SSE uses `event: ag-ui`, JSON `data`, `text/event-stream`, `no-store`, and disabled proxy transformation/buffering hints. Start/resume IDs are response-local. Reconnect snapshot IDs are bound to the stored original run and strict `Last-Event-ID` cursors may continue only that three-event snapshot.
- A disconnected request is checked at runtime checkpoints before proposal and immediately before mutation. If a connection disappears after a mutation, durable idempotency prevents a second mutation; the reconnect route restores a pending prompt and completed request replay restores an already-computed response.

## Durable data model

SQLite is a reference adapter behind `RuntimeStore` and `TransportStateStore`. Tables persist thread ownership, pending interrupts, reminders, receipts, authorization nonces, and transport request/replay state. Every patron data table contains tenant and patron columns; thread ownership and foreign keys prevent a thread/action from being rebound. Stored JSON is size-bounded, parsed through strict schemas, and compared with its partition/key columns before use. Startup rejects unknown `user_version`, partial or corrupt files, incompatible table shape, and foreign-key violations. Approval bearer tokens are never written to receipts, audit records, or transport replay records.

## Threats and deterministic evidence

| Threat | Control | Evidence |
| --- | --- | --- |
| Forged identity | Provider-neutral verifier; strict output/audience validation; timeout/cancellation; bodyless request view; authenticated test token | `TR-AUTH-001` through `004` |
| Missing, altered, ambiguous, or confused approval signature | Canonical HMAC-SHA-256 encoding, strict header/claims, equal-length constant-time compare | `TR-SIGN-001`, `002` |
| Wrong patron/action/run/thread/audience/decision | Exact signed-claim and stored-action binding | `TR-BIND-001` |
| Expired or not-yet-valid authorization | Integer time claims checked without implicit skew and bounded by action expiry | `TR-TIME-001`, `002` |
| Nonce replay and crash reclaim | Durable tenant/patron/nonce uniqueness; exact prior request tuple required for idempotent reclaim | `TR-NONCE-001`, `TR-CRASH-001`, `002` |
| Duplicate resume after restart | Durable request digest/idempotency response, crash-point recovery, and atomic reminder action key | `TR-RESTART-001`, `TR-CRASH-001`, `002` |
| Cross-patron identifier substitution | Verified scope, thread owner, partitioned lookup, exact action owner | `TR-SCOPE-001`, `SEC-SCOPE-001` through `003` |
| Disconnect/reconnect at interrupt | Durable pending action; authenticated reconnect route; fresh authorizations | `TR-RECONNECT-001`, `SEC-RECONNECT-001` |
| Concurrent approval/rejection | SQLite immediate transaction and single pending-to-final transition | `TR-RACE-001` |
| Storage restart/recovery | On-disk pending actions, receipts, reminders, nonces, replay state | `TR-RECOVERY-001`, `TR-RESTART-001` |
| Malformed SSE lifecycle or stored event | strict HTTP/AG-UI schemas, run-bound cursors, observational reconnect, terminal behavior, and event revalidation | `TR-SSE-001` through `004`, `SEC-AGUI-001`, `002` |
| Malformed or oversized HTTP input | 64 KiB request, exact length, strict JSON, method/content/header/query rules, event-count and byte limits | `TR-SIZE-001`, `TR-HTTP-001`, `002`, `TR-SSE-004` |
| Corrupt, mismatched, or locked SQLite | Version/shape/FK gates, row-column rebinding, rollback, busy fail-closed behavior | `TR-STORE-001` through `004` |
| Provider attempts transport-policy bypass | identity/authorization outside provider; unchanged exact capability registry | `TR-POLICY-001`, `SEC-CAP-001` through `003` |
| Receipt or audit secret leakage | explicit projection and digest-only transport audit | `TR-LEAK-001`, `SEC-RECEIPT-001` |

## Exact residual risks

1. **PT-001 — No production identity provider is configured.** `DeterministicTestIdentityAdapter` uses a shared HMAC test key and only demonstrates the interface and failure behavior. Account lifecycle, MFA, revocation, recovery, federation, and real patron proof are absent.
2. **PT-002 — Key management is not implemented.** Approval and test-identity HMAC keys are constructor inputs. There is no KMS/HSM integration, rotation, key ID, revocation list, or compromised-key response. Anyone holding an approval key can forge approvals.
3. **PT-003 — Approval messages are bearer credentials.** A compromised authorized client/session can use an unexpired message for its one bound decision. Session binding and short expiry reduce but do not eliminate client compromise risk.
4. **PT-004 — SQLite is a single-host reference boundary.** It is durable across tested process/store restart and serializes local writers, but it is not a selected multi-region, replicated, backed-up, or managed production store. `node:sqlite` is experimental in the installed Node 22.22.3 runtime.
5. **PT-005 — Nonce, action, receipts, and HTTP replay still commit in separate transactions.** Exact retry after the 30-second lease now recovers both tested crash points without duplicate mutation, including rebuilding missing receipts after action commit. A retry delayed beyond the signed approval/action lifetime can remain fail-closed, and a crash between two append-only receipt writes can leave a partial receipt pair; neither condition creates a second reminder.
6. **PT-006 — The HTTP adapter is not an internet server.** TLS termination, CSRF/origin policy for a future browser integration, rate limits, denial-of-service controls outside local byte/time bounds, reverse-proxy behavior, and production routing are not configured or tested. The adapter emits no cross-origin grant and does emit no-store/nosniff/no-referrer headers.
7. **PT-007 — SSE output is buffered after each deterministic runtime call.** This version does not provide incremental provider streaming. It marks responses `x-boomer-buddy-stream-mode: buffered`; slow or cancelled downstream consumption cannot trigger execution, and a downstream disconnect after a committed mutation cannot roll the mutation back.
8. **PT-008 — The injected model provider remains trusted executable in-process code.** Its returned proposal cannot bypass runtime or transport policy, but the provider implementation itself can perform side effects before returning. Process/network isolation is not added.
9. **PT-009 — Patron data is not encrypted by this adapter at rest.** SQLite contains reminder details, pending prompts, receipts, and token-free event replays. Host filesystem access controls, encryption, backup, deletion, and retention policy are deployment responsibilities.
10. **PT-010 — Expired nonce and request replay retention is not compacted.** Records remain until a future explicit retention policy and maintenance mechanism are selected.
11. **PT-011 — No production logging or telemetry pipeline exists.** The audit interface and recording test prove the adapter passes only projected fields, but proxies, hosts, exception reporters, and identity-provider logs are unassessed.
12. **PT-012 — The existing static Cloudflare deployment cannot run this adapter.** No Worker entry point, D1/Durable Object binding, secret, production identity, or deployment was added. A future hosting decision requires a separate review.
13. **PT-013 — SQLite journal mode is not forced to WAL.** The reference store relies on SQLite's configured/default journal mode plus `BEGIN IMMEDIATE` and a bounded busy timeout. Lock contention fails closed and was tested, but throughput and filesystem-specific durability require deployment testing.
