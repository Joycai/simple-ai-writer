/** Binary token units match the model window presets. Keep exact manual counts. */
export const TOKEN_STEP = 4096;
export const TOKEN_STOPS = [32, 64, 128, 256, 384, 512, 1024].map((k) => k * 1024);

export function parseTokenLimit(text: string, max: number): number | null {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  const match = /^(\d+(?:\.\d+)?)\s*([km]?)$/i.exec(trimmed);
  if (!match) return null;
  const value = Number(match[1]) * (match[2].toUpperCase() === "M" ? 1048576 : match[2] ? 1024 : 1);
  return Number.isSafeInteger(value) && value >= 0 && value <= max ? value : null;
}

export function formatTokenLimit(value: number): string {
  if (value >= 1048576 && value % 1048576 === 0) return `${value / 1048576}M`;
  if (value >= 1024 && value % 1024 === 0) return `${value / 1024}K`;
  return String(value);
}

/** Display-only approximation; never use this string to save a token limit. */
export function formatTokenBadge(value: number): string {
  if (value < 1024) return String(value);
  const unit = value >= 1048576 ? 1048576 : 1024;
  return `${Number((value / unit).toFixed(1))}${unit === 1048576 ? "M" : "K"}`;
}
