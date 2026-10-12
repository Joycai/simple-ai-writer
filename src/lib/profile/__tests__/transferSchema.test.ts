import { beforeEach, describe, expect, it, vi } from 'vitest';
const files = vi.hoisted(() => new Map<string, string>());
vi.mock('../../fs/fileio', () => ({
  fileExists: async (p: string) => files.has(p), readFile: async (p: string) => files.get(p)!,
  writeFile: async (p: string, v: string) => { files.set(p,v); }, makeDir: async () => {},
}));
import { applyLoreSchema, canonical, emptySchema, mergeLoreSchema, parseLoreSchema, readSchemaProfile, validateSchemaForProfile, type LoreSchema } from '../transferSchema';
import { parseProfileFile } from '../file';
const slot = (id: string, label = id) => ({ id, labelZh: label, labelEn: label });
const category = (id: string, label = id) => ({ id, labelZh: label, labelEn: label });
const schema = (slots = [slot('skill')]): LoreSchema => ({ ...emptySchema(), categories: [{ ...category('people'), slots }] });
beforeEach(() => files.clear());
describe('portable category schema', () => {
  it('adds categories and merges slots without changing either input', () => {
    const target = schema(), source = schema([slot('history')]);
    const before = canonical([target, source]);
    const result = mergeLoreSchema(target,source);
    expect(result.conflicts).toEqual([]);
    expect(result.schema.categories[0].slots?.map(s => s.id)).toEqual(['skill','history']);
    expect(canonical([target,source])).toBe(before);
  });
  it('defaults each conflicting category and slot to the target; choices are independent', () => {
    const target = schema(), source = schema([slot('skill','Changed')]);
    source.categories[0].labelZh = '传入';
    const kept = mergeLoreSchema(target,source);
    expect(kept.conflicts.map(c => c.key)).toEqual(['people/category','people/slot/skill']);
    expect(kept.schema).toEqual(target);
    const selected = mergeLoreSchema(target,source,{'people/slot/skill':'source'}).schema;
    expect(selected.categories[0].labelZh).toBe('people');
    expect(selected.categories[0].slots?.[0].labelZh).toBe('Changed');
  });
  it('merges extension versus custom-category storage with correct source/target precedence', () => {
    const target: LoreSchema = { ...emptySchema(), categoryExtensions: { people: { slots: [slot('skill','Target')] } } };
    const source = schema();
    expect(mergeLoreSchema(target,source).schema.categories[0].slots?.[0].labelZh).toBe('Target');
    expect(mergeLoreSchema(target,source,{'people/slot/skill':'source'}).schema.categories[0].slots?.[0].labelZh).toBe('skill');
  });
  it('keeps dormant extensions and never treats an omitted definition as deletion', () => {
    const target: LoreSchema = { ...emptySchema(), categoryExtensions: { disabled: { slots: [slot('skill')] } } };
    expect(mergeLoreSchema(target,emptySchema()).schema).toEqual(target);
  });
  it('refuses incompatible built-in IDs rather than silently hiding incoming definitions', () => {
    const selection = parseProfileFile({version:3,enabled:['novel']});
    expect(() => validateSchemaForProfile({...emptySchema(),categories:[category('characters','Different')]},selection)).toThrow('enabled pack');
  });
  it('rejects malformed, future and oversized definitions instead of truncating', () => {
    expect(() => parseLoreSchema({ version: 2 })).toThrow();
    expect(() => parseLoreSchema({ ...emptySchema(), categories: [{ id:'../bad' }] })).toThrow();
    const a = schema(Array.from({length:12},(_,i) => slot(`s${i}`)));
    expect(() => mergeLoreSchema(a,schema([slot('extra')]))).toThrow();
  });
  it('backs up the profile and preserves packs/collections while importing schema', async () => {
    const path = '/p/.ai-writer/profile.json';
    const raw = JSON.stringify({ version:3, enabled:['novel'], collections:['saved'] });
    files.set(path,raw);
    await applyLoreSchema('/p',emptySchema(),schema());
    const saved = JSON.parse(files.get(path)!);
    expect(saved.enabled).toEqual(['novel']);
    expect(saved.collections).toEqual(['saved']);
    expect(saved.categories).toEqual(schema().categories);
    expect([...files].find(([p]) => p.includes('/backups/'))?.[1]).toBe(raw);
  });
  it('rejects stale previews and corrupt local profiles before writing', async () => {
    files.set('/p/.ai-writer/profile.json',JSON.stringify({version:3,enabled:[],categories:schema().categories}));
    await expect(applyLoreSchema('/p',emptySchema(),schema())).rejects.toThrow('changed');
    expect(files.size).toBe(1);
    files.set('/p/.ai-writer/profile.json','broken');
    await expect(readSchemaProfile('/p')).rejects.toThrow();
  });
});
