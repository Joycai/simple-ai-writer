import test from "node:test";
import assert from "node:assert/strict";
import { REVIEW_FILES, sha256, verifyReview } from "../lib/appstore-review.mjs";
function archive() {
  const candidate = { bundleId: "com.simple-ai-writer.app.appstore", version: "2.0.15", buildNumber: "3", binarySha256: "a".repeat(64) };
  const bundle = { localStaticChecksPassed: true, checks: [
    { name: "bundle-identity", passed: true, detail: { id: candidate.bundleId, version: candidate.version, buildNumber: "3" } },
    { name: "architecture-and-deployment-target", passed: true, detail: { sha256: candidate.binarySha256 } },
    ...["signature-integrity", "sandbox-entitlements", "linked-libraries", "bundle-resources"].map(name => ({ name, passed: true }))] };
  const values = { "bundle.json": bundle, "metadata.json": { draftValid: true, pending: ["policy publication"] },
    "source.json": { commit: "b".repeat(40), dirty: true }, "test-plan.json": { schemaVersion: 1, cases: [{ id: "N01", phase: "P1", title: "Restart", status: "pending" }] } };
  const files = Object.fromEntries(Object.entries(values).map(([k,v]) => [k, JSON.stringify(v)]));
  const manifest = { schemaVersion: 1, kind: "appstore-local-review", candidate, submissionReady: false, files: Object.fromEntries(REVIEW_FILES.map(n => [n, sha256(files[n])])) };
  return { manifest, files };
}
test("valid local evidence stays pending, not submission approval", () => {
  const { manifest, files } = archive();
  const result = verifyReview(manifest, files);
  assert.equal(result.integrityPassed, true);
  assert.equal(result.submissionReady, false);
  assert.equal(result.pending.length, 2);
});
test("missing, changed and substituted evidence is rejected", () => {
  for (const name of REVIEW_FILES) {
    const { manifest, files } = archive(); delete files[name];
    assert.equal(verifyReview(manifest, files).integrityPassed, false);
  }
  const { manifest, files } = archive(); files["bundle.json"] += " ";
  assert.equal(verifyReview(manifest, files).integrityPassed, false);
});
test("candidate mismatch and traversal entries cannot be accepted", () => {
  const { manifest, files } = archive(); manifest.candidate.buildNumber = "4";
  assert.equal(verifyReview(manifest, files).integrityPassed, false);
  manifest.files["../secret"] = "x";
  assert.equal(verifyReview(manifest, files).integrityPassed, false);
});
test("rehashed passed statuses and forged local approval are refused", () => {
  const { manifest, files } = archive();
  files["test-plan.json"] = files["test-plan.json"].replace('"pending"', '"passed"');
  manifest.files["test-plan.json"] = sha256(files["test-plan.json"]);
  assert.equal(verifyReview(manifest, files).integrityPassed, false);
  manifest.submissionReady = true;
  assert.equal(verifyReview(manifest, files).submissionReady, false);
});
test("failed audit cannot be hidden by refreshing the file hash", () => {
  const { manifest, files } = archive();
  const bundle = JSON.parse(files["bundle.json"]); bundle.checks[0].passed = false;
  files["bundle.json"] = JSON.stringify(bundle); manifest.files["bundle.json"] = sha256(files["bundle.json"]);
  assert.equal(verifyReview(manifest, files).integrityPassed, false);
});
