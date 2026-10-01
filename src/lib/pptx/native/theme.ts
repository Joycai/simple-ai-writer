/** All geometry and typography in the native pipeline uses points (72 pt/in). */
export interface DeckTheme {
  readonly canvas: { readonly widthPt: number; readonly heightPt: number };
  readonly colors: { readonly background: string; readonly text: string; readonly accent: string };
  readonly fonts: {
    readonly latin: readonly string[];
    readonly cjk: readonly string[];
    readonly onMissing: "error";
  };
  readonly type: { readonly titlePt: number; readonly bodyPt: number; readonly minimumPt: number };
}

export type ThemeId = "paper" | "midnight";

// Candidate order is explicit; these are requirements, not detected installed fonts.
const fonts = Object.freeze({
  latin: Object.freeze(["Arial", "Aptos"]),
  cjk: Object.freeze(["PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC"]),
  onMissing: "error" as const,
});
const canvas = Object.freeze({ widthPt: 960, heightPt: 540 });
const type = Object.freeze({ titlePt: 36, bodyPt: 24, minimumPt: 18 });
export const DECK_THEMES: Readonly<Record<ThemeId, DeckTheme>> = Object.freeze({
  paper: Object.freeze({ canvas, fonts, type,
    colors: Object.freeze({ background: "FFFFFF", text: "172B4D", accent: "1565C0" }) }),
  midnight: Object.freeze({ canvas, fonts, type,
    colors: Object.freeze({ background: "142033", text: "F8FAFC", accent: "78BEFF" }) }),
});
