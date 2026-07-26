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

- `dist/public` for Cloudflare Workers Static Assets
- `dist/server` for the connected hosted preview

## Cloudflare deployment

The repository includes `wrangler.jsonc`. In Cloudflare Workers Builds, use:

- Production branch: `main`
- Build command: optional (`npm install` already runs the build)
- Deploy command: `npx wrangler deploy`

The current public pilot is available at:
https://boomer-buddy-guidebook.ok-dope.chatgpt.site
