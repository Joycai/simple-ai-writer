import { it, expect, vi } from 'vitest';
import { nativeEnvironment } from '../environment';
import { readFileHead, readFileRange } from '../../../fs/fileio';
vi.mock('../../../fs/fileio', () => ({ readFileHead: vi.fn(), readFileRange: vi.fn(), toBase64: () => '' }));
it('refuses oversized input before any content read', async () => {
  vi.stubGlobal('document', { createElement: () => ({ getContext: () => ({}) }) });
  vi.mocked(readFileHead).mockResolvedValue({ size: 11 * 1024 * 1024, head: new Uint8Array() });
  await expect(nativeEnvironment('/project').loadImage('image.png','pic',50*1024*1024)).rejects.toThrow('image_limit');
  expect(readFileRange).not.toHaveBeenCalled();
  expect(readFileHead).toHaveBeenCalledWith('/project/image.png', 0, '/project');
});
it('checks remaining aggregate allowance before reading and rejects shortened reads', async () => {
  vi.mocked(readFileHead).mockResolvedValue({ size: 100, head: new Uint8Array() });
  await expect(nativeEnvironment('/project').loadImage('image.png','pic',50)).rejects.toThrow('image_limit');
  vi.mocked(readFileRange).mockResolvedValue(new Uint8Array(99));
  await expect(nativeEnvironment('/project').loadImage('image.png','pic',100)).rejects.toThrow('invalid_image');
});
