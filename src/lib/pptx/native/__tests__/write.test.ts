import { it, expect } from 'vitest';
import JSZip from 'jszip';
import { readFileSync } from 'node:fs';
import { resolveDeck } from '../resolve';
import { nativeDeckToPptx } from '../write';
import { imageHeader } from '../imageHeader';
import fixture from './fixtures/six-layouts.slides.json';
import capacity from './fixtures/capacity.slides.json';
it('writes editable bilingual text, exact point geometry, cropped media, notes and relationships', async () => {
  const bytes = readFileSync('public/logo.png');
  const input = fixture;
  const result = await resolveDeck(input, { hasFont: async face => ['Arial', 'Arial Unicode MS'].includes(face), measure: runs => runs.reduce((n,r) => n+r.text.length*12,0),
    loadImage: async (_, assetId) => ({ assetId, ...imageHeader(bytes), byteLength: bytes.length, data: `data:image/png;base64,${bytes.toString('base64')}` }) });
  expect(result.ok).toBe(true); if (!result.ok) return;
  const zip = await JSZip.loadAsync(await nativeDeckToPptx(result.value));
  const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
  expect(xml).toContain('<a:ea typeface="Arial Unicode MS"');
  expect(xml).toContain('<a:latin typeface="Arial"');
  expect(xml).toMatch(/<a:rPr lang="en-US"[^>]*>[\s\S]*?<a:latin typeface="Arial"/);
  expect(xml).toContain('原生演示'); expect(xml).toContain('Native slides');
  expect(xml).toContain('x="609600" y="1930400"'); // 48pt, 152pt
  expect(xml).not.toContain('<a:normAutofit');
  expect(await zip.file('ppt/presentation.xml')!.async('string')).toContain('cx="12192000" cy="6858000"');
  const bullets = await zip.file('ppt/slides/slide2.xml')!.async('string');
  expect((bullets.match(/<a:buChar /g) ?? []).length).toBe(3);
  const image = await zip.file('ppt/slides/slide4.xml')!.async('string');
  expect(image).toContain('<p:pic>'); expect(image).toContain('<a:srcRect'); expect(image).toContain('应用标志');
  expect(await zip.file('ppt/slides/_rels/slide4.xml.rels')!.async('string')).toContain('/image');
  const comparison = await zip.file('ppt/slides/slide3.xml')!.async('string');
  expect(comparison).toContain('HTML'); expect(comparison).toContain('Native');
  expect((comparison.match(/<a:buChar /g) ?? []).length).toBe(4);
  const metrics = await zip.file('ppt/slides/slide5.xml')!.async('string');
  expect(metrics).toContain('16:9'); expect(metrics).toContain('首版目标');
  const table = await zip.file('ppt/slides/slide6.xml')!.async('string');
  expect(table).toContain('<a:tbl>'); expect(table).toContain('<p:graphicFrame>');
  expect((table.match(/<a:tr /g) ?? []).length).toBe(input.slides[5].rows!.length + 1);
  expect(table).toContain('marL="101600"'); // 8pt cell padding
  expect(table).toContain('<a:spcPts val="2520"/>'); // 25.2pt explicit line spacing
  expect(table).toContain('<a:ea typeface="Arial Unicode MS"');
  expect(table).not.toContain('<a:normAutofit');
  for (const row of [input.slides[5].columns!, ...input.slides[5].rows!]) for (const cell of row) {
    for (const part of cell.split('\n')) expect(table).toContain(part);
  }
  const resolvedTable = result.value.slides[5].objects.find(o => o.kind === 'table')!;
  const heights = [...table.matchAll(/<a:tr h="(\d+)"/g)].map(m => Number(m[1]));
  expect(heights).toEqual(resolvedTable.rowHeights.map(h => Math.round(h * 12700)));
  expect([...table.matchAll(/<a:gridCol w="(\d+)"/g)].map(m => Number(m[1])))
    .toEqual(resolvedTable.columnWidths.map(w => Math.round(w * 12700)));
  const media = Object.keys(zip.files).filter(p => /^ppt\/media\/.*\.png$/.test(p));
  expect(media).toHaveLength(1); expect(await zip.file(media[0])!.async('uint8array')).toEqual(new Uint8Array(bytes));
  expect(await zip.file('ppt/notesSlides/notesSlide1.xml')!.async('string')).toContain('图片路径相对于项目根目录');
  expect(Object.keys(zip.files).filter(p => /^ppt\/slides\/slide\d+\.xml$/.test(p))).toHaveLength(6);
});
it('keeps crop anchors and contain geometry in actual OOXML', async () => {
  const bytes = readFileSync('public/logo.png');
  const source = { version: 1, language: 'en-US', theme: 'midnight', assets: [{ id: 'pic', path: 'pic.png' }],
    slides: [0, 1, 2].map((n) => ({ id: `s${n}`, layout: 'image-text', title: 'Image', body: 'Text',
      image: { assetId: 'pic', alt: 'Picture', fit: n === 2 ? 'contain' : 'cover', anchor: { x: n === 1 ? 1 : 0, y: n === 1 ? 1 : 0 } } })) };
  const result = await resolveDeck(source, { hasFont: async () => true, measure: () => 50,
    loadImage: async (_,assetId) => ({ assetId, width: 200, height: 100, mime: 'image/png', byteLength: bytes.length, data: `data:image/png;base64,${bytes.toString('base64')}` }) });
  expect(result.ok).toBe(true); if (!result.ok) return;
  const zip = await JSZip.loadAsync(await nativeDeckToPptx(result.value));
  const first = await zip.file('ppt/slides/slide1.xml')!.async('string');
  const last = await zip.file('ppt/slides/slide2.xml')!.async('string');
  const contain = await zip.file('ppt/slides/slide3.xml')!.async('string');
  expect(first).toContain('<a:srcRect l="0" r="32727" t="0" b="0"/>');
  expect(last).toContain('<a:srcRect l="32727" r="0" t="0" b="0"/>');
  expect(contain).not.toContain('<a:srcRect');
  expect(contain).toContain('cx="5638800" cy="2819400"'); // 444x222pt, original 2:1 ratio
  expect(contain).toContain('val="142033"');
});
it('preserves bilingual cell paragraph boundaries, blank lines and empty cells', async () => {
  const source = { version: 1, language: 'zh-CN', theme: 'midnight', assets: [], slides: [
    { id: 'table', layout: 'table', title: 'T', columns: ['A', 'B'], rows: [['中文 A\nEnglish 中\n\n末行\n', '']] },
  ] };
  const result = await resolveDeck(source, { hasFont: async () => true, measure: () => 30, loadImage: async () => { throw new Error('unused'); } });
  expect(result.ok).toBe(true); if (!result.ok) return;
  const zip = await JSZip.loadAsync(await nativeDeckToPptx(result.value));
  const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
  const cells = [...xml.matchAll(/<a:tc>([\s\S]*?)<\/a:tc>/g)].map(m => m[1]);
  const paragraphs = [...cells[2].matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)]
    .map(m => [...m[1].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map(t => t[1]).join(''));
  expect(paragraphs).toEqual(['中文 A', 'English 中', '', '末行', '']);
  expect(cells).toHaveLength(4);
  expect(cells[3]).not.toMatch(/<a:t>[^<]+<\/a:t>/);
  expect(xml).toContain('val="142033"');
  expect(xml).toContain('val="78BEFF"');
  // Writing must not mutate frozen cell arrays/options, even on repeated export.
  await expect(nativeDeckToPptx(result.value)).resolves.toBeInstanceOf(Uint8Array);
});

