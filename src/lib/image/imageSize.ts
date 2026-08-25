/**
 * A picture's dimensions, read out of its file header instead of decoding it.
 *
 * `normalize.ts` has to answer one question about every image on its way to a
 * model — "is this already small enough?" — and for the overwhelming majority
 * the answer is yes. Decoding a 12MP photo to find that out costs ~100ms and
 * ~48MB of bitmap for nothing, on paths that run per chat attachment and per
 * `read_image` call inside an agent loop. Four fixed-layout headers answer it
 * for free.
 *
 * Two deliberate limits:
 *
 * - **Unknown format → `null`**, and the caller decodes. This is a fast path,
 *   not an authority: anything it cannot parse it must not guess about.
 * - **Dimensions are the stored ones, before EXIF rotation.** A portrait
 *   iPhone photo stores 4032×3024 with an Orientation tag, and the `<img>`
 *   decode `normalize.ts` uses reports the rotated 3024×4032. That difference
 *   never changes the *long edge*, which is the only thing decided here — but
 *   it does mean nothing else may treat these numbers as the display size.
 *
 * `alpha` is likewise a *possibility*, not a measurement: it decides whether a
 * re-encode may go to JPEG (which has no alpha channel) and errs toward "yes,
 * keep PNG", because the cost of being wrong the other way is a picture whose
 * transparent regions come out black.
 */

export interface ImageHeader {
  /** Stored pixel width — see the note above about EXIF rotation. */
  width: number;
  height: number;
  /** True when re-encoding through a canvas would flatten it to one frame. */
  animated: boolean;
  /** True when the format *may* carry transparency. Conservative. */
  alpha: boolean;
}

/** Big-endian u16/u32 readers — every header here is one or the other. */
const be16 = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const be32 = (b: Uint8Array, i: number) =>
  ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const le16 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);

/** ASCII tag comparison, for the four magic numbers below. */
function tagAt(b: Uint8Array, i: number, tag: string): boolean {
  if (i + tag.length > b.length) return false;
  for (let k = 0; k < tag.length; k++) if (b[i + k] !== tag.charCodeAt(k)) return false;
  return true;
}

/**
 * Read width/height/alpha/animated from the first bytes of an image file, or
 * null when the format isn't one of the four this app accepts.
 */
export function readImageHeader(bytes: Uint8Array): ImageHeader | null {
  return readPng(bytes) ?? readGif(bytes) ?? readWebp(bytes) ?? readJpeg(bytes);
}

function readPng(b: Uint8Array): ImageHeader | null {
  // Signature, then IHDR: length+type occupy 8..15, width at 16, height at 20,
  // bit depth at 24, colour type at 25.
  if (b.length < 26) return null;
  if (!(b[0] === 0x89 && tagAt(b, 1, "PNG") && b[4] === 0x0d && b[5] === 0x0a)) return null;
  if (!tagAt(b, 12, "IHDR")) return null;
  const colorType = b[25];
  return {
    width: be32(b, 16),
    height: be32(b, 20),
    // APNG is a PNG with an `acTL` chunk before the first frame. Not scanned
    // for: the chunk can sit anywhere in the file, and treating a still PNG as
    // animated only costs it a re-encode it may not have needed.
    animated: false,
    // 4 = grey+alpha, 6 = RGB+alpha, 3 = palette (which may carry a tRNS
    // chunk we deliberately don't go looking for).
    alpha: colorType === 4 || colorType === 6 || colorType === 3,
  };
}

function readGif(b: Uint8Array): ImageHeader | null {
  if (b.length < 10) return null;
  if (!tagAt(b, 0, "GIF8")) return null;
  return {
    width: le16(b, 6),
    height: le16(b, 8),
    // Every GIF is treated as animated. Finding out otherwise means walking
    // the block chain, and the only thing the answer buys is permission to
    // re-encode a picture that is small by construction anyway.
    animated: true,
    alpha: true,
  };
}

function readWebp(b: Uint8Array): ImageHeader | null {
  if (b.length < 30) return null;
  if (!(tagAt(b, 0, "RIFF") && tagAt(b, 8, "WEBP"))) return null;

  // Extended form: 24-bit little-endian canvas size minus one, plus the flag
  // byte that is the only place "animated" is stated outright.
  if (tagAt(b, 12, "VP8X")) {
    const flags = b[20];
    const w = (b[24] | (b[25] << 8) | (b[26] << 16)) + 1;
    const h = (b[27] | (b[28] << 8) | (b[29] << 16)) + 1;
    return { width: w, height: h, animated: (flags & 0x02) !== 0, alpha: (flags & 0x10) !== 0 };
  }
  // Lossy: 14-bit dimensions after the 3-byte start code at 23..25.
  if (tagAt(b, 12, "VP8 ")) {
    if (!(b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a)) return null;
    return {
      width: le16(b, 26) & 0x3fff,
      height: le16(b, 28) & 0x3fff,
      animated: false,
      alpha: false, // a bare VP8 chunk has no alpha channel at all
    };
  }
  // Lossless: 1-byte signature then two 14-bit fields packed across 4 bytes,
  // little-endian, followed by the alpha-used bit.
  if (tagAt(b, 12, "VP8L")) {
    if (b[20] !== 0x2f) return null;
    const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1,
      animated: false,
      alpha: ((bits >>> 28) & 0x01) !== 0,
    };
  }
  return null;
}

function readJpeg(b: Uint8Array): ImageHeader | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  // Walk the marker chain to the frame header. Segments carry their own
  // length, so this never scans entropy-coded data.
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) return null;
    let marker = b[i + 1];
    // Fill bytes: any run of 0xFF before a marker is padding.
    while (marker === 0xff && i + 2 < b.length) marker = b[++i + 1];
    // Standalone markers (no length field): RSTn, SOI, EOI, TEM.
    if ((marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) { i += 2; continue; }
    const len = be16(b, i + 2);
    if (len < 2) return null;
    // SOF0..SOF15, minus the four that are not frame headers (DHT C4, JPG C8,
    // DAC CC). Height precedes width, both u16, after the 1-byte precision.
    const isSof =
      marker >= 0xc0 && marker <= 0xcf &&
      marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (i + 9 > b.length) return null;
      return { width: be16(b, i + 7), height: be16(b, i + 5), animated: false, alpha: false };
    }
    // Start of scan — past here is compressed data, and there is no frame
    // header to find that we haven't already passed.
    if (marker === 0xda) return null;
    i += 2 + len;
  }
  return null;
}
