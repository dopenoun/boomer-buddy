# Boomer Buddy Guidebook

An accessible, plain-language guidebook for everyday gadgets and technology.
This first pilot contains one Pulsetto Fit guide for family usability testing.

## Stack

- Plain HTML, CSS, and JavaScript
- A small Node build script
- Cloudflare Workers Static Assets

No Astro, Svelte, or application framework is required for this pilot.

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

## Test

```bash
npm test
```

Builds the worker, then smoke-tests it with Node's built-in test runner:
home page, known paths, 404s, security headers and the social image.
CI runs the same command on every pull request.

## Cloudflare deployment

The repository includes `wrangler.jsonc`. In Cloudflare Workers Builds, use:

- Production branch: `main`
- Build command: optional (`npm install` already runs the build)
- Deploy command: `npx wrangler deploy`

The current public pilot is available at:
https://boomer-buddy-guidebook.ok-dope.chatgpt.site
