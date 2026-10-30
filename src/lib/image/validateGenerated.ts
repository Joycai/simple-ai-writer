/** Check delivered bytes before a successful result can reach the gallery. */
import { readImageHeader } from "./imageSize";
import type { GeneratedImage } from "../ai/image";

export async function validateGeneratedImage(image: GeneratedImage): Promise<GeneratedImage> {
  const match = /^data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/\s]*={0,2})$/i.exec(image.dataUrl);
  if (!match) throw new Error("Invalid generated image data URL");
  let bytes: Uint8Array;
  try { bytes = Uint8Array.from(atob(match[1]), c => c.charCodeAt(0)); }
  catch { throw new Error("Invalid generated image base64"); }
  const header = readImageHeader(bytes);
  if (!header || header.width < 1 || header.height < 1 || header.width * header.height > 100_000_000) {
    throw new Error("Generated image has invalid or unsupported dimensions");
  }
  // Header parsing rejects non-images cheaply; browser decoding also catches
  // truncated/corrupt pixel streams. Node tests exercise the header gate.
  if (typeof Image !== "undefined") {
    const decoded = new Image();
    decoded.src = image.dataUrl;
    await decoded.decode();
    if (!decoded.naturalWidth || !decoded.naturalHeight) throw new Error("Generated image could not be decoded");
  }
  return image;
}
