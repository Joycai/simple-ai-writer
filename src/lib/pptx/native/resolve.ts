import { DECK_LIMITS } from './model';
import { validateDeckSpec } from './validate';
import { DECK_THEMES, type DeckTheme } from './theme';
import { layoutDeck, type FontSelection, type MeasureText, type NativeSlide } from './layout';
import type { DeckDiagnostic, DeckValidation } from './diagnostics';
import { validateImageResources, type ImageResourceInfo } from './resources';

export interface ResolvedImage extends ImageResourceInfo { data: string }
export interface ResolvedDeck {
  theme: DeckTheme;
  language: 'en-US' | 'zh-CN';
  fonts: FontSelection;
  slides: NativeSlide[];
  images: ResolvedImage[];
  /** Always shown by future consumers; local measurement is not Office validation. */
  risks: readonly ['office_metrics_unverified', 'recipient_fonts_required'];
}
export interface ResolveEnvironment {
  hasFont(face: string): Promise<boolean>;
  measure: MeasureText;
  /** Trusted loader: bounded local reads, actual format/pixel checks and decode. */
  loadImage(path: string, assetId: string, remainingBytes: number): Promise<ResolvedImage>;
}

export async function resolveDeck(input: unknown, env: ResolveEnvironment): Promise<DeckValidation<ResolvedDeck>> {
  const checked = validateDeckSpec(input);
  if (!checked.ok) return checked;
  // Own the source across awaits; later approval caching is a separate boundary.
  const spec = JSON.parse(JSON.stringify(checked.value)) as typeof checked.value;
  const theme = DECK_THEMES[spec.theme];
  const diagnostics: DeckDiagnostic[] = [];
  const choose = async (candidates: readonly string[]) => {
    for (const face of candidates) if (await env.hasFont(face)) return face;
    return '';
  };
  const fonts = { latin: await choose(theme.fonts.latin), cjk: await choose(theme.fonts.cjk) };
  if (!fonts.latin || !fonts.cjk) return { ok: false, diagnostics: [{ code: 'missing_font', path: '/theme' }] };
  const layout = layoutDeck(spec, theme, fonts, env.measure);
  if (!layout.ok) return layout;
  const images: ResolvedImage[] = [];
  let remaining: number = DECK_LIMITS.totalImageBytes;
  for (const [index, asset] of spec.assets.entries()) {
    try {
      const image = await env.loadImage(asset.path, asset.id, remaining);
      images.push(image); remaining -= image.byteLength;
    } catch (error) {
      diagnostics.push({ code: error instanceof Error && error.message === 'image_limit' ? 'image_limit' : 'invalid_image', path: `/assets/${index}` });
    }
  }
  if (diagnostics.length) return { ok: false, diagnostics };
  diagnostics.push(...validateImageResources(spec, images));
  if (diagnostics.length) return { ok: false, diagnostics };
  const value: ResolvedDeck = { theme, language: spec.language, fonts, slides: layout.value, images,
    risks: ['office_metrics_unverified', 'recipient_fonts_required'] };
  // Strings hold media bytes so the entire resolved graph can be deeply frozen.
  const freeze = (object: object): void => { Object.values(object).forEach(v => { if (v && typeof v === 'object') freeze(v); }); Object.freeze(object); };
  freeze(value);
  return { ok: true, value, diagnostics: [] };
}
