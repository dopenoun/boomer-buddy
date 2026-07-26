import { mkdir, readFile, rm, writeFile } from "node:fs/promises";

const sourceHtml = await readFile(new URL("./index.html", import.meta.url), "utf8");
const redirectHtml = await readFile(new URL("./gadget-catalog.html", import.meta.url), "utf8");
let socialImageBase64 = "";
let socialImage;

try {
  socialImage = await readFile(new URL("./public/og.png", import.meta.url));
  socialImageBase64 = socialImage.toString("base64");
} catch {
  // The site remains deployable if a sharing image has not been generated yet.
}

const workerSource = `
const html = ${JSON.stringify(sourceHtml)};
const socialImageBase64 = ${JSON.stringify(socialImageBase64)};

function decodeBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/og.png" && socialImageBase64) {
      return new Response(decodeBase64(socialImageBase64), {
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=86400"
        }
      });
    }

    if (url.pathname !== "/" && url.pathname !== "/index.html" && url.pathname !== "/gadget-catalog.html") {
      return new Response("Guide not found", {
        status: 404,
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      });
    }

    const page = html.replaceAll("{{ORIGIN}}", url.origin);
    return new Response(page, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=300",
        "Referrer-Policy": "strict-origin-when-cross-origin",
        "X-Content-Type-Options": "nosniff"
      }
    });
  }
};
`;

await rm(new URL("./dist", import.meta.url), { recursive: true, force: true });
await mkdir(new URL("./dist/server", import.meta.url), { recursive: true });
await mkdir(new URL("./dist/public", import.meta.url), { recursive: true });
await writeFile(new URL("./dist/server/index.js", import.meta.url), workerSource);
await writeFile(
  new URL("./dist/public/index.html", import.meta.url),
  sourceHtml.replaceAll("{{ORIGIN}}", "https://boomer-buddy.alokahzebra02311.workers.dev")
);
await writeFile(new URL("./dist/public/gadget-catalog.html", import.meta.url), redirectHtml);
if (socialImage) {
  await writeFile(new URL("./dist/public/og.png", import.meta.url), socialImage);
}

console.log("Built Sites worker and Cloudflare static assets");
