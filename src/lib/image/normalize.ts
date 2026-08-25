/**
 * The one reader for a picture on its way to a model.
 *
 * What it exists to fix: a photo off a phone is 4000-odd pixels on its long
 * edge and can be tens of megabytes, and until now the app's only answer was
 * to refuse it — `AgentChat` and `RoleplayChat` both told the author their
 * attachment was too large and to pick another one, which is not a thing an
 * author can do. The picture they want to talk about is the picture they have.
 * So the size ceiling stops being a wall and becomes a target: shrink to meet
 * it, and only refuse when even that fails.
 *
 * ## What is deliberately *not* here
 *
 * Rendering. `imageToDataUrl` still returns exactly what is on disk, and every
 * preview, gallery tile and exported `<img>` still calls it — a downscaled
 * copy is wrong for a human looking at the pixels, and catastrophic for the
 * generation modal's save path, which reads bytes in order to write them back
 * out. The two readers are separate functions in separate modules because
 * telling them apart at a call site is the entire safety property.
 *
 * ## Shape of the work
 *
 * 1. **Read the header, not the image.** Most pictures already fit, and
 *    decoding a 12MP JPEG to discover that costs ~100ms and ~48MB per send —
 *    on paths that run per chat attachment and per `read_image` inside an
 *    agent loop. `imageSize.ts` answers from the first bytes of the file.
 * 2. **Decode once, encode repeatedly.** JPEG's output size can only be
 *    learned by encoding, so `downscalePlan.ts` plans one step at a time and
 *    this module measures each result and asks again.
 * 3. **Keep the best candidate.** A candidate that meets the limits always
 *    beats one that doesn't; between two of a kind, smaller wins. Without
 *    that, an 8000px screenshot that is *small* in bytes would "improve" its
 *    way back to the original, which was over on pixels.
 *
 * Anything unexpected — an undecodable file, no canvas, a `toBlob` that
 * returns nothing — falls back to the original bytes rather than throwing.
 * Failing to shrink must not become failing to send: the call site's own size
 * check is still there and is the right place to refuse.
 */

import {
  bytesToBase64,
  imageMimeFor,
  readImageBytes,
} from "../fs/images";
import { readImageHeader } from "./imageSize";
import {
  MAX_ENCODE_ATTEMPTS,
  type ImageLimits,
  type ImageState,
  imageLimits,
  planImageStep,
} from "./downscalePlan";

/** What a re-encode changed, for telling the author about it. */
export interface Downscaled {
  fromWidth: number;
  fromHeight: number;
  toWidth: number;
  toHeight: number;
  fromBytes: number;
  toBytes: number;
}

/** A picture, ready for the wire. Same shape as `imageToDataUrl` plus the note. */
export interface ModelImage {
  dataUrl: string;
  /** Extension implied by what is actually being sent, not by the source file. */
  ext: string;
  /** The payload itself — what a call site's size check must measure. */
  bytes: Uint8Array;
  /** Present only when the picture was re-encoded on the way out. */
  downscaled?: Downscaled;
}

/**
 * "4032×3024 → 2048×1536, 14.2MB → 1.1MB" — numbers only, no wording.
 *
 * Both callers need the same facts in different sentences (a chip tooltip in
 * the author's language, a tool result the model reads in English), so the
 * phrasing stays with them and the arithmetic stays here.
 */
