import { DECK_LIMITS } from './model';

/** Inspect dimensions before asking the browser to allocate decoded pixels. */
export function imageHeader(bytes: Uint8Array): { width: number; height: number; mime: 'image/png' | 'image/jpeg' } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0, height = 0;
  let mime: 'image/png' | 'image/jpeg';
  if (bytes.length >= 24 && [137,80,78,71,13,10,26,10].every((n, i) => bytes[i] === n) &&
    view.getUint32(8) === 13 && view.getUint32(12) === 0x49484452) {
    mime = 'image/png'; width = view.getUint32(16); height = view.getUint32(20);
  } else if (bytes[0] === 255 && bytes[1] === 216) {
    mime = 'image/jpeg';
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 255) throw new Error('invalid_image');
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) break;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) throw new Error('invalid_image');
      // Office and browsers do not consistently apply EXIF transforms alike.
      if (marker === 0xe1 && length >= 16 && view.getUint32(offset + 2) === 0x45786966 && view.getUint16(offset + 6) === 0) {
        const tiff = offset + 8, end = offset + length;
        const order = view.getUint16(tiff);
        if (order !== 0x4949 && order !== 0x4d4d) throw new Error('invalid_image');
        const little = order === 0x4949;
        if (view.getUint16(tiff + 2, little) !== 42) throw new Error('invalid_image');
        const directory = tiff + view.getUint32(tiff + 4, little);
        if (directory < tiff + 8 || directory + 2 > end) throw new Error('invalid_image');
        const count = view.getUint16(directory, little);
        if (directory + 2 + count * 12 > end) throw new Error('invalid_image');
        for (let entry = directory + 2; entry < directory + 2 + count * 12; entry += 12) {
          if (view.getUint16(entry, little) === 0x0112 &&
            (view.getUint16(entry + 2, little) !== 3 || view.getUint32(entry + 4, little) !== 1 || view.getUint16(entry + 8, little) !== 1))
            throw new Error('invalid_image');
        }
      }
      if ([0xc0,0xc1,0xc2].includes(marker) && length >= 8) {
        height = view.getUint16(offset + 3); width = view.getUint16(offset + 5);
      }
      offset += length;
    }
  } else throw new Error('invalid_image');
  if (!width || !height) throw new Error('invalid_image');
  if (width * height > DECK_LIMITS.imagePixels) throw new Error('image_limit');
  return { width, height, mime };
}
