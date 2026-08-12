# Patron Transport v1 implementation receipt

- Date: 2026-08-11
- Branch: `phase/boomer-buddy-patron-transport-v1`
- Baseline: `dab993f` (`feat: establish patron-safe Boomer Buddy runtime boundary`)
- Working artifact: uncommitted working tree
- Publication: none; no commit, push, pull request, Cloudflare change, or deployment performed

## Implemented scope

- Standard Fetch HTTP adapter with strict AG-UI-compatible POST input and validated SSE output.
- Explicit `PatronIdentityVerifier`; deterministic HMAC test identity adapter clearly marked test-only.
- HMAC-SHA-256 approval/resume messages bound to purpose, issuer, audience, tenant, patron, session, thread, original run, action, interrupt, capability, decision, nonce, not-before time, and expiration.
- Vendor-neutral runtime/transport storage contracts plus a durable, patron-partitioned SQLite reference adapter.
- Atomic pending-decision/reminder resolution; durable nonce, request digest, replay, receipts, reminders, interrupts, and thread ownership.
- Exact crash-reclaim identity for nonce reuse across the tested pre-action and post-action/pre-receipt windows.
- Strict identity-output/audience validation and timeout/cancellation over a bodyless verifier request view.
- Canonical JSON/base64url approval encoding, strict header/claim sets, and equal-length constant-time HMAC comparison.
- SQLite schema-version/shape/foreign-key checks and stored JSON-to-column rebinding.
- Authenticated interrupt reconnect, fresh authorization issuance, completed-request replay, and duplicate mutation prevention after restart.
- Authority lint coverage over `runtime/` and `transport/`.

The executable registry remains exactly two entries: `search_help_catalog` and `create_reminder`. No Expo, Hermes, MCP, shell, generic filesystem capability, arbitrary outbound networking, server framework, production identity integration, Worker entry point, deployment, or new model capability was added.

## Files added

- `transport/auth.ts`
- `transport/events.ts`
- `transport/http-sse.ts`
- `transport/sqlite-store.ts`
- `transport/types.ts`
- `transport/index.ts`
- `test/transport.test.ts`
- `docs/adr/0002-patron-transport-fetch-sse-sqlite.md`
- `docs/patron-transport-v1-threat-model.md`
- `docs/patron-transport-v1-receipt.md`
- `docs/patron-transport-v1-security-receipt.json`

## Files changed

- `runtime/errors.ts`
- `runtime/capabilities.ts`
- `runtime/runtime.ts`
- `runtime/store.ts`
- `runtime/types.ts`
- `scripts/authority-lint.mjs`
- `scripts/verify-security-receipt.mjs`
- `package.json`
- `tsconfig.json`
- `README.md`

`wrangler.jsonc`, static HTML, `public/`, `build.mjs`, executable capability manifests, provider interface, and component registry were not expanded for transport v1.

## Deterministic evidence

The combined suite has 71 tests: 39 existing Runtime Boundary v0 tests and 32 Patron Transport v1 integration/adversarial tests. The independent adversarial additions include:

- forged identity: `TR-AUTH-001`
- missing or altered signature: `TR-SIGN-001`
- wrong patron/action/run/thread/audience/decision: `TR-BIND-001`
- expired and not-yet-valid authorization: `TR-TIME-001`
- nonce replay: `TR-NONCE-001`
- duplicate resume across restart: `TR-RESTART-001`
- cross-patron identifier substitution: `TR-SCOPE-001`
- reconnect during interrupt and resume: `TR-RECONNECT-001`
- concurrent approval/rejection: `TR-RACE-001`
- storage restart/recovery: `TR-RECOVERY-001`
- malformed SSE requests/events: `TR-SSE-001`
- oversized payload: `TR-SIZE-001`
- provider transport-policy bypass attempt: `TR-POLICY-001`
- receipt/audit secret leakage: `TR-LEAK-001`
- identity output, audience, timeout, cancellation, duplicate headers, and body isolation: `TR-AUTH-002` through `004`
- canonical serialization, malformed/noncanonical encodings, strict fields, wrong keys/algorithms/key IDs, and all signed bindings: `TR-SIGN-002`
- exact clock boundaries and nonce uniqueness: `TR-TIME-002`
- crash after nonce and crash after action/before receipts/replay: `TR-CRASH-001`, `002`
- run-bound `Last-Event-ID`, terminal/non-consuming consumers, and buffered replay bounds: `TR-SSE-002` through `004`
- strict methods, URLs, identifiers, duplicate headers, lengths, JSON, content types, body reuse, cache/CORS/security headers: `TR-HTTP-001`, `002`
- corrupt row rebinding, schema/corrupt-file/path/FK checks, rollback/lock behavior, and separate-store races: `TR-STORE-001` through `004`
- malicious provider output/error/prototype/internal-access attempts and pending-provider cancellation: `TR-PROVIDER-001`, `TR-CANCEL-001`

## Verification commands

- `npm test`
- `npm run typecheck`
- `npm run lint`
- `npm run build`
- `npm run demo:runtime`
- `npm run security:verify`
- `npm run verify`
- `npm audit --omit=dev`
- `npm audit`
- `npm ls --depth=0`
- `git diff --check`
- `git diff --stat`
- `git status --short --branch`

## Final verification outcome

- `npm run verify`: passed; 71/71 tests, TypeScript, ESLint, authority lint, static build, and the 18-claim machine receipt all passed.
- `npm run security:verify`: passed with the same 71/71 tests and receipt verification.
- `npm run demo:runtime`: passed; read-only help, reminder interrupt, approved reminder, and six receipts remained intact.
- `npm audit --omit=dev`: zero vulnerabilities.
- full `npm audit`: three existing development-chain findings through `wrangler -> miniflare -> undici` (two moderate, one high). No automatic dependency change was made.
- `npm ls --depth=0`: declared dependencies resolved; it also reports the existing extraneous `@emnapi/runtime`, `@img/sharp-wasm32`, and `tslib` packages in local `node_modules`.
- `git diff --check`: passed.
- Branch/HEAD: `phase/boomer-buddy-patron-transport-v1` at `dab993f60adb7f540af747b73ea2e1a8ae33174c`.
- Working tree: 10 modified tracked files and 11 untracked implementation/documentation files; combined handoff delta is 3,248 insertions and 57 deletions across 21 files.
- Static assets and `wrangler.jsonc` are unchanged after the build.

## Residual risks

The exact thirteen residual risks are enumerated in `docs/patron-transport-v1-threat-model.md`. The gating items for any production claim are a real identity provider, managed signing keys and rotation, production server/TLS/proxy policy, a selected multi-instance durable store, crash-window/transaction strategy, at-rest protection and retention, provider isolation, journal/filesystem durability validation, and production observability review. The included test identity adapter and SQLite store are reference adapters only.
