import { describe, expect, it } from 'vitest';
import { emptySchema, type LoreSchema } from '../../profile/transferSchema';
import { planSync, actionableSteps } from '../plan';
import { prepareSchema, schemaHash, schemaMerge, withSchemaChoices, SCHEMA_PATH } from '../schema';
import type { RemoteManifest } from '../client';
const schema = (label: string): LoreSchema => ({...emptySchema(), categories:[{id:'people',labelZh:label,labelEn:label}]});
describe('schema sync preview', () => {
  it('shows a definition-only update as actionable, without synthetic entry deletion', () => {
    const plan = withSchemaChoices({...planSync({local:{},remote:{},snapshot:{},direction:'push'}),schema:{local:schema('a'),remote:emptySchema(),remoteHash:null,choices:{}}},{});
    expect(actionableSteps(plan).map(s => s.path)).toEqual([SCHEMA_PATH]);
    expect(schemaMerge(plan).schema).toEqual(schema('a'));
  });
  it('keeps conflicting target definitions until explicitly chosen, in both directions', () => {
    for (const direction of ['push','pull'] as const) {
      const plan = withSchemaChoices({...planSync({local:{},remote:{},snapshot:{},direction}),schema:{local:schema('local'),remote:schema('remote'),remoteHash:'hash',choices:{}}},{});
      expect(actionableSteps(plan)).toEqual([]);
      const changed = withSchemaChoices(plan,{'people/category':'source'});
      expect(changed.summary.warnings).toBe(1);
      expect(schemaMerge(changed).schema.categories[0].labelZh).toBe(direction === 'push' ? 'local' : 'remote');
    }
  });
  it('does not report display ordering alone as unsynced data', async () => {
    const a: LoreSchema = {...emptySchema(),categories:[...schema('a').categories,{id:'places',labelZh:'地点',labelEn:'Places'}]};
    const b = {...a,categories:[...a.categories].reverse()};
    expect(await schemaHash(a)).toBe(await schemaHash(b));
  });
  it('refuses legacy servers instead of silently dropping definitions', async () => {
    await expect(prepareSchema('/p',{} as RemoteManifest)).rejects.toThrow('Upgrade');
  });
});
