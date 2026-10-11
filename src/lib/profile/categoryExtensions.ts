import { CATEGORY_ID_RE, parseFacetSlots, type FacetSlot } from "./model";

/** Additions only: an extension never declares or renames a category. */
export type CategoryExtensions = Record<string, { slots: FacetSlot[] }>;

export function parseCategoryExtensions(raw: unknown, issues: string[]): CategoryExtensions {
  const result: CategoryExtensions = {};
  if (raw === undefined) return result;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    issues.push("categoryExtensions must be an object");
    return result;
  }
  const seen = new Set<string>();
  for (const [id, value] of Object.entries(raw)) {
    const key = id.toLowerCase();
    if (!CATEGORY_ID_RE.test(id) || seen.has(key)) {
      issues.push(`Invalid or duplicate category extension: ${id}`);
      continue;
    }
    seen.add(key);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      issues.push(`Category extension ${id} must be an object`);
      continue;
    }
    const slots = parseFacetSlots((value as Record<string, unknown>).slots, issues);
    if (slots.length) Object.defineProperty(result, key, { value: { slots }, enumerable: true, configurable: true, writable: true });
  }
  return result;
}

/** Stable, reserved project namespace; labels and ordering never affect identity. */
export function newFacetSlotId(): string {
  return `user-${crypto.randomUUID().replace(/-/g, "")}`;
}
