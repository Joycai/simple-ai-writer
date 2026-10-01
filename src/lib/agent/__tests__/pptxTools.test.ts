import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Proposal, ToolContext } from '../toolTypes';
const prepare = vi.fn();
const release = vi.fn();
vi.mock('../../pptx/native/approval', () => ({
  prepareNativePptx: (...a: unknown[]) => prepare(...a), releaseNativePptx: (...a: unknown[]) => release(...a),
  formatNativeDiagnostics: () => 'text_overflow slide=intro /slides/0/title: Shorten text.',
}));
vi.mock('../../fs/fileio', () => ({ fileExists: async () => true, readFile: async () => '<section class="slide">Old</section>' }));
import { exportPptxTool } from '../pptxTools';
const receipt = { artifactId: 'test-id', slides: 2, theme: 'paper', fonts: { latin: 'Arial', cjk: 'Microsoft YaHei' }, targetHash: null };
const approval = vi.fn();
const ctx = { projectPath: '/p', requestApproval: approval } as unknown as ToolContext;
beforeEach(() => {
  vi.clearAllMocks(); prepare.mockResolvedValue({ ok: true, receipt });
  approval.mockResolvedValue({ approved: true, backupPath: 'Exported prepared deck.' });
});
describe('native export_pptx routing and approval', () => {
  it('prepares a native artifact, proposes its receipt, uses the actual apply report, then releases it', async () => {
    const result = await exportPptxTool('call', { source_path: '/p/a.slides.json' }, ctx);
    expect(prepare).toHaveBeenCalledWith('/p', '/p/a.slides.json', '/p/a.pptx');
    expect(approval).toHaveBeenCalledWith(expect.objectContaining({ format: 'native', native: receipt, slides: 2 }));
    expect(result.content).toBe('Exported prepared deck.'); expect(release).toHaveBeenCalledWith('test-id');
  });
  it('rejects mismatched aliases without preparing or approving', async () => {
    expect((await exportPptxTool('c', { source_path: '/p/a.slides.json', html_path: '/p/b.html' }, ctx)).content).toContain('disagree');
    expect(prepare).not.toHaveBeenCalled(); expect(approval).not.toHaveBeenCalled();
  });
  it.each([{ source_path: '/p/a.html' }, { html_path: '/p/a.html' }, { source_path: 'a.html', html_path: '/p/a.html' }])('keeps HTML inputs and old payloads compatible: %j', async args => {
    await exportPptxTool('c', args, ctx);
    expect(prepare).not.toHaveBeenCalled();
    const proposal = approval.mock.calls[0][0] as Proposal;
    expect(proposal).toMatchObject({ kind: 'pptx', tier: 'section.slide', slides: 1 });
    expect(proposal).not.toHaveProperty('format', 'native');
  });
  it('preflight errors include repair guidance and never raise a card', async () => {
    prepare.mockResolvedValue({ ok: false, diagnostics: [{ code: 'text_overflow', path: '/slides/0/title', slideId: 'intro' }] });
    const result = await exportPptxTool('c', { source_path: '/p/a.slides.json' }, ctx);
    expect(result.content).toContain('text_overflow slide=intro /slides/0/title');
    expect(approval).not.toHaveBeenCalled();
  });
  it('rejection releases bytes and preserves author feedback', async () => {
    approval.mockResolvedValue({ approved: false, reason: 'Use another theme' });
    const result = await exportPptxTool('c', { source_path: '/p/a.slides.json' }, ctx);
    expect(result.content).toContain('REJECTED'); expect(result.content).toContain('Use another theme');
    expect(release).toHaveBeenCalledWith('test-id');
  });
  it('distinguishes a stale apply failure from an author rejection', async () => {
    approval.mockResolvedValue({ approved: false, reason: 'apply failed: PPTX source changed' });
    const result = await exportPptxTool('c', { source_path: '/p/a.slides.json' }, ctx);
    expect(result.content).toContain('fresh export'); expect(result.content).not.toContain('user REJECTED');
    expect(release).toHaveBeenCalledWith('test-id');
  });
  it('aborted approvals release bytes as well', async () => {
    approval.mockRejectedValue(new Error('aborted'));
    expect((await exportPptxTool('c', { source_path: '/p/a.slides.json' }, ctx)).content).toContain('aborted');
    expect(release).toHaveBeenCalledWith('test-id');
  });
  it('requires an approval surface before allocating an artifact', async () => {
    await exportPptxTool('c', { source_path: '/p/a.slides.json' }, { projectPath: '/p' } as ToolContext);
    expect(prepare).not.toHaveBeenCalled();
  });
  it.each(['/else/a.slides.json', '/p/.ai-writer/a.slides.json'])('rejects forbidden source %s', async source_path => {
    expect((await exportPptxTool('c', { source_path }, ctx)).content).toContain('outside');
    expect(prepare).not.toHaveBeenCalled();
  });
});
