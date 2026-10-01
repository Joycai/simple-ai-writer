import { describe, it, expect, vi } from 'vitest';
import { resolveDeck, type ResolveEnvironment } from '../resolve';
import type { DeckSpec } from '../model';
const source = (): DeckSpec => ({ version: 1, language: 'en-US', theme: 'paper', assets: [], slides: [{ id: 'a', layout: 'title', title: 'Hello 中文' }] });
const environment = (): ResolveEnvironment => ({ hasFont: async () => true, measure: runs => runs.reduce((n,r) => n+r.text.length*10,0), loadImage: vi.fn() });
describe('native resolve', () => {
  it('validates before performing I/O', async () => {
    const env = environment(); env.hasFont = vi.fn();
    expect((await resolveDeck({}, env)).ok).toBe(false); expect(env.hasFont).not.toHaveBeenCalled();
  });
  it('selects fallback candidates explicitly and freezes the result', async () => {
    const env = environment(); env.hasFont = async f => ['Aptos', 'Microsoft YaHei'].includes(f);
    const spec = source(); const result = await resolveDeck(spec, env);
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.value.fonts).toEqual({ latin: 'Aptos', cjk: 'Microsoft YaHei' });
    spec.slides[0].title = 'changed';
    expect(Object.isFrozen(result.value.slides[0].objects)).toBe(true);
    expect(result.value.risks).toContain('recipient_fonts_required');
  });
  it('fails when all CJK fonts are unavailable', async () => {
    const env = environment(); env.hasFont = async f => f === 'Arial';
    expect((await resolveDeck(source(), env)).diagnostics).toEqual([{ code: 'missing_font', path: '/theme' }]);
  });
  it('locates resource failures and validates loader observations', async () => {
    const spec = source(); spec.assets = [{ id: 'pic', path: 'pic.png' }];
    const env = environment(); env.loadImage = async () => { throw new Error('image_limit'); };
    expect((await resolveDeck(spec, env)).diagnostics).toEqual([{ code: 'image_limit', path: '/assets/0' }]);
    env.loadImage = async () => ({ assetId: 'pic', data: '', width: 0, height: 1, byteLength: 1, mime: 'image/png' });
    expect((await resolveDeck(spec, env)).ok).toBe(false);
  });
});
