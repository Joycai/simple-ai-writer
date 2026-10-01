import type { DeckSpec } from './model';
import type { DeckTheme } from './theme';
import type { DeckDiagnostic, DeckValidation } from './diagnostics';

export interface TextRun { text: string; fontFace: string }
export interface FontSelection { latin: string; cjk: string }
interface TableCell { lines: TextRun[][] }
interface Box { x: number; y: number; w: number; h: number }
type NativeObject =
  | (Box & { kind: 'text'; runs: TextRun[]; size: number; bold: boolean; bullet: boolean })
  | (Box & { kind: 'rule' })
  | (Box & { kind: 'table'; cells: TableCell[][]; rowHeights: number[]; columnWidths: number[]; size: number; padding: number })
  | (Box & { kind: 'image'; assetId: string; alt: string; fit: 'cover' | 'contain'; anchor: { x: number; y: number } });
export interface NativeSlide { id: string; notes?: string; objects: NativeObject[] }
export type MeasureText = (runs: readonly TextRun[], size: number, bold: boolean) => number;

/** PptxGenJS emits one face for Latin/EA/CS per run, so split scripts explicitly. */
export function fontRuns(text: string, fonts: FontSelection): TextRun[] {
  const runs: TextRun[] = [];
  for (const char of text) {
    const last = runs[runs.length - 1];
    // Neutral separators belong to the preceding script, avoiding a font switch on punctuation.
    const cjk = /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef\u{20000}-\u{3134f}]/u.test(char);
    const neutral = /^[\p{P}\p{Z}\s]$/u.test(char);
    const face = cjk ? fonts.cjk : neutral && last ? last.fontFace : fonts.latin;
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
    const wrap = (value: string, box: Box, size: number, field: string, bold: boolean): string[] | undefined => {
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
      return lines;
    };
    const text = (value: string, box: Box, size: number, field: string, bold = false, bullet = false) => {
      const lines = wrap(value, box, size, field, bold);
      const lineHeight = size * 1.4;
      lines?.forEach((line, i) => objects.push({ kind: 'text', x: box.x - (bullet && i === 0 ? 18 : 0), y: box.y + i * lineHeight, w: box.w + (bullet && i === 0 ? 18 : 0), h: lineHeight,
        runs: fontRuns(line, fonts), size, bold, bullet: bullet && i === 0 }));
    };
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
    if (slide.layout === 'comparison') {
      objects.push({ kind: 'rule', x: 479, y: 162, w: 2, h: 330 });
      for (const side of ['left', 'right'] as const) {
        const column = slide[side], x = side === 'left' ? 48 : 504;
        text(column.heading, { x, y: 162, w: 408, h: 68 }, theme.type.bodyPt, `${side}/heading`, true);
        if (column.bullets.length > 4) error(`${side}/bullets`);
        else column.bullets.forEach((item, i) => {
          const height = 252 / column.bullets.length;
          text(item, { x: x + 24, y: 240 + i * height, w: 384, h: height - 12 }, theme.type.bodyPt, `${side}/bullets/${i}`, false, true);
        });
      }
    }
    if (slide.layout === 'metrics') {
      const columns = Math.min(3, slide.metrics.length), rows = Math.ceil(slide.metrics.length / columns);
      const width = (864 - (columns - 1) * 24) / columns, height = rows === 1 ? 330 : 153;
      slide.metrics.forEach((metric, i) => {
        const x = 48 + (i % columns) * (width + 24), y = 162 + Math.floor(i / columns) * 177;
        objects.push({ kind: 'rule', x, y, w: width, h: 2 });
        text(metric.value, { x, y: y + 10, w: width, h: 51 }, theme.type.titlePt, `metrics/${i}/value`, true);
        text(metric.label, { x, y: y + 65, w: width, h: 34 }, theme.type.bodyPt, `metrics/${i}/label`, true);
        if (metric.detail !== undefined)
          text(metric.detail, { x, y: y + 105, w: width, h: height - 105 }, theme.type.minimumPt, `metrics/${i}/detail`);
      });
    }
    if (slide.layout === 'table') {
      // Capacity is deliberately below schema safety limits. No implicit extra slides.
      if (slide.columns.length > 6) error('columns');
      else if (slide.rows.length > 7) error('rows');
      else {
        const size = theme.type.minimumPt, padding = 8, width = 864 / slide.columns.length;
        const rowHeights: number[] = [];
        const cells = [slide.columns, ...slide.rows].map((row, r) => {
          let maxLines = 1;
          const cells = row.map((value, c) => {
            const field = r === 0 ? `columns/${c}` : `rows/${r - 1}/${c}`;
            const lines = wrap(value, { x: 0, y: 0, w: width - padding * 2, h: 314 }, size, field, r === 0);
            maxLines = Math.max(maxLines, lines?.length ?? 1);
            return { lines: (lines ?? []).map(line => fontRuns(line, fonts)) };
          });
          rowHeights.push(maxLines * size * 1.4 + padding * 2);
          return cells;
        });
        const height = rowHeights.reduce((sum, h) => sum + h, 0);
        if (height > 330) error('rows');
        else objects.push({ kind: 'table', x: 48, y: 162, w: 864, h: height, cells, rowHeights,
          columnWidths: slide.columns.map(() => width), size, padding });
      }
    }
    return { id: slide.id, notes: slide.notes, objects };
  });
  return diagnostics.length ? { ok: false, diagnostics } : { ok: true, value: slides, diagnostics: [] };
}
