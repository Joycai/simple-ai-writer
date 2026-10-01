import { beforeEach, describe, expect, it, vi } from 'vitest';

const disk = new Map<string, Uint8Array>();
const bytes = (s: string) => new TextEncoder().encode(s);
const write = vi.fn(async (path: string, data: Uint8Array) => { disk.set(path, data.slice()); });
const copy = vi.fn(async (from: string, to: string) => { disk.set(to, disk.get(from)!.slice()); });
vi.mock('../../../fs/fileio', () => ({
  fileExists: async (p: string) => disk.has(p),
  readFileHead: async (p: string) => { if (!disk.has(p)) throw new Error('missing'); return { size: disk.get(p)!.length }; },
  readFileRange: async (p: string, offset: number, count: number) => disk.get(p)!.slice(offset, offset + count),
  fromBase64: (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0)),
  renamePath: async (from: string, to: string) => { disk.set(to, disk.get(from)!); disk.delete(from); },
  removeFile: async (path: string) => { disk.delete(path); },
  makeDir: vi.fn(), copyPath: (...args: [string, string]) => copy(...args),
  writeBinaryFile: (...args: [string, Uint8Array]) => write(...args),
}));
vi.mock('../environment', () => ({ nativeEnvironment: () => ({
  hasFont: async () => true,
  measure: (runs: {text: string}[], size: number) => runs.reduce((n, r) => n + r.text.length * size * 0.5, 0),
  loadImage: async (path: string, assetId: string) => ({ assetId, byteLength: disk.get(`/p/${path}`)!.length,
    mime: 'image/png', width: 1, height: 1, data: `data:image/png;base64,${btoa(String.fromCharCode(...disk.get(`/p/${path}`)!))}` }),
}) }));
// Writer structure/Office rendering have their own tests. Here pin the exact prepared bytes.
const output = new Uint8Array([80, 75, 3, 4, 0, 255]);
vi.mock('../write', () => ({ nativeDeckToPptx: vi.fn(async () => output.slice()) }));
import { applyNativePptx, prepareNativePptx, releaseNativePptx, formatNativeDiagnostics, type NativePptxReceipt } from '../approval';
import { nativeDeckToPptx } from '../write';

const source = '/p/deck.slides.json', target = '/p/deck.pptx';
const spec = () => ({ version: 1, language: 'en-US', theme: 'paper', assets: [], slides: [{ id: 'intro', layout: 'title', title: 'Hello' }] });
const receipts: NativePptxReceipt[] = [];
async function prepare() {
  const result = await prepareNativePptx('/p', source, target);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  receipts.push(result.receipt);
  return result.receipt;
}
beforeEach(() => {
  receipts.splice(0).forEach(r => releaseNativePptx(r.artifactId));
  disk.clear(); disk.set(source, bytes(JSON.stringify(spec()))); vi.clearAllMocks();
});

