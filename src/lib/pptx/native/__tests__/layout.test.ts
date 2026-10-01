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
  it('rejects more than six bullets', () => {
    const result = layoutDeck(deck({ id: 'a', layout: 'bullets', title: 'T', bullets: Array(7).fill('a') }), DECK_THEMES.paper, fonts, measure);
    expect(result.ok).toBe(false);
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

it('fits six metric cards and both comparison columns with editable objects', () => {
  const slides: DeckSpec['slides'] = [
    { id: 'metrics', layout: 'metrics', title: 'Numbers', metrics: Array.from({ length: 6 }, (_, i) => ({ value: `${i}`, label: '项目', detail: 'Detail' })) },
    { id: 'compare', layout: 'comparison', title: 'Compare', left: { heading: 'Left', bullets: ['一', '二', '三', '四'] }, right: { heading: 'Right', bullets: ['a', 'b', 'c', 'd'] } },
  ];
  const result = layoutDeck({ ...deck(slides[0]), slides }, DECK_THEMES.paper, fonts, measure);
  expect(result.ok).toBe(true); if (!result.ok) return;
  expect(result.value[0].objects.filter(o => o.kind === 'rule')).toHaveLength(6);
  expect(result.value[1].objects.filter(o => o.kind === 'text' && o.bullet)).toHaveLength(8);
  for (const slide of result.value) for (const o of slide.objects) {
    expect(o.x).toBeGreaterThanOrEqual(48); expect(o.x + o.w).toBeLessThanOrEqual(912);
    expect(o.y + o.h).toBeLessThanOrEqual(492);
    if (o.kind === 'text') expect(o.size).toBeGreaterThanOrEqual(18);
  }
});
it.each([
  [{ id: 'a', layout: 'comparison', title: 'T', left: { heading: 'H', bullets: ['中'.repeat(200)] }, right: { heading: 'H', bullets: [] } }, '/slides/0/left/bullets/0'],
  [{ id: 'a', layout: 'comparison', title: 'T', left: { heading: '中'.repeat(60), bullets: [] }, right: { heading: 'H', bullets: [] } }, '/slides/0/left/heading'],
  [{ id: 'a', layout: 'comparison', title: 'T', left: { heading: 'H', bullets: [] }, right: { heading: 'H', bullets: Array(5).fill('x') } }, '/slides/0/right/bullets'],
  [{ id: 'a', layout: 'metrics', title: 'T', metrics: [{ value: '1'.repeat(100), label: 'L' }] }, '/slides/0/metrics/0/value'],
  [{ id: 'a', layout: 'metrics', title: 'T', metrics: [{ value: '1', label: '中'.repeat(100) }] }, '/slides/0/metrics/0/label'],
  [{ id: 'a', layout: 'metrics', title: 'T', metrics: Array(6).fill({ value: '1', label: 'L', detail: 'a\nb' }) }, '/slides/0/metrics/0/detail'],
  [{ id: 'a', layout: 'table', title: 'T', columns: Array(7).fill('C'), rows: [] }, '/slides/0/columns'],
  [{ id: 'a', layout: 'table', title: 'T', columns: ['C'], rows: Array(8).fill(['R']) }, '/slides/0/rows'],
  [{ id: 'a', layout: 'table', title: 'T', columns: ['C'], rows: [['中'.repeat(1000)]] }, '/slides/0/rows/0/0'],
  [{ id: 'a', layout: 'table', title: 'T', columns: ['中'.repeat(1000)], rows: [] }, '/slides/0/columns/0'],
] as [DeckSpec['slides'][number], string][])('rejects excess content at its source field', (slide, path) => {
  const result = layoutDeck(deck(slide), DECK_THEMES.paper, fonts, measure);
  expect(result.ok).toBe(false);
  expect(result.diagnostics).toContainEqual({ code: 'text_overflow', path, slideId: 'a' });
  expect(result).not.toHaveProperty('value');
});
it('keeps all table cells and sizes rows from the tallest wrapped cell', () => {
  const source = deck({ id: 't', layout: 'table', title: 'T', columns: ['First', '第二列'], rows: [['a\nb', '中文'], ['', '007']] });
  const result = layoutDeck(source, DECK_THEMES.paper, fonts, measure);
  expect(result.ok).toBe(true); if (!result.ok) return;
  const table = result.value[0].objects.find(o => o.kind === 'table');
  expect(table?.cells.map(row => row.map(cell => cell.lines.map(runs => runs.map(r => r.text).join('')).join('\n')))).toEqual([['First', '第二列'], ['a\nb', '中文'], ['', '007']]);
  expect(table?.rowHeights).toEqual([41.2, 66.4, 41.2]);
  const boundary = layoutDeck(deck({ id: 'b', layout: 'table', title: 'T', columns: Array(6).fill('C'), rows: Array(7).fill(Array(6).fill('R')) }), DECK_THEMES.paper, fonts, measure);
  expect(boundary.ok).toBe(true);
  const overflow = layoutDeck(deck({ id: 'b', layout: 'table', title: 'T', columns: ['C'], rows: Array(7).fill(['a\nb']) }), DECK_THEMES.paper, fonts, measure);
  expect(overflow.diagnostics).toContainEqual({ code: 'text_overflow', path: '/slides/0/rows', slideId: 'b' });
});

it('keeps neutral punctuation with the preceding font without losing characters', () => {
  expect(fontRuns('中文 / English, 数字 6', fonts)).toEqual([
    { text: '中文 / ', fontFace: fonts.cjk }, { text: 'English, ', fontFace: fonts.latin },
    { text: '数字 ', fontFace: fonts.cjk }, { text: '6', fontFace: fonts.latin },
  ]);
});
