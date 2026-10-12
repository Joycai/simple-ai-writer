import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ files: new Map<string,string>(), manifest: '', entities: false, moves: [] as string[] }));
vi.mock('../../fs/fileio', () => ({
  fileExists: async (p: string) => h.files.has(p),
  readFile: async (p: string) => h.files.get(p)!,
  writeFile: async (p: string,v: string) => { h.files.set(p,v); },
  makeDir: async () => {}, removeDir: async () => {},
  renamePath: async (_a: string,b: string) => { h.moves.push(b); },
  readDir: async (p: string) => !h.entities ? [] : p.endsWith('/people') ? [{name:'hero',path:`${p}/hero`,isDirectory:true}] : [{name:'people',path:`${p}/people`,isDirectory:true}],
}));
vi.mock('../../fs/transfer', () => ({
  zipExportDialog: async (_p: string,_prefix: string,manifest: string) => { h.manifest=manifest; return '/bundle.zip'; },
  zipImportDialog: async () => ({manifest:h.manifest,zip_path:'/bundle.zip',file_count:0}),
}));
vi.mock('../entity', () => ({uniqueEntityId: async () => 'hero-2'}));
vi.mock('../../profile/active', () => ({activeWorkspace: () => ({enabled:[]}),loreCategoryIds: () => []}));
vi.mock('@tauri-apps/api/app', () => ({getVersion: async () => 'test'}));
import { exportLoreBundle, stageLoreImport, applyLoreImport } from '../transfer';
const category = {id:'people',labelZh:'人物',labelEn:'People',slots:[{id:'skill',labelZh:'技能',labelEn:'Skill',defaults:{mode:'always',priority:3}}]};
beforeEach(() => { h.files.clear(); h.manifest=''; h.entities=false; h.moves=[]; });
it('round-trips a definition-only bundle including dormant predefined-category extensions', async () => {
  const extensions={characters:{slots:[{id:'custom-skill',labelZh:'技能',labelEn:'Skill'}]}};
  h.files.set('/source/.ai-writer/profile.json',JSON.stringify({version:3,enabled:[],categories:[category],categoryExtensions:extensions}));
  await exportLoreBundle('/source');
  expect(JSON.parse(h.manifest).version).toBe(2);
  const staged=await stageLoreImport('/dest');
  expect(staged?.entities).toEqual([]);
  await applyLoreImport('/dest',staged!,'skip');
  const saved=JSON.parse(h.files.get('/dest/.ai-writer/profile.json')!);
  expect(saved.categories).toEqual([category]);
  expect(saved.categoryExtensions).toEqual(extensions);
  expect(saved.enabled).toEqual(['novel']);
});
it('imports legacy entry-only bundles without changing the profile', async () => {
  h.entities=true;
  h.manifest=JSON.stringify({kind:'ai-writer-lore-bundle',version:1});
  const staged=await stageLoreImport('/dest');
  expect(staged?.schema).toBeUndefined();
  await applyLoreImport('/dest',staged!,'skip');
  expect(h.files.size).toBe(0);
  expect(h.moves).toEqual(['/dest/.ai-writer/lore/people/hero']);
});
it('rejects corrupt and future definitions before any content moves', async () => {
  h.entities=true;
  for (const manifest of ['broken',JSON.stringify({kind:'ai-writer-lore-bundle',version:9}),JSON.stringify({kind:'ai-writer-lore-bundle',version:2,schema:{version:2}})]) {
    h.manifest=manifest;
    await expect(stageLoreImport('/dest')).rejects.toThrow();
    expect(h.moves).toEqual([]);
  }
});