describe('native PPTX approval artifact', () => {
  it('prepares without writing, serializes only a small receipt, then writes exactly those bytes once', async () => {
    const receipt = await prepare();
    expect(write).not.toHaveBeenCalled(); expect(copy).not.toHaveBeenCalled();
    expect(JSON.stringify(receipt).length).toBeLessThan(1200);
    expect(receipt.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.themeHash).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.targetHash).toBeNull();
    // Same shape as a recovered JSON record within this process.
    await applyNativePptx('/p', source, target, JSON.parse(JSON.stringify(receipt)));
    expect(disk.get(target)).toEqual(output);
    expect(nativeDeckToPptx).toHaveBeenCalledTimes(1);
    await expect(applyNativePptx('/p', source, target, receipt)).rejects.toThrow('expired');
  });
  it('rejection or restart loses the cache and cannot regenerate on approval', async () => {
    const receipt = await prepare(); releaseNativePptx(receipt.artifactId);
    await expect(applyNativePptx('/p', source, target, receipt)).rejects.toThrow('fresh review');
    expect(write).not.toHaveBeenCalled(); expect(nativeDeckToPptx).toHaveBeenCalledTimes(1);
  });
  it('refuses changed source and does not write a backup or output', async () => {
    const receipt = await prepare(); disk.set(source, bytes(JSON.stringify({ ...spec(), theme: 'midnight' })));
    await expect(applyNativePptx('/p', source, target, receipt)).rejects.toThrow('source or theme changed');
    expect(write).not.toHaveBeenCalled(); expect(copy).not.toHaveBeenCalled();
  });
  it('binds the actual image bytes and refuses an image changed during approval', async () => {
    const s = { ...spec(), assets: [{ id: 'picture', path: 'image.png' }] };
    disk.set(source, bytes(JSON.stringify(s))); disk.set('/p/image.png', new Uint8Array([1, 2, 3]));
    const receipt = await prepare(); expect(receipt.imageHashes).toHaveLength(1);
    disk.set('/p/image.png', new Uint8Array([3, 2, 1]));
    await expect(applyNativePptx('/p', source, target, receipt)).rejects.toThrow('image changed');
    expect(write).not.toHaveBeenCalled();
  });
  it.each(['new', 'modified', 'deleted'])('refuses a %s destination after review', async mode => {
    if (mode !== 'new') disk.set(target, bytes('old'));
    const receipt = await prepare();
    if (mode === 'deleted') disk.delete(target); else disk.set(target, bytes('changed'));
    await expect(applyNativePptx('/p', source, target, receipt)).rejects.toThrow('destination changed');
    expect(write).not.toHaveBeenCalled(); expect(copy).not.toHaveBeenCalled();
  });
  it('backs up the existing binary unchanged before replacement', async () => {
    const old = new Uint8Array([0, 255, 128, 64]); disk.set(target, old);
    const receipt = await prepare();
    const backup = await applyNativePptx('/p', source, target, receipt);
    expect(backup).toContain('/.ai-writer/backups/');
    expect(disk.get(backup!)).toEqual(old); expect(disk.get(target)).toEqual(output);
    expect(copy.mock.invocationCallOrder[0]).toBeLessThan(write.mock.invocationCallOrder[0]);
  });
  it('backup failure prevents overwrite', async () => {
    disk.set(target, bytes('old')); const receipt = await prepare();
    copy.mockRejectedValueOnce(new Error('disk full'));
    await expect(applyNativePptx('/p', source, target, receipt)).rejects.toThrow('disk full');
    expect(write).not.toHaveBeenCalled(); expect(disk.get(target)).toEqual(bytes('old'));
  });
  it('rejects changes during backup', async () => {
    disk.set(target, bytes('old')); const receipt = await prepare();
    copy.mockImplementationOnce(async (from, to) => { disk.set(to, disk.get(from)!.slice()); disk.set(from, bytes('new')); });
    await expect(applyNativePptx('/p', source, target, receipt)).rejects.toThrow('during backup');
    expect(write).not.toHaveBeenCalled();
  });
  it('binds receipt, project and paths; another card cannot redirect bytes', async () => {
    const receipt = await prepare();
    for (const [project, from, to, r] of [
      ['/other', source, target, receipt], ['/p', source, '/p/other.pptx', receipt],
      ['/p', source, target, { ...receipt, fonts: { latin: 'Other', cjk: 'Other' } }],
    ] as const) await expect(applyNativePptx(project, from, to, r)).rejects.toThrow('expired or changed');
    expect(write).not.toHaveBeenCalled();
  });
  it('reports field diagnostics before asking for approval', async () => {
    disk.set(source, bytes(JSON.stringify({ ...spec(), slides: [{ id: 'x', layout: 'title', title: 'x'.repeat(250) }] })));
    const result = await prepareNativePptx('/p', source, target);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unexpected success');
    expect(formatNativeDiagnostics(result.diagnostics)).toContain('text_overflow slide=x /slides/0/title');
    expect(nativeDeckToPptx).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
  });
  it('failed staged write leaves the old destination intact and cleans up', async () => {
    disk.set(target, bytes('old')); const receipt = await prepare();
    write.mockImplementationOnce(async (path, data) => { disk.set(path, data.slice(0, 2)); throw new Error('disk full'); });
    await expect(applyNativePptx('/p', source, target, receipt)).rejects.toThrow('disk full');
    expect(disk.get(target)).toEqual(bytes('old'));
    expect([...disk.keys()].some(p => p.endsWith('.tmp'))).toBe(false);
  });
  it('refuses a destination changed during staging and removes the temporary file', async () => {
    const receipt = await prepare();
    write.mockImplementationOnce(async (path, data) => { disk.set(path, data); disk.set(target, bytes('new author file')); });
    await expect(applyNativePptx('/p', source, target, receipt)).rejects.toThrow('while preparing');
    expect(disk.get(target)).toEqual(bytes('new author file'));
    expect([...disk.keys()].some(p => p.endsWith('.tmp'))).toBe(false);
  });
  it('aborted application writes neither backup nor output', async () => {
    disk.set(target, bytes('old')); const receipt = await prepare();
    const controller = new AbortController(); controller.abort();
    await expect(applyNativePptx('/p', source, target, receipt, controller.signal)).rejects.toThrow();
    expect(write).not.toHaveBeenCalled(); expect(copy).not.toHaveBeenCalled();
  });
  it('rejects assets inside private app data', async () => {
    disk.set(source, bytes(JSON.stringify({ ...spec(), assets: [{ id: 'private', path: '.ai-writer/private.png' }] })));
    expect(await prepareNativePptx('/p', source, target)).toMatchObject({ ok: false, diagnostics: [{ code: 'unsafe_path' }] });
    expect(write).not.toHaveBeenCalled();
  });
  it('limits pending artifacts and releases capacity', async () => {
    for (let i = 0; i < 8; i++) await prepare();
    await expect(prepare()).rejects.toThrow('Too many');
    releaseNativePptx(receipts[0].artifactId); await expect(prepare()).resolves.toHaveProperty('artifactId');
  });
});

it('rejects an on-disk source that differs from the UI buffer before serialization', async () => {
  await expect(prepareNativePptx('/p', source, target, JSON.stringify({ ...spec(), theme: 'midnight' }))).rejects.toThrow('changed on disk');
  expect(nativeDeckToPptx).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
});

it('returns the same frozen deck used to serialize the prepared bytes for UI review', async () => {
  const result = await prepareNativePptx('/p', source, target, JSON.stringify(spec()));
  expect(result.ok).toBe(true); if (!result.ok) return;
  receipts.push(result.receipt);
  expect(vi.mocked(nativeDeckToPptx).mock.calls[0][0]).toBe(result.deck);
  expect(Object.isFrozen(result.deck)).toBe(true);
  expect(result.receipt.fonts).toEqual(result.deck.fonts);
});
