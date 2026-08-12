# Runtime Boundary v0 implementation receipt

- Date: 2026-08-11
- Repository baseline: `main` at `29dffad`
- Publication: none; no commit, push, Sites deployment, or Cloudflare deployment was performed

## Repository fit

The existing product is a plain HTML/CSS/JavaScript guidebook with a small Node build and Cloudflare/Sites static assets. It had no runtime, tests, type checker, linter, database, or application framework. This slice adds a standalone TypeScript reference runtime and deterministic tests. It does not change `index.html`, `gadget-catalog.html`, `public/`, `build.mjs`, `.openai/hosting.json`, or `wrangler.jsonc`.

## Files added or changed

- `package.json`, `package-lock.json`, `tsconfig.json`, `eslint.config.js`
- `runtime/ag-ui.ts`, `capabilities.ts`, `components.ts`, `errors.ts`, `index.ts`, `provider.ts`, `runtime.ts`, `store.ts`, `types.ts`, `vault.ts`
- `test/runtime.test.ts`
- `scripts/demo-runtime.ts`, `scripts/authority-lint.mjs`
- `README.md`
- `docs/adr/0001-narrow-runtime-not-hermes.md`
- `docs/runtime-boundary-threat-model.md`
- `docs/runtime-boundary-v0-receipt.md`

## Verification commands

- `npm test`
- `npm run typecheck`
- `npm run lint`
- `npm run demo:runtime`
- `npm run build`
- `npm run verify`
- `npm audit --omit=dev`
- `npm audit`
- `npm ls --depth=0`
- `git diff --check`
- `git diff --stat`
- `git status --short`

## Verified outcomes

- Thirty-nine deterministic tests cover both golden journeys; strict approve, reject, cancel, timeout, official AG-UI resume, duplicate/concurrent resume, and idempotency; cross-patron/tenant/thread denial and identifier collisions; unregistered tools; argument and provider-provenance violations; UI injection, unknown/prototype keys, unsafe orphan prevention, malformed and oversized props; the closed AG-UI event/state subset; disconnect/reconnect; stale, replayed, and cross-scope vault authorization; receipt/error leakage; frozen policy registries; unreachable general-purpose authority; and four explicit product-boundary limitations.
- The demo shows a `GuideCard`, an interrupt with `ReminderConfirmationCard`, and an approved `ActionReceiptCard` with one reminder.
- Type checking, lint, authority lint, the existing static build, and the combined verification command pass.

## Limitations

The runtime is a reference library with process-local test adapters, not a hosted endpoint. It deliberately omits Expo, SSE/HTTP transport, production identity, durable persistence/locking, a real reminder scheduler, native biometric attestation, model credentials, and production logging. No existing deployment was changed.

The adversarial review and machine-verifiable receipt are in `docs/security-review-runtime-boundary-v0.md` and `docs/runtime-boundary-v0-security-receipt.json`. They explicitly record that forged exact-scope approval, in-process provider side effects, unsigned native-grant authenticity, and cross-process replay prevention are not provided by v0.

`npm audit --omit=dev` reports zero production vulnerabilities. The full `npm audit` reports three findings in the existing Wrangler/Miniflare/Undici development chain (two moderate, one high). No automatic audit fix was applied because dependency remediation is outside this authority-boundary slice and can alter the existing deployment toolchain.

## Exact next step

Add a patron-authenticated HTTP/SSE adapter that accepts official `RunAgentInput`, maps its trusted server-side patron context into `BoomerBuddyRuntime`, persists pending actions/receipts/reminder idempotency in a durable patron-partitioned store, and streams the already-validated AG-UI events—without adding any new executable capability.
