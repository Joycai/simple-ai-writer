import type { ThemeId } from "./theme";

/** Semantic source only. Geometry belongs to the later layout compiler. */
export interface DeckSpec {
  version: 1;
  language: "en-US" | "zh-CN";
  theme: ThemeId;
  assets: ImageAsset[];
  slides: SlideSpec[];
}

interface ImageAsset {
  id: string;
  /** Canonical project-relative path; resolved through the existing FS scope. */
  path: string;
}

interface SlideBase {
  id: string;
  title: string;
  notes?: string;
}
interface Column {
  heading: string;
  bullets: string[];
}

type SlideSpec = SlideBase & (
  | { layout: "title"; subtitle?: string }
  | { layout: "bullets"; bullets: string[] }
  | { layout: "comparison"; left: Column; right: Column }
  | { layout: "image-text"; body: string; image: {
      assetId: string;
      alt: string;
      fit: "contain" | "cover";
      /** Normalized crop alignment: 0 = left/top, 1 = right/bottom. */
      anchor: { x: number; y: number };
    } }
  | { layout: "metrics"; metrics: { label: string; value: string; detail?: string }[] }
  | { layout: "table"; columns: string[]; rows: string[][] }
);

/** Input safety ceilings, not promises that this content fits on a slide. */
export const DECK_LIMITS = Object.freeze({
  sourceBytes: 2 * 1024 * 1024,
  slides: 100,
  assets: 100,
  title: 300,
  text: 4000,
  notes: 20000,
  bullets: 20,
  metrics: 6,
  columns: 12,
  rows: 100,
  imageBytes: 10 * 1024 * 1024,
  totalImageBytes: 50 * 1024 * 1024,
  imagePixels: 40_000_000,
});
