import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ files: new Map<string,string>(), manifest: '', entities: false, moves: [] as string[], copies: [] as string[][], cleaned: [] as string[], zipSource: '', exportResult: '/bundle.zip' as string | null, copyFails: false, extraEntry: false }));
vi.mock('../../fs/fileio', () => ({
  fileExists: async (p: string) => h.files.has(p),
  readFile: async (p: string) => h.files.get(p)!,
  writeFile: async (p: string,v: string) => { h.files.set(p,v); },
  makeDir: async () => {}, removeDir: async (p: string) => { h.cleaned.push(p); },
  copyPath: async (a: string,b: string) => { if(h.copyFails) throw new Error('copy failed'); h.copies.push([a,b]); },
  renamePath: async (_a: string,b: string) => { h.moves.push(b); },
  readDir: async (p: string) => !h.entities ? [] : p.endsWith('/people') ? [{name:'hero',path:`${p}/hero`,isDirectory:true},...(h.extraEntry ? [{name:'villain',path:`${p}/villain`,isDirectory:true}] : [])] : [{name:'people',path:`${p}/people`,isDirectory:true}],
}));
vi.mock('../../fs/transfer', () => ({
  zipExportDialog: async (_p: string,_prefix: string,manifest: string) => { h.manifest=manifest; h.zipSource=_p; return h.exportResult; },
  zipImportDialog: async () => ({manifest:h.manifest,zip_path:'/bundle.zip',file_count:0}),
}));
vi.mock('../entity', () => ({uniqueEntityId: async () => 'hero-2'}));
vi.mock('../../profile/active', () => ({activeWorkspace: () => ({enabled:[]}),loreCategoryIds: () => []}));
vi.mock('@tauri-apps/api/app', () => ({getVersion: async () => 'test'}));
import { exportLoreBundle, stageLoreImport, applyLoreImport } from '../transfer';
const category = {id:'people',labelZh:'人物',labelEn:'People',slots:[{id:'skill',labelZh:'技能',labelEn:'Skill',defaults:{mode:'always',priority:3}}]};
beforeEach(() => { h.files.clear(); h.manifest=''; h.entities=false; h.moves=[]; h.copies=[]; h.cleaned=[]; h.zipSource=''; h.exportResult='/bundle.zip'; h.copyFails=false; h.extraEntry=false; });
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

it('exports only selected entry folders and relevant definitions, then imports them', async () => {
  h.entities=true;
  h.extraEntry=true;
  h.files.set('/source/.ai-writer/profile.json',JSON.stringify({version:3,enabled:[],categories:[category,{id:'places',labelZh:'地点',labelEn:'Places'}],categoryExtensions:{people:{slots:[{id:'extra',labelZh:'补充',labelEn:'Extra'}]},characters:{slots:[{id:'other',labelZh:'其他',labelEn:'Other'}]}}}));
  await exportLoreBundle('/source',['/source/.ai-writer/lore/people/hero']);
  const manifest=JSON.parse(h.manifest);
  expect(manifest.entities).toEqual([{category:'people',id:'hero',name:'hero'}]);
  expect(manifest.schema.categories).toEqual([category]);
  expect(Object.keys(manifest.schema.categoryExtensions)).toEqual(['people']);
  expect(h.copies).toEqual([['/source/.ai-writer/lore/people/hero',`${h.zipSource}/people/hero`]]);
  expect(h.zipSource).toMatch(/^\/source\/\.ai-writer\/tmp\/lore-export-/);
  expect(h.cleaned).toEqual([h.zipSource]);
  h.extraEntry=false; // The extracted snapshot contains only hero.
  const staged=await stageLoreImport('/dest');
  await applyLoreImport('/dest',staged!,'skip');
  expect(h.moves).toEqual(['/dest/.ai-writer/lore/people/hero']);
  expect(JSON.parse(h.files.get('/dest/.ai-writer/profile.json')!).categories).toEqual([{...category, slots:[...category.slots, {id:'extra',labelZh:'补充',labelEn:'Extra'}]}]);
});
it('does not turn an empty or stale selection into a full export', async () => {
  h.entities=true;
  for(const paths of [[],['/source/.ai-writer/lore/people/missing'],['/another/.ai-writer/lore/people/hero']]) {
    await expect(exportLoreBundle('/source',paths)).rejects.toThrow('selected entries changed');
  }
  expect(h.manifest).toBe('');
  expect(h.copies).toEqual([]);
});
it('cleans the selected snapshot on dialog cancellation or copy failure', async () => {
  h.entities=true;
  h.exportResult=null;
  await expect(exportLoreBundle('/source',['/source/.ai-writer/lore/people/hero'])).resolves.toBeNull();
  expect(h.cleaned).toEqual([h.zipSource]);
  h.cleaned=[];
  h.copyFails=true;
  await expect(exportLoreBundle('/source',['/source/.ai-writer/lore/people/hero'])).rejects.toThrow('copy failed');
  expect(h.cleaned).toHaveLength(1);
  expect(h.cleaned[0]).toContain('/tmp/lore-export-');
});
