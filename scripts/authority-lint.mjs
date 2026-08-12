import { readdir, readFile } from "node:fs/promises";

const sourceDirectories = [
  new URL("../runtime/", import.meta.url),
  new URL("../transport/", import.meta.url)
];
const allowedExternalModules = new Set(["@ag-ui/core", "node:crypto", "node:sqlite", "zod"]);
const moduleReference = /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;
const sideEffectImport = /^\s*import\s*["']([^"']+)["']/gm;
const nonLiteralModuleLoad = /\b(?:import|require)\s*\(\s*[^"'\s]/;
const forbiddenExecution = /(?:\b(?:eval|Function|WebSocket|EventSource|XMLHttpRequest)\s*\(|\b(?:fetch|sendBeacon)\s*\(|\bglobalThis\s*\.\s*fetch\b|\bprocess\s*\.\s*(?:binding|dlopen|getBuiltinModule|mainModule)\b|\b(?:Bun|Deno)\s*\.)/;

for (const directory of sourceDirectories) {
  const sourceFiles = (await readdir(directory, { recursive: true }))
    .filter((file) => file.endsWith(".ts"))
    .sort();
  for (const file of sourceFiles) {
    const source = await readFile(new URL(file, directory), "utf8");
    const specifiers = [
      ...[...source.matchAll(moduleReference)].map((match) => match[1]),
      ...[...source.matchAll(sideEffectImport)].map((match) => match[1])
    ];
    const unexpectedModule = specifiers.find((specifier) =>
      specifier !== undefined && !specifier.startsWith(".") && !allowedExternalModules.has(specifier)
    );
    if (unexpectedModule || nonLiteralModuleLoad.test(source) || forbiddenExecution.test(source)) {
      throw new Error(`Authority lint failed: forbidden general-purpose primitive in ${new URL(file, directory).pathname}`);
    }
  }
}

console.log("Authority lint passed: no shell, generic filesystem, arbitrary outbound network, or generic MCP primitive is reachable from runtime or transport code.");
