import { readFileSync } from "node:fs";
const metadata = JSON.parse(readFileSync(new URL("../docs/feature/app-store/metadata.json", import.meta.url)));
const config = JSON.parse(readFileSync(new URL("../src-tauri/tauri.appstore.conf.json", import.meta.url)));
if (process.argv.slice(2).some(arg => arg !== "--strict")) throw new Error("Use --strict to fail on unresolved submission fields");
const errors = [];
const pending = [];
if (metadata.bundleId !== config.identifier) errors.push("Bundle ID mismatch");
for (const locale of ["zh-Hans", "en-US"]) {
  for (const [field, limit] of Object.entries({ name: 30, subtitle: 30, keywords: 100, promotionalText: 170, description: 4000 })) {
    const value = metadata.localizations?.[locale]?.[field];
    if (typeof value !== "string" || !value.trim() || (field === "keywords" ? Buffer.byteLength(value, "utf8") : Array.from(value).length) > limit) errors.push(`${locale}.${field}: missing or exceeds ${limit} ${field === "keywords" ? "UTF-8 bytes" : "characters"}`);
  }
}
for (const key of ["supportUrl", "privacyPolicyUrl", "operator", "copyright", "price", "regions", "ageRating", "reviewContactName", "reviewContactPhone"]) {
  if (metadata[key] == null || metadata[key] === "") pending.push(key);
}
for (const key of ["supportUrl", "privacyPolicyUrl"]) if (metadata[key] != null) {
  try { if (new URL(metadata[key]).protocol !== "https:") errors.push(`${key} must use HTTPS`); }
  catch { errors.push(`${key} is invalid`); }
}
if (!metadata.reviewServiceReady) pending.push("reviewServiceReady");
pending.push("P1–P3 native acceptance", "policy publication and privacy declarations", "rights review", "formal signing/upload", "actual screenshots", "App Store Connect owner confirmation");
console.log(JSON.stringify({ draftValid: !errors.length, submissionReady: false, errors, pending }, null, 2));
process.exitCode = errors.length || (process.argv.includes("--strict") && pending.length) ? 1 : 0;
