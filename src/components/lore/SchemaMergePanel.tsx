import { useTranslation } from 'react-i18next';
import { mergeLoreSchema, type LoreSchema, type SchemaChoices } from '../../lib/profile/transferSchema';
import type { FacetSlot } from '../../lib/profile/model';

function Definition({ value }: { value: unknown }) {
  const { t } = useTranslation();
  const v = value as FacetSlot;
  return <div>
    <b>{v.labelZh} / {v.labelEn}</b>
    {v.hintZh && <p>{v.hintZh}</p>}{v.hintEn && <p>{v.hintEn}</p>}
    {v.expected && <p>{t('lore.schemaTransfer.expected')}</p>}
    {v.defaults && <dl>{Object.entries(v.defaults).map(([key, val]) => <div key={key}>
      <dt>{t(`lore.schemaTransfer.${key}`)}</dt><dd>{key === 'mode' ? t(`lore.slotEditor.${val}`) : Array.isArray(val) ? val.join(', ') : String(val)}</dd>
    </div>)}</dl>}
  </div>;
}

/** The same receiving-side default and per-ID choices in both transfer flows. */
export function SchemaMergePanel({ source, target, choices, onChange, disabled = false }: {
  source: LoreSchema; target: LoreSchema; choices: SchemaChoices;
  onChange: (choices: SchemaChoices) => void; disabled?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const { conflicts } = mergeLoreSchema(target, source, choices);
  return <section style={{ margin: '12px 0', font: '400 12px/1.6 var(--font-sans)' }}>
    <strong>{t('lore.schemaTransfer.title')}</strong>
    <p>{t('lore.schemaTransfer.description', { categories: source.categories.length, slots: source.categories.reduce((n,c) => n + (c.slots?.length ?? 0), 0) + Object.values(source.categoryExtensions).reduce((n,e) => n + e.slots.length, 0) })}</p>
    {conflicts.map(c => <div key={c.key} style={{ padding: '8px 0', borderTop: '1px solid var(--color-border)' }}>
      <label>{i18n.language.startsWith('zh') ? (c.source as FacetSlot).labelZh : (c.source as FacetSlot).labelEn} <small>({c.key})</small>{' '}
        <select disabled={disabled} value={choices[c.key] ?? 'target'} onChange={e => onChange({ ...choices, [c.key]: e.target.value as 'target' | 'source' })}>
          <option value="target">{t('lore.schemaTransfer.keep')}</option>
          <option value="source">{t('lore.schemaTransfer.replace')}</option>
        </select>
      </label>
      <details><summary>{t('lore.schemaTransfer.compare')}</summary>
        <div>{t('lore.schemaTransfer.keep')}<Definition value={c.target} /></div>
        <div>{t('lore.schemaTransfer.replace')}<Definition value={c.source} /></div>
      </details>
    </div>)}
  </section>;
}
