/** Cap each canvas independently of CSS zoom, including oversized PDF page boxes. */
export function pdfPixelRatio(width: number, height: number, deviceRatio: number): number {
  return Math.min(deviceRatio || 1, 2, 8192 / Math.max(width, height), Math.sqrt(16_000_000 / (width * height)));
}

export function pdfPageNumber(value: number, count: number, current: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(count, Math.trunc(value))) : current;
}
