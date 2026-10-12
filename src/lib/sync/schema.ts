import { canonical, emptySchema, mergeLoreSchema, parseLoreSchema, readSchemaProfile, type LoreSchema, type SchemaChoices } from '../profile/transferSchema';
import type { RemoteManifest } from './client';
import type { SyncPlan, SyncStep } from './model';
import { withDecisions } from './plan';
export const SCHEMA_PATH = '@schema';
export interface SchemaSync { local: LoreSchema; remote: LoreSchema; remoteHash: string | null; choices: SchemaChoices }
export async function schemaHash(schema: LoreSchema): Promise<string> {
  // Receiving-side display order is retained by the additive merge.
  const sort = <T extends { id: string }>(values: T[]) => [...values].sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const comparable = { ...schema,
    categories: sort(schema.categories).map(c => ({ ...c, ...(c.slots ? { slots: sort(c.slots) } : {}) })),
    categoryExtensions: Object.fromEntries(Object.entries(schema.categoryExtensions).map(([id, e]) => [id, { slots: sort(e.slots) }])),
  };
  const bytes = new TextEncoder().encode(canonical(comparable));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2,'0')).join('');
}
export async function prepareSchema(project: string, manifest: RemoteManifest): Promise<SchemaSync> {
  if (manifest.schema === undefined) throw new Error('This server does not support category definitions. Upgrade the sync server before syncing.');
  const profile = await readSchemaProfile(project);
  const remote = manifest.schema ? parseLoreSchema(manifest.schema.data) : emptySchema();
  return { local: profile.schema, remote, remoteHash: manifest.schema?.hash ?? null, choices: {} };
}
export function schemaMerge(plan: SyncPlan) {
  const s = plan.schema!;
  return plan.direction === 'push' ? mergeLoreSchema(s.remote, s.local, s.choices) : mergeLoreSchema(s.local, s.remote, s.choices);
}
export function withSchemaChoices(plan: SyncPlan, choices: SchemaChoices): SyncPlan {
  if (!plan.schema) return plan;
  const next = { ...plan, schema: { ...plan.schema, choices } };
  const { schema, conflicts } = schemaMerge(next);
  const target = plan.direction === 'push' ? plan.schema.remote : plan.schema.local;
  const old = plan.steps.find(s => s.path === SCHEMA_PATH);
  const step: SyncStep = { path: SCHEMA_PATH, sourceHash: null, targetHash: null,
    localChanged: false, remoteChanged: false, decision: old?.decision ?? 'apply',
    action: canonical(target) === canonical(schema) ? 'none' : 'overwrite',
    warning: conflicts.some(c => choices[c.key] === 'source') ? 'both-changed' : null };
  return withDecisions({ ...next, steps: [step, ...plan.steps.filter(s => s.path !== SCHEMA_PATH)] }, [], 'apply');
}
