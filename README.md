# Boomer Buddy Guidebook

An accessible, plain-language guidebook for everyday gadgets and technology.
This first pilot contains one Pulsetto Fit guide for family usability testing.

## Stack

- Plain HTML, CSS, and JavaScript
- A small Node build script
- Cloudflare Workers Static Assets

No Astro, Svelte, or application framework is required for this pilot.

## Runtime Boundary v0

The repository now also contains a dependency-light TypeScript reference runtime under `runtime/`. It is deliberately separate from the static guidebook and from the generated `public/` assets, so the existing family usability pilot and Cloudflare deployment remain unchanged.

Runtime Boundary v0 uses the official `@ag-ui/core` event schemas at the wire boundary, while policy, patron scope, capability validation, approvals, receipts, component validation, and execution stay in Boomer Buddy's own domain modules. Only `search_help_catalog` and `create_reminder` are executable. The included adapters are deterministic and process-local; they demonstrate the contract but are not a production API or durable store.

```bash
npm test
npm run typecheck
npm run lint
npm run demo:runtime
npm run build
```

See [ADR 0001](docs/adr/0001-narrow-runtime-not-hermes.md), the [capability and threat model](docs/runtime-boundary-threat-model.md), the [implementation receipt](docs/runtime-boundary-v0-receipt.md), and the [adversarial security review](docs/security-review-runtime-boundary-v0.md).

## Local development

```bash
npm install
npm run dev
```

Open `http://localhost:4173`.

## Build

```bash
npm run build
```

The build creates:

- `public` for Cloudflare Workers Static Assets
- `dist/server` for the connected hosted preview

## Cloudflare deployment

The repository includes `wrangler.jsonc`. In Cloudflare Workers Builds, use:

- Production branch: `main`
- Build command: optional (`npm install` already runs the build)
- Deploy command: `npx wrangler deploy`

The current public pilot is available at:
https://boomer-buddy-guidebook.ok-dope.chatgpt.site