export function downscaleNote(d: Downscaled): string {
  const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)}MB`;
  return `${d.fromWidth}×${d.fromHeight} → ${d.toWidth}×${d.toHeight}, ${mb(d.fromBytes)} → ${mb(d.toBytes)}`;
}

/**
 * Read an image file for a model, downscaling it first when it exceeds the
 * author's long-edge ceiling or the app's byte cap.
 */
export async function imageForModel(path: string): Promise<ModelImage> {
  const { bytes, ext } = await readImageBytes(path);
  const asIs = (): ModelImage => ({
    dataUrl: `data:${imageMimeFor(ext)};base64,${bytesToBase64(bytes)}`,
    ext,
    bytes,
  });

  const limits = imageLimits();
  const header = readImageHeader(bytes);

  if (header) {
    // Animated pictures land here too: `planImageStep` answers "as-is" for
    // them unconditionally, because a canvas would flatten them to one frame.
    const state = stateFor(header, bytes.length);
    if (planImageStep(state, limits, 0).kind === "as-is") return asIs();
  } else if (bytes.length <= limits.maxBytes) {
    // A format the header reader doesn't know, small enough not to care. Its
    // dimensions could be anything, but spending a decode on every send to
    // find out is exactly the cost the header reader exists to avoid.
    return asIs();
  }

  try {
    return await shrink(bytes, ext, header, limits);
  } catch {
    // See the module note: an unshrinkable picture is still a picture.
    return asIs();
  }
}

function stateFor(
  header: NonNullable<ReturnType<typeof readImageHeader>>,
  bytes: number,
): ImageState {
  return {
    width: header.width,
    height: header.height,
    bytes,
    mime: header.alpha ? "image/png" : "image/jpeg",
    animated: header.animated,
  };
}

/** One candidate payload. `blob === null` is the original file. */
interface Candidate {
  blob: Blob | null;
  bytes: number;
  width: number;
  height: number;
  ext: string;
}

function fits(c: Candidate, limits: ImageLimits): boolean {
  const withinEdge = limits.longEdge <= 0 || Math.max(c.width, c.height) <= limits.longEdge;
  return withinEdge && c.bytes <= limits.maxBytes;
}

async function shrink(
  original: Uint8Array<ArrayBuffer>,
  ext: string,
  header: ReturnType<typeof readImageHeader>,
  limits: ImageLimits,
): Promise<ModelImage> {
  const decoded = await decodeImage(original, imageMimeFor(ext));
  try {
    // The decoded dimensions win over the header's: with EXIF orientation
    // applied (which is the browser default), a rotated phone photo renders
    // transposed relative to what its header stores.
    const outMime: ImageState["mime"] =
      (header?.alpha ?? (ext !== "jpg" && ext !== "jpeg")) ? "image/png" : "image/jpeg";

    let best: Candidate = {
      blob: null,
      bytes: original.length,
      width: decoded.width,
      height: decoded.height,
      ext,
    };
    let state: ImageState = {
      width: decoded.width,
      height: decoded.height,
      bytes: original.length,
      mime: outMime,
      animated: header?.animated ?? false,
    };

    for (let attempt = 0; attempt < MAX_ENCODE_ATTEMPTS; attempt++) {
      const step = planImageStep(state, limits, attempt);
      if (step.kind !== "encode") break;
      const blob = await encodeCanvas(decoded.src, step.width, step.height, step.mime, step.quality);
      const candidate: Candidate = {
        blob,
        bytes: blob.size,
        width: step.width,
        height: step.height,
        ext: step.mime === "image/png" ? "png" : "jpg",
      };
      // Meeting the limits beats being small — an oversized-but-light
      // screenshot would otherwise keep its original as "best" forever.
      const better = fits(candidate, limits) !== fits(best, limits)
        ? fits(candidate, limits)
        : candidate.bytes < best.bytes;
      if (better) best = candidate;
      state = { ...state, width: step.width, height: step.height, bytes: candidate.bytes };
    }

    if (!best.blob) {
      return {
        dataUrl: `data:${imageMimeFor(ext)};base64,${bytesToBase64(original)}`,
        ext,
        bytes: original,
      };
    }
    const outBytes = new Uint8Array(await best.blob.arrayBuffer());
    return {
      dataUrl: `data:${best.blob.type || imageMimeFor(best.ext)};base64,${bytesToBase64(outBytes)}`,
      ext: best.ext,
      bytes: outBytes,
      downscaled: {
        fromWidth: decoded.width,
        fromHeight: decoded.height,
        toWidth: best.width,
        toHeight: best.height,
        fromBytes: original.length,
        toBytes: outBytes.length,
      },
    };
  } finally {
    decoded.release();
  }
}

interface DecodedImage {
  src: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
}

/**
 * Decode bytes into something `drawImage` accepts.
 *
 * `<img>` + `decode()` rather than `createImageBitmap`, for one reason that
 * matters more than the ergonomics: **EXIF orientation**. A portrait photo off
 * a phone is stored landscape with a rotation tag, and an `<img>` applies it
 * by default (`image-orientation: from-image` has been the initial value for
 * years) — `naturalWidth`/`naturalHeight` then report the corrected size.
 * `createImageBitmap`'s `imageOrientation` option is a dictionary member,
 * which an engine that doesn't implement it *ignores* rather than rejecting,
 * so getting it wrong there produces a silently sideways picture that the
 * model then describes in earnest. This is also the path
 * `imageToThumbnailDataUrl` already takes, and its comment there defends the
 * classic-canvas route against WebView2's quirks.
 */
async function decodeImage(bytes: Uint8Array<ArrayBuffer>, mime: string): Promise<DecodedImage> {
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
  return {
    src: img,
    width: img.naturalWidth,
    height: img.naturalHeight,
    release: () => URL.revokeObjectURL(url),
  };
}

async function encodeCanvas(
  src: CanvasImageSource,
  width: number,
  height: number,
  mime: string,
  quality?: number,
): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable");
  // JPEG has no alpha channel, and an unpainted canvas is transparent black —
  // so anything transparent would come out *black* rather than merely flat.
  // The plan only chooses JPEG for sources with no transparency, but the fill
  // costs nothing and makes that a preference rather than a load-bearing
  // assumption.
  if (mime === "image/jpeg") {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
  }
  ctx.drawImage(src, 0, 0, width, height);
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("canvas.toBlob produced nothing"))),
      mime,
      quality,
    );
  });
}
