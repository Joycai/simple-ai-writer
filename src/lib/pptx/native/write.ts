import type { ResolvedDeck } from './resolve';

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
        slide.addText(object.runs.map(run => ({ text: run.text, options: { fontFace: run.fontFace } })), {
          ...box, fontFace: deck.fonts.latin, fontSize: object.size, bold: object.bold,
          color: deck.theme.colors.text, lang: deck.language, margin: 0, valign: 'top',
          breakLine: false, wrap: false, fit: 'none', paraSpaceAfter: 0,
          ...(object.bullet ? { bullet: { indent: 18 }, hanging: 5 } : {}),
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
  return await pres.write({ outputType: 'uint8array' }) as Uint8Array;
}
