/** Portable author-owned category definitions. No packs, tasks or application settings. */
import { parseCategoryList, type ProfileCategory, type FacetSlot } from './model';
import { parseCategoryExtensions, type CategoryExtensions } from './categoryExtensions';
import { parseProfileFile, type ProfileSelection } from './file';
import { resolveWorkspace } from './resolve';
import { saveProfileFile } from './store';
import { fileExists, readFile, writeFile, makeDir } from '../fs/fileio';

export interface LoreSchema { version: 1; categories: ProfileCategory[]; categoryExtensions: CategoryExtensions }
export type SchemaChoices = Record<string, 'target' | 'source'>;
interface SchemaConflict { key: string; target: unknown; source: unknown }
export const emptySchema = (): LoreSchema => ({ version: 1, categories: [], categoryExtensions: {} });
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function parseLoreSchema(raw: unknown): LoreSchema {
  if (!raw || typeof raw !== 'object' || (raw as LoreSchema).version !== 1) throw new Error('Unsupported knowledge-base schema');
  const value = raw as LoreSchema;
  if (!Array.isArray(value.categories) || !value.categoryExtensions) throw new Error('Invalid knowledge-base schema');
  const issues: string[] = [];
  const categories = parseCategoryList(value.categories, issues);
  const categoryExtensions = parseCategoryExtensions(value.categoryExtensions, issues);
  if (issues.length) throw new Error(`Invalid knowledge-base schema: ${issues.join('; ')}`);
  return { version: 1, categories, categoryExtensions };
}
function schemaOf(selection: ProfileSelection): LoreSchema {
  return parseLoreSchema({ version: 1, categories: selection.customCategories, categoryExtensions: selection.categoryExtensions ?? {} });
}
export function mergeLoreSchema(target: LoreSchema, source: LoreSchema, choices: SchemaChoices = {}) {
  const conflicts: SchemaConflict[] = [];
  function choose<T>(key: string, a: T, b: T): T {
    if (canonical(a) === canonical(b)) return a;
    conflicts.push({ key, target: a, source: b });
    return choices[key] === 'source' ? b : a;
  }
  function slots(id: string, a: FacetSlot[] = [], b: FacetSlot[] = []) {
    const map = new Map(a.map(s => [s.id.toLowerCase(), s]));
    for (const s of b) {
      const key = s.id.toLowerCase(), old = map.get(key);
      map.set(key, old ? choose(`${id}/slot/${key}`, old, s) : s);
    }
    return [...map.values()];
  }
  const cats = new Map(target.categories.map(c => [c.id.toLowerCase(), c]));
  for (const c of source.categories) {
    const id = c.id.toLowerCase(), old = cats.get(id);
    if (!old) { cats.set(id, c); continue; }
    const { slots: _a, ...am } = old, { slots: _b, ...bm } = c;
    cats.set(id, choose(`${id}/category`, am, bm));
  }
  const ext: CategoryExtensions = {};
  const ids = new Set([...cats.keys(), ...Object.keys(target.categoryExtensions), ...Object.keys(source.categoryExtensions)]);
  for (const id of ids) {
    const targetSlots = [...(target.categories.find(c => c.id.toLowerCase() === id)?.slots ?? []), ...(target.categoryExtensions[id]?.slots ?? [])];
    const sourceSlots = [...(source.categories.find(c => c.id.toLowerCase() === id)?.slots ?? []), ...(source.categoryExtensions[id]?.slots ?? [])];
    const merged = slots(id, targetSlots, sourceSlots);
    const category = cats.get(id);
    if (category) cats.set(id, { ...category, ...(merged.length ? { slots: merged } : {}) });
    else if (merged.length) Object.defineProperty(ext, id, { value: { slots: merged }, enumerable: true });
  }
  const schema = parseLoreSchema({ version: 1, categories: [...cats.values()], categoryExtensions: ext });
  return { schema, conflicts };
}
export async function readSchemaProfile(project: string): Promise<{ raw: string | null; selection: ProfileSelection; schema: LoreSchema }> {
  const path = `${project}/.ai-writer/profile.json`;
  const raw = await fileExists(path) ? await readFile(path) : null;
  const selection = parseProfileFile(raw === null ? { version: 3, enabled: ['novel'] } : JSON.parse(raw));
  if (selection.issues.length) throw new Error(`Cannot transfer an invalid profile: ${selection.issues.join('; ')}`);
  return { raw, selection, schema: schemaOf(selection) };
}
/** Built-in definitions remain read-only; incompatible imports must never appear to have landed. */
export function validateSchemaForProfile(schema: LoreSchema, selection: ProfileSelection): void {
  const builtins = resolveWorkspace(selection.enabled).categories;
  for (const c of builtins) {
    const custom = schema.categories.find(cat => cat.id.toLowerCase() === c.id.toLowerCase());
    if (custom && (custom.labelZh !== c.labelZh || custom.labelEn !== c.labelEn)) {
      throw new Error(`Category ${c.id} belongs to an enabled pack; rename the incoming custom category before importing`);
    }
    const slots = [...(custom?.slots ?? []), ...(schema.categoryExtensions[c.id]?.slots ?? [])];
    for (const slot of slots) {
      const builtin = c.slots?.find(s => s.id.toLowerCase() === slot.id.toLowerCase());
      if (builtin && canonical(builtin) !== canonical(slot)) throw new Error(`Slot ${c.id}/${slot.id} belongs to an enabled pack and cannot be replaced`);
    }
  }
}
/** Recheck the full profile, back it up, then preserve all unrelated profile fields. */
export async function applyLoreSchema(project: string, expected: LoreSchema, schema: LoreSchema) {
  const current = await readSchemaProfile(project);
  if (canonical(current.schema) !== canonical(expected)) throw new Error('Category definitions changed; reopen the preview');
  if (canonical(current.schema) === canonical(schema)) return;
  validateSchemaForProfile(schema, current.selection);
  const path = `${project}/.ai-writer/profile.json`;
  if (current.raw !== null) {
    const dir = `${project}/.ai-writer/backups`;
    await makeDir(dir);
    await writeFile(`${dir}/profile-${Date.now()}-${crypto.randomUUID()}.json`, current.raw);
  }
  const latest = await fileExists(path) ? await readFile(path) : null;
  if (latest !== current.raw) throw new Error('Project configuration changed; reopen the preview');
  await saveProfileFile(project, { ...current.selection, customCategories: schema.categories, categoryExtensions: schema.categoryExtensions });
}