it('writes boundary fixtures with native cells, fixed sizes and one style per paragraph', async () => {
  const result = await resolveDeck(capacity, { hasFont: async f => ['Arial', 'Arial Unicode MS'].includes(f),
    measure: (runs, size) => runs.reduce((sum, r) => sum + [...r.text].length * size * 0.55, 0),
    loadImage: async () => { throw new Error('unused'); } });
  expect(result.ok).toBe(true); if (!result.ok) return;
  const zip = await JSZip.loadAsync(await nativeDeckToPptx(result.value));
  expect(Object.keys(zip.files).filter(p => /^ppt\/slides\/slide\d+\.xml$/.test(p))).toHaveLength(4);
  for (let n = 1; n <= 4; n++) {
    const xml = await zip.file(`ppt/slides/slide${n}.xml`)!.async('string');
    for (const paragraph of xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g))
      expect((paragraph[1].match(/<a:pPr\b/g) ?? []).length).toBeLessThanOrEqual(1);
    expect(xml).not.toContain('<a:normAutofit');
    expect([...xml.matchAll(/\bsz="(\d+)"/g)].every(m => Number(m[1]) >= 1800)).toBe(true);
  }
  const table = await zip.file('ppt/slides/slide3.xml')!.async('string');
  expect((table.match(/<a:tc>/g) ?? []).length).toBe(48);
  expect((table.match(/<a:tr /g) ?? []).length).toBe(8);
  expect(table).toContain('<a:t>7-6</a:t>');
  expect(result.value.slides[2].objects.find(o => o.kind === 'table')?.h).toBeCloseTo(329.6);
});
