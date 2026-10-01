import { describe, it, expect } from 'vitest';
import { fontRuns, layoutDeck, type MeasureText } from '../layout';
import { DECK_THEMES } from '../theme';
import type { DeckSpec } from '../model';
const fonts = { latin: 'Arial', cjk: 'PingFang SC' };
const measure: MeasureText = (runs, size) => runs.reduce((n, r) => n + [...r.text].length * size, 0);
const deck = (slide: DeckSpec['slides'][number]): DeckSpec => ({ version: 1, language: 'zh-CN', theme: 'paper', assets: [], slides: [slide] });
describe('native layout', () => {
  it('retains bilingual text with separate explicit font runs', () => {
    expect(fontRuns('Hello 中文！', fonts)).toEqual([{ text: 'Hello ', fontFace: 'Arial' }, { text: '中文！', fontFace: 'PingFang SC' }]);
  });
  it('keeps all text, notes and objects inside the page at fixed sizes', () => {
    const source = deck({ id: 'a', layout: 'title', title: '标题', subtitle: 'First\n第二行', notes: 'note' });
    const result = layoutDeck(source, DECK_THEMES.paper, fonts, measure);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0].notes).toBe('note');
    expect(result.value[0].objects.filter(o => o.kind === 'text').map(o => o.runs.map(r => r.text).join(''))).toEqual(['标题', 'First', '第二行']);
    for (const o of result.value[0].objects) { expect(o.x + o.w).toBeLessThanOrEqual(960); expect(o.y + o.h).toBeLessThanOrEqual(540); }
  });
  it('rejects overflow with exact field and slide ID, never shrinks or truncates', () => {
    expect(layoutDeck(deck({ id: 'long', layout: 'bullets', title: 'T', bullets: ['中'.repeat(300)] }), DECK_THEMES.paper, fonts, measure))
      .toEqual({ ok: false, diagnostics: [{ code: 'text_overflow', path: '/slides/0/bullets/0', slideId: 'long' }] });
  });
  it('rejects more than six bullets and unsupported layouts', () => {
    const result = layoutDeck(deck({ id: 'a', layout: 'bullets', title: 'T', bullets: Array(7).fill('a') }), DECK_THEMES.paper, fonts, measure);
    expect(result.ok).toBe(false);
    expect(layoutDeck(deck({ id: 'a', layout: 'table', title: 'T', columns: ['a'], rows: [['b']] }), DECK_THEMES.paper, fonts, measure).diagnostics[0].code).toBe('unsupported_layout');
  });
  it('refuses unreliable measurements', () => {
    expect(layoutDeck(deck({ id: 'a', layout: 'title', title: 'T' }), DECK_THEMES.paper, fonts, () => NaN).diagnostics[0].code).toBe('measurement_failed');
  });
});
it('wraps at Latin words without splitting combining marks and preserves all characters', () => {
  const title = 'One short phrase repeated with words and e\u0301 combining marks '.repeat(2);
  const result = layoutDeck(deck({ id: 'a', layout: 'title', title }), DECK_THEMES.paper, fonts,
    runs => runs.reduce((n,r) => n + [...r.text].length * 10, 0));
  expect(result.ok).toBe(true); if (!result.ok) return;
  const lines = result.value[0].objects.filter(o => o.kind === 'text').map(o => o.runs.map(r => r.text).join(''));
  expect(lines.join('')).toBe(title);
  expect(lines.some(line => line.startsWith('\u0301'))).toBe(false);
});
