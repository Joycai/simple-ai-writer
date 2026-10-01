import { it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NativeSlideView } from '../NativeSlideView';
import { resolveDeck } from '../../../lib/pptx/native/resolve';
import fixture from '../../../lib/pptx/native/__tests__/fixtures/six-layouts.slides.json';

it('renders the resolved six-layout deck with exact line text, fonts and table geometry', async () => {
  const result = await resolveDeck(fixture, { hasFont: async () => true, measure: runs => runs.reduce((n, r) => n + r.text.length * 10, 0),
    loadImage: async (_, assetId) => ({ assetId, width: 100, height: 100, byteLength: 10, mime: 'image/png', data: 'data:image/png;base64,eA==' }) });
  expect(result.ok).toBe(true); if (!result.ok) return;
  const deck = result.value;
  const rendered = deck.slides.map((_, index) => renderToStaticMarkup(createElement(NativeSlideView, { deck, index })));
  expect(rendered.every(svg => svg.includes('viewBox="0 0 960 540"'))).toBe(true);
  expect(rendered[0]).toContain('原生演示');
  expect(rendered[0]).toContain('font-family="Microsoft YaHei"');
  expect(rendered[2]).toContain('x="479" y="162" width="2" height="330"');
  expect(rendered[3]).toContain('data:image/png;base64,eA==');
  expect(rendered[3]).toContain('overflow="hidden"');
  expect(rendered[5]).toContain('阶段');
  const table = deck.slides[5].objects.find(o => o.kind === 'table')!;
  expect(rendered[5]).toContain(`height="${table.rowHeights[0]}"`);
});
