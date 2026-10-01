import type { ResolvedDeck } from '../../lib/pptx/native/resolve';
import type { TextRun } from '../../lib/pptx/native/layout';

/** Geometry and line breaks come exclusively from the export resolver. SVG is an approximate viewer. */
export function NativeSlideView({ deck, index }: { deck: ResolvedDeck; index: number }) {
  const slide = deck.slides[index];
  const colors = deck.theme.colors;
  const runs = (items: TextRun[]) => items.map((run, i) => <tspan key={i} fontFamily={run.fontFace}>{run.text}</tspan>);
  return <svg viewBox={`0 0 ${deck.theme.canvas.widthPt} ${deck.theme.canvas.heightPt}`} role="img" aria-label={slide.id} style={{ width: '100%', display: 'block', background: `#${colors.background}` }}>
    <rect x={48} y={24} width={48} height={3} fill={`#${colors.accent}`} />
    {slide.objects.map((object, i) => {
      if (object.kind === 'rule') return <rect key={i} x={object.x} y={object.y} width={object.w} height={object.h} fill={`#${colors.accent}`} />;
      if (object.kind === 'text') return <text key={i} x={object.x} y={object.y} dominantBaseline="text-before-edge" fontSize={object.size} fontWeight={object.bold ? 'bold' : 'normal'} fill={`#${colors.text}`} xmlSpace="preserve">
        {object.bullet && <tspan fontFamily={deck.fonts.latin}>• </tspan>}{runs(object.runs)}
      </text>;
      if (object.kind === 'image') {
        const image = deck.images.find(image => image.assetId === object.assetId)!;
        const scale = object.fit === 'cover' ? Math.max(object.w / image.width, object.h / image.height) : Math.min(object.w / image.width, object.h / image.height);
        const w = image.width * scale, h = image.height * scale;
        return <svg key={i} x={object.x} y={object.y} width={object.w} height={object.h} overflow="hidden">
          <image href={image.data} aria-label={object.alt} x={(object.w - w) * (object.fit === 'contain' ? 0.5 : object.anchor.x)} y={(object.h - h) * (object.fit === 'contain' ? 0.5 : object.anchor.y)} width={w} height={h} />
        </svg>;
      }
      let y = object.y;
      return <g key={i}>{object.cells.map((row, r) => {
        const top = y; y += object.rowHeights[r]; let x = object.x;
        return <g key={r}>{row.map((cell, c) => {
          const left = x; x += object.columnWidths[c];
          return <g key={c}>
            <rect x={left} y={top} width={object.columnWidths[c]} height={object.rowHeights[r]} fill={`#${r === 0 ? colors.accent : colors.background}`} stroke={`#${colors.accent}`} strokeWidth={0.5} />
            {cell.lines.map((line, l) => <text key={l} x={left + object.padding} y={top + object.padding + l * object.size * 1.4} dominantBaseline="text-before-edge" fontSize={object.size} fontWeight={r === 0 ? 'bold' : 'normal'} fill={`#${r === 0 ? colors.background : colors.text}`} xmlSpace="preserve">{runs(line)}</text>)}
          </g>;
        })}</g>;
      })}</g>;
    })}
  </svg>;
}
