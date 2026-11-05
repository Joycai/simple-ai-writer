import { createHash } from "node:crypto";
export const REVIEW_FILES = ["bundle.json", "metadata.json", "source.json", "test-plan.json"];
export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

/** Consistency/integrity check, never a signature or human acceptance decision. */
export function verifyReview(manifest, files) {
  const errors = [];
  if (manifest?.schemaVersion !== 1 || manifest?.kind !== "appstore-local-review") errors.push("Unsupported archive schema");
  if (manifest?.submissionReady !== false) errors.push("Local archive cannot authorize submission");
  const names = Object.keys(manifest?.files ?? {}).sort();
  if (JSON.stringify(names) !== JSON.stringify([...REVIEW_FILES].sort())) errors.push("Unexpected or missing archive files");
  for (const name of REVIEW_FILES) {
    if (!files[name] || sha256(files[name]) !== manifest?.files?.[name]) errors.push(`Missing or changed evidence: ${name}`);
  }
  if (errors.length) return { integrityPassed: false, submissionReady: false, errors, pending: [] };
  try {
    const bundle = JSON.parse(files["bundle.json"]);
    const metadata = JSON.parse(files["metadata.json"]);
    const plan = JSON.parse(files["test-plan.json"]);
    const source = JSON.parse(files["source.json"]);
    const identity = bundle.checks?.find(c => c.name === "bundle-identity")?.detail;
    const binary = bundle.checks?.find(c => c.name === "architecture-and-deployment-target")?.detail;
    if (!bundle.localStaticChecksPassed || bundle.checks?.length !== 6 || !bundle.checks.every(c => c.passed === true)) errors.push("Bundle audit not passed");
    if (!metadata.draftValid || !Array.isArray(metadata.pending) || !metadata.pending.length) errors.push("Invalid preparation metadata");
    const candidate = { bundleId: identity?.id, version: identity?.version, buildNumber: identity?.buildNumber, binarySha256: binary?.sha256 };
    if (!candidate.version || !/^[1-9]\d{0,3}$/.test(candidate.buildNumber) || !/^[a-f0-9]{64}$/.test(candidate.binarySha256) || candidate.bundleId !== "com.simple-ai-writer.app.appstore") errors.push("Invalid candidate identity");
    for (const [key, value] of Object.entries(candidate)) if (manifest.candidate?.[key] !== value) errors.push(`Candidate mismatch: ${key}`);
    if (!/^[a-f0-9]{40,64}$/.test(source.commit ?? "") || typeof source.dirty !== "boolean") errors.push("Invalid source observation");
    if (plan.schemaVersion !== 1 || !Array.isArray(plan.cases) || !plan.cases.length) errors.push("Missing acceptance plan");
    else if (new Set(plan.cases.map(c => c.id)).size !== plan.cases.length || plan.cases.some(c => !c.id || !c.title || !c.phase || c.status !== "pending")) errors.push("Local preparation must preserve pending acceptance cases");
    return { integrityPassed: !errors.length, submissionReady: false, candidate, errors,
      pending: [...(metadata.pending ?? []), ...(plan.cases ?? []).map(c => `${c.id}: ${c.title}`)] };
  } catch (error) {
    return { integrityPassed: false, submissionReady: false, errors: [String(error.message)], pending: [] };
  }
}
