import { DECK_LIMITS as L, type DeckSpec } from "./model";
import type { DeckDiagnostic } from "./diagnostics";

/** Loader observations, never model-authored declarations. Decode remains P2's job. */
export interface ImageResourceInfo {
  assetId: string;
  byteLength: number;
  width: number;
  height: number;
  mime: "image/png" | "image/jpeg";
}

/** The caller must first validate the spec, then supply observations for every asset. */
export function validateImageResources(spec: DeckSpec, images: readonly ImageResourceInfo[]): DeckDiagnostic[] {
  const diagnostics: DeckDiagnostic[] = [];
  let total = 0;
  const positiveInteger = (n: number) => Number.isSafeInteger(n) && n > 0;
  for (const [i, asset] of spec.assets.entries()) {
    const path = `/assets/${i}`;
    const matches = images.filter(image => image.assetId === asset.id);
    if (matches.length !== 1) {
      diagnostics.push({ code: matches.length ? "duplicate_id" : "missing_asset", path });
      continue;
    }
    const image = matches[0];
    if (!positiveInteger(image.byteLength) || !positiveInteger(image.width) || !positiveInteger(image.height) ||
      !["image/png", "image/jpeg"].includes(image.mime)) {
      diagnostics.push({ code: "invalid_image", path });
      continue;
    }
    total += image.byteLength;
    if (image.byteLength > L.imageBytes || image.width * image.height > L.imagePixels)
      diagnostics.push({ code: "image_limit", path });
  }
  if (total > L.totalImageBytes) diagnostics.push({ code: "image_limit", path: "/assets" });
  for (const image of images) {
    if (!spec.assets.some(asset => asset.id === image.assetId)) diagnostics.push({ code: "invalid_image", path: "/assets" });
  }
  return diagnostics;
}
