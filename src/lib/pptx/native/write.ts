import type { ResolvedDeck } from './resolve';
import { normalizeParagraphs } from './paragraphs';

/** Native objects only; inches exist solely at this library boundary. */
export async function nativeDeckToPptx(deck: ResolvedDeck): Promise<Uint8Array> {
  const { default: PptxGenJS } = await import('pptxgenjs');
  const pres = new PptxGenJS();
  pres.defineLayout({ name: 'NATIVE', width: deck.theme.canvas.widthPt / 72, height: deck.theme.canvas.heightPt / 72 });
  pres.layout = 'NATIVE';
  pres.theme = { headFontFace: deck.fonts.latin, bodyFontFace: deck.fonts.latin };
  for (const source of deck.slides) {
    const slide = pres.addSlide();
    slide.background = { color: deck.theme.colors.background };
    if (source.notes !== undefined) slide.addNotes(source.notes);
    // An editable theme accent, deliberately independent of text bounds.
    slide.addShape('rect', { x: 48 / 72, y: 24 / 72, w: 48 / 72, h: 3 / 72,
      line: { transparency: 100 }, fill: { color: deck.theme.colors.accent } });
    for (const object of source.objects) {
      const box = { x: object.x / 72, y: object.y / 72, w: object.w / 72, h: object.h / 72 };
      if (object.kind === 'text') {
        slide.addText(object.runs.map(run => ({ text: run.text, options: { fontFace: run.fontFace, lang: run.fontFace === deck.fonts.latin ? 'en-US' : deck.language } })), {
          ...box, fontFace: deck.fonts.latin, fontSize: object.size, bold: object.bold,
          color: deck.theme.colors.text, lang: deck.language, margin: 0, valign: 'top',
          breakLine: false, wrap: false, fit: 'none', paraSpaceAfter: 0,
          ...(object.bullet ? { bullet: { indent: 18 }, hanging: 5 } : {}),
        });
      } else if (object.kind === 'rule') {
        slide.addShape('rect', { ...box, line: { transparency: 100 }, fill: { color: deck.theme.colors.accent } });
      } else if (object.kind === 'table') {
        slide.addTable(object.cells.map((row, r) => row.map(cell => ({
          // Explicit paragraph boundaries avoid PptxGenJS splitting a bilingual run's newline incorrectly.
          text: cell.lines.flatMap(line => {
            const runs = line.length ? line : [{ text: '', fontFace: deck.fonts.latin }];
            return runs.map((run, i) => ({ text: run.text, options: { fontFace: run.fontFace, lang: run.fontFace === deck.fonts.latin ? 'en-US' : deck.language,
              breakLine: i === runs.length - 1, lineSpacing: object.size * 1.4, paraSpaceAfter: 0 } }));
          }),
          options: { bold: r === 0, color: r === 0 ? deck.theme.colors.background : deck.theme.colors.text,
            fill: { color: r === 0 ? deck.theme.colors.accent : deck.theme.colors.background } },
        }))), {
          ...box, colW: object.columnWidths.map(w => w / 72), rowH: object.rowHeights.map(h => h / 72),
          fontFace: deck.fonts.latin, fontSize: object.size, lang: deck.language,
          margin: object.padding / 72, valign: 'top',
          border: { color: deck.theme.colors.accent, pt: 0.5 }, autoPage: false,
        });
      } else {
        const image = deck.images.find(image => image.assetId === object.assetId);
        if (!image) throw new Error('Missing resolved image');
        const scale = object.fit === 'cover' ? Math.max(box.w / image.width, box.h / image.height) : Math.min(box.w / image.width, box.h / image.height);
        const w = image.width * scale, h = image.height * scale;
        slide.addImage(object.fit === 'contain'
          ? { data: image.data, altText: object.alt, x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h }
          : { data: image.data, altText: object.alt, x: box.x, y: box.y, w, h,
            sizing: { type: 'crop', w: box.w, h: box.h, x: (w - box.w) * object.anchor.x, y: (h - box.h) * object.anchor.y } });
      }
    }
  }
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(await pres.write({ outputType: 'uint8array' }) as Uint8Array);
  for (const entry of Object.values(zip.files)) {
    if (/^ppt\/slides\/slide\d+\.xml$/.test(entry.name))
      zip.file(entry.name, normalizeParagraphs(await entry.async('string')));
  }
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
