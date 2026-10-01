import { it, expect } from 'vitest';
import JSZip from 'jszip';
import { readFileSync } from 'node:fs';
import { resolveDeck } from '../resolve';
import { nativeDeckToPptx } from '../write';
import { imageHeader } from '../imageHeader';
import fixture from './fixtures/six-layouts.slides.json';
it('writes editable bilingual text, exact point geometry, cropped media, notes and relationships', async () => {
  const bytes = readFileSync('public/logo.png');
  const input = { ...fixture, slides: fixture.slides.filter(s => ['title','bullets','image-text'].includes(s.layout)) };
  const result = await resolveDeck(input, { hasFont: async face => ['Arial', 'Arial Unicode MS'].includes(face), measure: runs => runs.reduce((n,r) => n+r.text.length*12,0),
    loadImage: async (_, assetId) => ({ assetId, ...imageHeader(bytes), byteLength: bytes.length, data: `data:image/png;base64,${bytes.toString('base64')}` }) });
  expect(result.ok).toBe(true); if (!result.ok) return;
  const zip = await JSZip.loadAsync(await nativeDeckToPptx(result.value));
  const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
  expect(xml).toContain('<a:ea typeface="Arial Unicode MS"');
  expect(xml).toContain('<a:latin typeface="Arial"');
  expect(xml).toContain('原生演示'); expect(xml).toContain('Native slides');
  expect(xml).toContain('x="609600" y="1930400"'); // 48pt, 152pt
  expect(xml).not.toContain('<a:normAutofit');
  expect(await zip.file('ppt/presentation.xml')!.async('string')).toContain('cx="12192000" cy="6858000"');
  const bullets = await zip.file('ppt/slides/slide2.xml')!.async('string');
  expect((bullets.match(/<a:buChar /g) ?? []).length).toBe(3);
  const image = await zip.file('ppt/slides/slide3.xml')!.async('string');
  expect(image).toContain('<p:pic>'); expect(image).toContain('<a:srcRect'); expect(image).toContain('应用标志');
  expect(await zip.file('ppt/slides/_rels/slide3.xml.rels')!.async('string')).toContain('/image');
  const media = Object.keys(zip.files).filter(p => /^ppt\/media\/.*\.png$/.test(p));
  expect(media).toHaveLength(1); expect(await zip.file(media[0])!.async('uint8array')).toEqual(new Uint8Array(bytes));
  expect(await zip.file('ppt/notesSlides/notesSlide1.xml')!.async('string')).toContain('图片路径相对于项目根目录');
  expect(Object.keys(zip.files).filter(p => /^ppt\/slides\/slide\d+\.xml$/.test(p))).toHaveLength(3);
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
