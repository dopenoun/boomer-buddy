# Adversarial security and product-boundary review: Runtime Boundary v0

Date: 2026-08-11

## Executive verdict

Runtime Boundary v0 is a narrow, fail-closed proposal dispatcher and process-local reference store. After the fixes in this review, a malicious model proposal cannot select an unregistered capability, change reminder arguments after approval, inject an executable component, replay a finalized action into a second mutation, or cross the store's exact tenant/patron/thread checks.

It is not an authentication boundary, provider sandbox, durable idempotency boundary, or production logging boundary. Under the review's strongest assumptions—a compromised client that can assert the victim's exact scope, or a malicious in-process provider implementation—the implementation does **not** prevent forged approval or provider side effects. Those are high-severity prerequisites for any hosted adapter and are deliberately not filled in with placeholder security.

## Severity-ranked residual findings

| Severity | ID | Finding | Evidence and disposition |
| --- | --- | --- | --- |
| High | SR-001 | No authenticated principal binds `tenantId`, `patronId`, or approval to a human/session. A caller with the exact scope and interrupt ID is treated as authorized. | `[LIMIT-AUTH-001]` proves the behavior. Required before hosting: an authenticated adapter must derive scope server-side and bind resume to the authenticated session. Not fixed because v0 deliberately has no transport or identity layer. |
| High | SR-002 | `ModelProvider` is injected in-process TypeScript. Its returned proposal is constrained, but its own implementation can perform side effects before returning. | `[LIMIT-PROVIDER-001]` proves the provider code executes outside proposal policy. Required for an untrusted provider implementation: process/network isolation or a data-only remote provider adapter. Not added because that would expand scope. |
| High (development dependency) | SR-006 | The full `npm audit` reports one high and two moderate Undici findings through the Wrangler/Miniflare development and deployment chain. | `npm audit --omit=dev` reports zero production vulnerabilities. No automatic audit fix was applied because changing the deployment toolchain is outside this runtime-boundary review. |
| Medium | SR-003 | Pending actions, reminders, receipts, replay sets, and idempotency records are process-local. Restart or multi-process execution has no durable locking or replay guarantee. | `[LIMIT-DURABILITY-001]` proves pending state loss. Same-process duplicate and concurrent reconnect tests pass. Durable patron-partitioned storage is required before production. |
| Medium | SR-004 | `VaultAuthorizationService.issue` validates shape, scope, and expiry but does not attest or cryptographically verify a native grant. | `[LIMIT-TOKEN-001]` proves a caller-chosen syntactically valid grant is accepted. A trusted native/auth adapter is an explicit precondition; vault capabilities are not executable in v0. |
| Low | SR-005 | Receipt projection and runtime errors are tested for leakage, but there is no production logger, trace exporter, HTTP proxy, or provider telemetry implementation to assess. | Receipt tests pass and runtime sources contain no logging calls. Production log leakage remains unverified because the pipeline does not exist. |

## Fixed findings

