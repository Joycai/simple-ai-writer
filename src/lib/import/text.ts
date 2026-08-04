/**
 * Byte → string decoding for imported plain-text files.
 *
 * Tender attachments written on Chinese Windows are as likely to be GBK as
 * UTF-8, and decoding GBK bytes as UTF-8 produces mojibake that looks like a
 * successful import. So: strict UTF-8 first (fatal — real UTF-8 passes, GBK
 * virtually never does), then GBK, then lossy UTF-8 as the floor.
 */

export function decodeText(data: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    /* not UTF-8 — try the legacy encoding */
  }
  try {
    return new TextDecoder("gbk").decode(data);
  } catch {
    // Runtime without GBK tables (bare Node without full ICU) — degrade openly.
    return new TextDecoder("utf-8").decode(data);
  }
}
