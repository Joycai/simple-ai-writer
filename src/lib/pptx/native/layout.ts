import type { DeckSpec } from './model';
import type { DeckTheme } from './theme';
import type { DeckDiagnostic, DeckValidation } from './diagnostics';

export interface TextRun { text: string; fontFace: string }
export interface FontSelection { latin: string; cjk: string }
interface Box { x: number; y: number; w: number; h: number }
type NativeObject =
  | (Box & { kind: 'text'; runs: TextRun[]; size: number; bold: boolean; bullet: boolean })
  | (Box & { kind: 'image'; assetId: string; alt: string; fit: 'cover' | 'contain'; anchor: { x: number; y: number } });
export interface NativeSlide { id: string; notes?: string; objects: NativeObject[] }
export type MeasureText = (runs: readonly TextRun[], size: number, bold: boolean) => number;

/** PptxGenJS emits one face for Latin/EA/CS per run, so split scripts explicitly. */
export function fontRuns(text: string, fonts: FontSelection): TextRun[] {
  const runs: TextRun[] = [];
  for (const char of text) {
    const face = /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef\u{20000}-\u{3134f}]/u.test(char) ? fonts.cjk : fonts.latin;
    const last = runs[runs.length - 1];
    if (last?.fontFace === face) last.text += char;
    else runs.push({ text: char, fontFace: face });
  }
  return runs;
}

/** Fixed-size editable lines. Conservative width reserve covers Office metric differences. */
export function layoutDeck(spec: DeckSpec, theme: DeckTheme, fonts: FontSelection, measure: MeasureText): DeckValidation<NativeSlide[]> {
  const diagnostics: DeckDiagnostic[] = [];
  const slides = spec.slides.map((slide, index): NativeSlide => {
    const objects: NativeObject[] = [];
    const error = (field: string, code: DeckDiagnostic['code'] = 'text_overflow') => diagnostics.push({ code, path: `/slides/${index}/${field}`, slideId: slide.id });
    const text = (value: string, box: Box, size: number, field: string, bold = false, bullet = false) => {
      const lineHeight = size * 1.4;
      const lines: string[] = [];
      let line = '';
      // Preserve every source character; line boundaries are layout, not truncation.
      const Segmenter = (Intl as typeof Intl & { Segmenter: new (locale: string, options: { granularity: 'grapheme' }) => { segment(text: string): Iterable<{ segment: string }> } }).Segmenter;
      if (!Segmenter) { error(field, 'measurement_failed'); return; }
      const units = new Segmenter(spec.language, { granularity: 'grapheme' }).segment(value.replace(/\r\n?/g, '\n'));
      for (const { segment: char } of units) {
        if (char === '\n') { lines.push(line); line = ''; continue; }
        const width = measure(fontRuns(line + char, fonts), size, bold);
        if (!Number.isFinite(width) || width < 0) { error(field, 'measurement_failed'); return; }
        if (width > box.w * 0.9) {
          if (!line) { error(field); return; }
          // Prefer a Latin word boundary; only overlong words split by grapheme.
          const space = line.lastIndexOf(' ');
          if (space > 0 && /[A-Za-z0-9]$/.test(line) && /^[A-Za-z0-9]/.test(char)) {
            lines.push(line.slice(0, space + 1)); line = line.slice(space + 1) + char;
          } else { lines.push(line); line = char; }
          if (measure(fontRuns(char, fonts), size, bold) > box.w * 0.9) { error(field); return; }
        } else line += char;
      }
      lines.push(line);
      if (lines.length * lineHeight > box.h) { error(field); return; }
      lines.forEach((line, i) => objects.push({ kind: 'text', x: box.x - (bullet && i === 0 ? 18 : 0), y: box.y + i * lineHeight, w: box.w + (bullet && i === 0 ? 18 : 0), h: lineHeight,
        runs: fontRuns(line, fonts), size, bold, bullet: bullet && i === 0 }));
    };
    if (!['title', 'bullets', 'image-text'].includes(slide.layout)) {
      error('layout', 'unsupported_layout');
      return { id: slide.id, objects };
    }
    text(slide.title, { x: 48, y: slide.layout === 'title' ? 152 : 36, w: 864, h: 108 }, theme.type.titlePt, 'title', true);
    if (slide.layout === 'title' && slide.subtitle !== undefined)
      text(slide.subtitle, { x: 48, y: 284, w: 864, h: 150 }, theme.type.bodyPt, 'subtitle');
    if (slide.layout === 'bullets') {
      if (slide.bullets.length > 6) error('bullets');
      else slide.bullets.forEach((item, i) => {
        const height = 336 / slide.bullets.length;
        text(item, { x: 72, y: 156 + i * height, w: 840, h: height - 12 }, theme.type.bodyPt, `bullets/${i}`, false, true);
      });
    }
    if (slide.layout === 'image-text') {
      text(slide.body, { x: 48, y: 162, w: 384, h: 330 }, theme.type.bodyPt, 'body');
      objects.push({ kind: 'image', x: 468, y: 162, w: 444, h: 330, ...slide.image });
    }
    return { id: slide.id, notes: slide.notes, objects };
  });
  return diagnostics.length ? { ok: false, diagnostics } : { ok: true, value: slides, diagnostics: [] };
}
