/**
 * 测试用的最小 zip 读取器：只为「生成 → 解包 → 断言 XML」这条回读校验存在。
 *
 * 手写而不是引一个 zip 库：回读断言的全部意义是**独立于生成侧**地核对产出，
 * 借生成侧的依赖去读它会让这条断言变弱；而且 40 行就够，node 自带 zlib。
 */

import { inflateRawSync } from "node:zlib";

export function unzip(bytes: Uint8Array): Map<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findFromEnd(bytes, 0x06054b50);
  if (eocd < 0) throw new Error("not a zip: no end-of-central-directory record");

  const count = view.getUint16(eocd + 10, true);
  let cursor = view.getUint32(eocd + 16, true);
  const out = new Map<string, string>();

  for (let i = 0; i < count; i++) {
    if (view.getUint32(cursor, true) !== 0x02014b50) throw new Error("bad central directory entry");
    const method = view.getUint16(cursor + 10, true);
    const compressed = view.getUint32(cursor + 20, true);
    const nameLen = view.getUint16(cursor + 28, true);
    const extraLen = view.getUint16(cursor + 30, true);
    const commentLen = view.getUint16(cursor + 32, true);
    const localAt = view.getUint32(cursor + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + nameLen));

    const localNameLen = view.getUint16(localAt + 26, true);
    const localExtraLen = view.getUint16(localAt + 28, true);
    const dataAt = localAt + 30 + localNameLen + localExtraLen;
    const raw = bytes.subarray(dataAt, dataAt + compressed);
    const bodyBytes = method === 0 ? raw : new Uint8Array(inflateRawSync(raw));
    out.set(name, new TextDecoder().decode(bodyBytes));

    cursor += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function findFromEnd(bytes: Uint8Array, signature: number): number {
  for (let i = bytes.length - 4; i >= 0; i--) {
    if (
      bytes[i] === (signature & 0xff) &&
      bytes[i + 1] === ((signature >> 8) & 0xff) &&
      bytes[i + 2] === ((signature >> 16) & 0xff) &&
      bytes[i + 3] === ((signature >> 24) & 0xff)
    ) {
      return i;
    }
  }
  return -1;
}
