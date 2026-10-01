import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { imageHeader } from '../imageHeader';
it('reads real PNG dimensions and rejects corrupt and excessive headers before decode', () => {
  const image = new Uint8Array(readFileSync('public/logo.png'));
  expect(imageHeader(image).mime).toBe('image/png');
  expect(() => imageHeader(new Uint8Array([1,2,3]))).toThrow('invalid_image');
  new DataView(image.buffer).setUint32(16, 100000);
  expect(() => imageHeader(image)).toThrow('image_limit');
});
it('reads baseline/progressive JPEG SOF and rejects truncated segments', () => {
  const image = new Uint8Array([255,216,255,194,0,11,8,0,100,0,200,1,1,17,0]);
  expect(imageHeader(image)).toEqual({ width: 200, height: 100, mime: 'image/jpeg' });
  expect(() => imageHeader(image.slice(0,10))).toThrow('invalid_image');
});
it('rejects EXIF rotations even when dimensions would remain unchanged', () => {
  const bytes = new Uint8Array([255,216,255,225,0,32,69,120,105,102,0,0,73,73,42,0,8,0,0,0,1,0,18,1,3,0,1,0,0,0,3,0,0,0,0,0,
    255,192,0,11,8,0,100,0,200,1,1,17,0]);
  expect(() => imageHeader(bytes)).toThrow('invalid_image');
  bytes[30] = 1;
  expect(imageHeader(bytes).width).toBe(200);
});
