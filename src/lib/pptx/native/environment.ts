import { readFileHead, readFileRange, toBase64 } from '../../fs/fileio';
import { DECK_LIMITS } from './model';
import { imageHeader } from './imageHeader';
import type { ResolveEnvironment } from './resolve';

/** Tauri's existing scoped, bounded reads also canonicalize symlink targets. */
export function nativeEnvironment(projectRoot: string): ResolveEnvironment {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas unavailable');
  return {
    async hasFont(face) {
      await document.fonts.ready;
      // fonts.check alone returns true for absent families with fallback glyphs.
      const sample = face === 'Arial' || face === 'Aptos' ? 'Wim0123456789' : 'Wim0123456789 原生演示中文字体';
      return ['monospace', 'serif'].some(fallback => {
        context.font = `72px ${fallback}`;
        const baseline = context.measureText(sample).width;
        context.font = `72px "${face}", ${fallback}`;
        return Math.abs(context.measureText(sample).width - baseline) > 0.01;
      });
    },
    measure(runs, size, bold) {
      return runs.reduce((width, run) => {
        context.font = `${bold ? 'bold ' : ''}${size}px "${run.fontFace}"`;
        return width + context.measureText(run.text).width;
      }, 0);
    },
    async loadImage(relativePath, assetId, remainingBytes) {
      const path = `${projectRoot.replace(/[\\/]$/, '')}/${relativePath}`;
      const { size } = await readFileHead(path, 0, projectRoot);
      if (size <= 0 || size > Math.min(DECK_LIMITS.imageBytes, remainingBytes)) throw new Error('image_limit');
      const bytes = new Uint8Array(size);
      // Range IPC caps each allocation; growth between stat and read cannot bypass limits.
      for (let offset = 0; offset < size; offset += 1024 * 1024) {
        const count = Math.min(1024 * 1024, size - offset);
        const chunk = await readFileRange(path, offset, count, projectRoot);
        if (chunk.length !== count) throw new Error('invalid_image');
        bytes.set(chunk, offset);
      }
      const header = imageHeader(bytes);
      const data = `data:${header.mime};base64,${toBase64(bytes)}`;
      const image = new Image();
      image.src = data;
      try {
        await image.decode();
        // Reject rotations whose browser dimensions differ from the encoded frame.
        if (image.naturalWidth !== header.width || image.naturalHeight !== header.height) throw new Error('invalid_image');
      } finally { image.src = ''; }
      return { assetId, byteLength: size, ...header, data };
    },
  };
}
