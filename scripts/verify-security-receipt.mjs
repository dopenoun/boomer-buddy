import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import assert from "node:assert/strict";

const repositoryRoot = new URL("../", import.meta.url);
const receiptUrl = new URL("../docs/patron-transport-v1-security-receipt.json", import.meta.url);
const receiptBytes = await readFile(receiptUrl);
const receipt = JSON.parse(receiptBytes.toString("utf8"));

const requiredClaimIds = [
  "approval_authorization_signature",
  "approval_binding",
  "arbitrary_executable_generative_ui",
  "arbitrary_network_or_mcp_invocation",
  "bypassed_semantic_approval",
  "concurrent_decision_finalization",
  "cross_patron_reads_and_writes",
  "duplicate_execution_after_reconnect",
  "forged_approval_or_resume_events",
  "forged_patron_identity",
  "malformed_or_oversized_transport_input",
  "nonce_replay",
  "provider_implementation_policy_bypass",
  "restart_recovery",
  "sensitive_receipt_or_log_leakage",
  "shell_or_filesystem_capability_escalation",
  "stale_capability_token_replay",
  "unregistered_tool_execution"
].sort();
const allowedStatuses = new Set(["prevented", "conditional", "not_prevented"]);

assert.equal(receipt.schemaVersion, "boomer-buddy.security-receipt.v1");
assert.equal(receipt.review.runtimeBoundaryVersion, "0+patron-transport-v1");
assert.equal(receipt.review.testCount, 71);
assert.deepEqual(receipt.claims.map((claim) => claim.id).sort(), requiredClaimIds);
assert.ok(receipt.claims.every((claim) => allowedStatuses.has(claim.status)));

const testSources = await Promise.all([
  readFile(new URL("../test/runtime.test.ts", import.meta.url), "utf8"),
  readFile(new URL("../test/transport.test.ts", import.meta.url), "utf8")
]);
const testSource = testSources.join("\n");
for (const claim of receipt.claims) {
  assert.ok(Array.isArray(claim.evidenceTests) && claim.evidenceTests.length > 0, `${claim.id} has no test evidence`);
  for (const testId of claim.evidenceTests) {
    assert.ok(testSource.includes(`[${testId}]`), `${claim.id} references missing test ${testId}`);
  }
}

const runtimeFiles = (await readdir(new URL("../runtime/", import.meta.url), { recursive: true }))
  .filter((file) => file.endsWith(".ts"))
  .map((file) => `runtime/${file}`)
  .sort();
const transportFiles = (await readdir(new URL("../transport/", import.meta.url), { recursive: true }))
  .filter((file) => file.endsWith(".ts"))
  .map((file) => `transport/${file}`)
  .sort();
const hashedBoundaryFiles = Object.keys(receipt.evidence.fileSha256)
  .filter((file) => file.startsWith("runtime/") || file.startsWith("transport/"))
  .sort();
assert.deepEqual(hashedBoundaryFiles, [...runtimeFiles, ...transportFiles].sort(), "receipt must hash every runtime and transport TypeScript source");

for (const [file, expectedDigest] of Object.entries(receipt.evidence.fileSha256)) {
  const bytes = await readFile(new URL(file, repositoryRoot));
  const actualDigest = createHash("sha256").update(bytes).digest("hex");
  assert.equal(actualDigest, expectedDigest, `digest mismatch for ${file}`);
}

const receiptDigest = createHash("sha256").update(receiptBytes).digest("hex");
console.log(JSON.stringify({
  valid: true,
  schemaVersion: receipt.schemaVersion,
  claimCount: receipt.claims.length,
  testCount: receipt.review.testCount,
  receiptSha256: receiptDigest
}, null, 2));
