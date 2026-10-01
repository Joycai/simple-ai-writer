/**
 * PptxGenJS 4.0.1 emits a:pPr before every rich-text run. DrawingML permits
 * one at the start of a paragraph. Our paragraph style belongs to the first
 * run (including bullets); later script/font runs must not redefine it.
 * This only handles trusted serializer output, never arbitrary input XML.
 */
export function normalizeParagraphs(xml: string): string {
  return xml.replace(/<a:p>([\s\S]*?)<\/a:p>/g, (_, body: string) => {
    let first = true;
    return `<a:p>${body.replace(/<a:pPr\b[^>]*(?:\/>|>[\s\S]*?<\/a:pPr>)/g, properties => {
      if (!first) return '';
      first = false;
      return properties;
    })}</a:p>`;
  });
}
