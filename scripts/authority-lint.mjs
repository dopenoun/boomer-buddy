import { readdir, readFile } from "node:fs/promises";

const runtimeDirectory = new URL("../runtime/", import.meta.url);
const runtimeFiles = (await readdir(runtimeDirectory, { recursive: true }))
  .filter((file) => file.endsWith(".ts"))
  .sort();
const allowedExternalModules = new Set(["@ag-ui/core", "node:crypto", "zod"]);
const moduleReference = /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;
const sideEffectImport = /^\s*import\s*["']([^"']+)["']/gm;
const nonLiteralModuleLoad = /\b(?:import|require)\s*\(\s*[^"'\s]/;
const forbiddenExecution = /(?:\b(?:eval|Function|exec|execFile|spawn|WebSocket|EventSource|XMLHttpRequest)\s*\(|\b(?:fetch|sendBeacon)\s*\(|\bglobalThis\s*\.\s*fetch\b|\bprocess\s*\.\s*(?:binding|dlopen|mainModule)\b|\b(?:Bun|Deno)\s*\.)/;

for (const file of runtimeFiles) {
  const source = await readFile(new URL(file, runtimeDirectory), "utf8");
  const specifiers = [
    ...[...source.matchAll(moduleReference)].map((match) => match[1]),
    ...[...source.matchAll(sideEffectImport)].map((match) => match[1])
  ];
  const unexpectedModule = specifiers.find((specifier) =>
    specifier !== undefined && !specifier.startsWith("./") && !allowedExternalModules.has(specifier)
  );
  if (unexpectedModule || nonLiteralModuleLoad.test(source) || forbiddenExecution.test(source)) {
    throw new Error(`Authority lint failed: forbidden general-purpose primitive in ${file}`);
  }
}

console.log("Authority lint passed: no shell, generic filesystem, arbitrary network, or generic MCP primitive is reachable from runtime code.");