| Original severity | ID | Defect demonstrated during review | Fix and regression evidence |
| --- | --- | --- | --- |
| High | FX-001 | Any direct `resume()` decision other than `reject` or `cancel` fell through to approval, so `"yes"` executed a reminder. | Strict runtime schemas now reject unknown decisions before state lookup. `[SEC-APPROVAL-001]`. |
| High | FX-002 | A colliding `actionId` returned another patron's existing reminder from the global idempotency map. | Idempotency keys are tenant/patron/action tuples and conflicting same-scope actions fail closed. `[SEC-SCOPE-003]`. |
| High | FX-003 | Pending action state was saved before confirmation-component validation. An unsafe card could fail the run while leaving an unshown action resumable by a guessed interrupt ID. | The confirmation event is fully validated before pending state is stored. `[SEC-APPROVAL-004]`. |
| Medium | FX-004 | A provider-created `RuntimeBoundaryError` could place arbitrary provider text into `RUN_ERROR`; provider labels were unbounded receipt input. | Errors now use a canonical allowlist, provider labels are strict opaque identifiers, and receipt content remains projected/hashes-only. `[SEC-PROVIDER-002]`, `[SEC-PROVIDER-003]`, `[SEC-RECEIPT-001]`. |
| Medium | FX-005 | Provider proposal provenance was accepted without matching the trusted request message ID. | Strict proposal envelopes require exact trusted message provenance. `[SEC-PROVIDER-001]`. |
| Medium | FX-006 | AG-UI validation accepted event types outside the documented subset, prototype-sensitive/arbitrary state paths, arbitrary state values, and extra resume-envelope fields. | The accepted event set, tool names, state snapshot/delta schemas, event size, and local resume envelope are now closed. `[SEC-AGUI-001]`, `[SEC-AGUI-002]`. |
| Low | FX-007 | Authority lint listed runtime files manually and only matched a small set of direct imports/calls. A new runtime file or dynamic/general-purpose module load could escape the check. | The lint now discovers every runtime TypeScript source, permits only three external modules, and rejects dynamic module loads plus general-purpose execution/network globals. `npm run lint`. |
| Low | FX-008 | The component registry used prototype-inclusive membership and exported replaceable registry/manifest objects. | Own-property lookup and frozen policy registries/manifests are enforced. `[SEC-POLICY-005]` and the unknown-component regression. |

## Requested-property verdicts

| Property | Verdict for v0 | Boundary of proof |
| --- | --- | --- |
| Shell or filesystem capability escalation | Conditional prevention | No such primitive or import is reachable in discovered `runtime/**/*.ts`, and proposals cannot register one. An injected provider implementation is trusted executable code (SR-002). |
| Arbitrary network/MCP invocation | Conditional prevention | Runtime module imports are allowlisted and the executable registry has two entries. Provider-process network behavior is outside this boundary (SR-002). |
| Unregistered tool execution | Prevented within v0 | Exact frozen registry, strict proposal/tool arguments, hardcoded executors, and AG-UI tool-name validation. |
| Bypassed semantic approval | Conditional prevention | Every `create_reminder` action pauses, confirmation data derives from validated arguments, and malformed decisions fail closed. Human identity/intent is not authenticated (SR-001). |
| Duplicate execution after reconnect | Conditional prevention | Same-process sequential and concurrent replays create one reminder. Restart/multi-process durability is not provided (SR-003). |
| Cross-patron reads and writes | Conditional prevention | Exact tenant/patron/thread checks, patron-filtered lists, collision-safe idempotency, and cloned store values prevent accidental cross-scope access. A caller can still impersonate scope without an auth adapter (SR-001). |
| Arbitrary executable generative UI | Prevented in runtime output | Only four frozen component keys with strict props, executable-content rejection, payload limits, and a namespaced custom event are emitted. A compromised client can execute its own code and is outside the server-output guarantee. |
| Forged approval/resume events | Not prevented under the compromised-client assumption | Malformed, extra-field, expired, wrong-scope, unknown, and finalized resumes fail. A correctly shaped event with the victim's exact asserted scope succeeds (SR-001). |
| Stale capability-token replay | Conditional prevention | Grants and authorizations are expiring, scoped, single-use, and replay-tracked in one process. Grant authenticity and durable replay state are prerequisites (SR-003, SR-004). |
| Sensitive receipt/log leakage | Conditional prevention | Receipts store opaque IDs, safe codes, and SHA-256 content digests, not raw messages/arguments; provider errors are canonicalized. No production logging pipeline exists to verify (SR-005). |
| Provider implementation bypassing runtime policy | Proposal execution prevented; provider side effects not prevented | Provider-returned capability, arguments, provenance, UI, and errors are constrained. In-process provider code itself is not sandboxed (SR-002). |

## Verification

The deterministic suite contains 39 tests: 35 control/regression tests and four explicit boundary-characterization tests. Run:

```bash
npm run security:verify
```

The command runs tests, type checking, lint/authority lint, and verifies every receipt evidence ID and SHA-256 file digest. The machine-readable receipt is `docs/runtime-boundary-v0-security-receipt.json`.

Live dependency checks during this review: `npm audit --omit=dev` found zero vulnerabilities; full `npm audit` found three development-chain vulnerabilities (two moderate, one high).
