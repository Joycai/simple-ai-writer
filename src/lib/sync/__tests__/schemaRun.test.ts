import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({calls:[] as string[], fail:false, localChanged:false, remoteHash:'remote'}));
vi.mock('../../fs/fileio', () => ({fileExists:async()=>false,makeDir:async()=>{},removeDir:async()=>{},removeFile:async()=>{},readBinaryFile:async()=>new Uint8Array([1]),renamePath:async()=>{},writeFile:async()=>{},writeBinaryFile:async()=>{}}));
vi.mock('../local', () => ({loreRoot:()=>'/p/lore',entryDir:()=>'/p/lore/people/hero',zipEntry:async()=>1,hashEntryDir:async()=>'entry',unzipEntry:async()=>1}));
vi.mock('@tauri-apps/api/path', () => ({appDataDir:async()=>'/app'}));
vi.mock('../../profile/transferSchema',async original => ({
  ...await original<typeof import('../../profile/transferSchema')>(),
  readSchemaProfile:async()=>({raw:'{}',selection:{enabled:[]},schema:h.localChanged ? {...emptySchema(),categories:[{id:'changed',labelZh:'a',labelEn:'a'}]} : emptySchema()}),
  applyLoreSchema:async()=>{h.calls.push('schema');if(h.fail)throw new Error('disk failed');},
}));
import { emptySchema, type LoreSchema } from '../../profile/transferSchema';
import { planSync } from '../plan';
import { runSync } from '../run';
import { withSchemaChoices } from '../schema';
import type { SyncClient } from '../client';
const incoming:LoreSchema={...emptySchema(),categories:[{id:'people',labelZh:'人',labelEn:'People'}]};
const client={manifest:async()=>({schema:{hash:h.remoteHash,data:incoming}}),downloadEntry:async()=>{h.calls.push('entry');return {bytes:new Uint8Array([1]),hash:'entry'};}} as unknown as SyncClient;
const binding={serverUrl:'http://test',kbId:'kb',kbName:'KB',snapshot:{},lastSyncAt:null};
const plan=()=>withSchemaChoices({...planSync({local:{},remote:{'people/hero':'entry'},snapshot:{},direction:'pull'}),schema:{local:emptySchema(),remote:incoming,remoteHash:'remote',choices:{}}},{});
beforeEach(()=>{h.calls=[];h.fail=false;h.localChanged=false;h.remoteHash='remote';});
it('writes schema before dependent entries, and snapshots definitions only when equal',async()=>{
 const result=await runSync({projectPath:'/p',binding,client,plan:plan()});
 expect(h.calls).toEqual(['schema','entry']);
 expect(result.binding.snapshot['@schema']).toMatch(/^[a-f0-9]{64}$/);
});
it('does not transfer entries when definitions fail',async()=>{
 h.fail=true;
 await expect(runSync({projectPath:'/p',binding,client,plan:plan()})).rejects.toThrow('disk');
 expect(h.calls).toEqual(['schema']);
});
it('rejects local and remote changes since preview before writes',async()=>{
 h.localChanged=true;
 await expect(runSync({projectPath:'/p',binding,client,plan:plan()})).rejects.toThrow('changed');
 h.localChanged=false;h.remoteHash='changed';
 await expect(runSync({projectPath:'/p',binding,client,plan:plan()})).rejects.toThrow('changed');
 expect(h.calls).toEqual([]);
});
