// Smoke test for the built worker. Run `npm run build` first (npm test does it).
// Uses only Node's built-in test runner, so no new dependencies.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const worker = (await import(new URL("../dist/server/index.js", import.meta.url))).default;
const hit = (path) => worker.fetch(new Request(`https://example.test${path}`));

test("home page serves HTML with the origin filled in", async () => {
  const res = await hit("/");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
  const body = await res.text();
  assert.ok(!body.includes("{{ORIGIN}}"), "ORIGIN placeholder left in page");
});

test("known aliases serve the guide", async () => {
  for (const path of ["/index.html", "/gadget-catalog.html"]) {
    assert.equal((await hit(path)).status, 200, path);
  }
});

test("unknown paths return 404", async () => {
  assert.equal((await hit("/nope")).status, 404);
});

test("security headers are set", async () => {
  const res = await hit("/");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.ok(res.headers.get("referrer-policy"));
});

test("social image is served when present", async (t) => {
  try {
    await readFile(new URL("../public/og.png", import.meta.url));
  } catch {
    t.skip("no public/og.png");
    return;
  }
  const res = await hit("/og.png");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
});
