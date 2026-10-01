import { describe, expect, it } from 'vitest';
import { NATIVE_PPTX_WORKFLOW } from '../nativePptx';
import { parseDeckSpec } from '../../pptx/native/validate';
import { resolveDeck } from '../../pptx/native/resolve';

describe('on-demand native PPTX contract', () => {
  it('the published six-layout example passes source and layout preflight', async () => {
    const example = /```json\n([\s\S]*?)```/.exec(NATIVE_PPTX_WORKFLOW)![1];
    const parsed = parseDeckSpec(example);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
    expect(new Set(parsed.value.slides.map(s => s.layout)).size).toBe(6);
    const resolved = await resolveDeck(parsed.value, {
      hasFont: async () => true,
      measure: (runs, size) => runs.reduce((n, r) => n + r.text.length * size * 0.5, 0),
      loadImage: async (_, assetId) => ({ assetId, byteLength: 200, width: 100, height: 100, mime: 'image/png', data: 'fixture' }),
    });
    expect(resolved.ok).toBe(true);
  });
});
