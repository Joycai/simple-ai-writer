/**
 * `session.json` 的下标↔身份 round-trip。
 *
 * 存在的理由是一次真实的坏法：`serializeChatSession` 只认 `ChatSessionMeta`
 * 的字段，Roleplay 扩展出来的 `boundBlock` / `memoryBlock` 引用它一概不存。
 * boundBlock 靠 `SerializedSession` 单独存下标救了回来，memoryBlock 没有——
 * 于是重启之后 `meta.memoryBlock` 永远是 undefined，四个刷新时刻里除播种外
 * 全部静默 no-op：记忆块内容冻结在上次存盘时刻，之后记下的约定在压缩后就
 * 从上下文里消失。这组测试钉住「两个块都按身份指回恢复出的 history」。
 */

import { describe, expect, it, vi } from "vitest";

const files = new Map<string, string>();

vi.mock("../../fs/fileio", () => ({
  readFile: vi.fn(async (p: string) => {
    const v = files.get(p);
    if (v === undefined) throw new Error(`ENOENT ${p}`);
    return v;
  }),
  writeFile: vi.fn(async (p: string, c: string) => { files.set(p, c); }),
  appendFile: vi.fn(),
  makeDir: vi.fn(),
  fileExists: vi.fn(async (p: string) => files.has(p)),
  readDir: vi.fn(async () => []),
  renamePath: vi.fn(),
  removeFile: vi.fn(async (p: string) => { files.delete(p); }),
}));

import { createSessionMeta } from "../../agent/compact";
import type { StreamMessage } from "../../ai/types";
import { loadSession, saveSession, sessionPath, type RoleplaySession } from "../store";

const AGENT_ID = "rp-test-0001";

function fixture(): { session: RoleplaySession; history: StreamMessage[] } {
  const system: StreamMessage = { role: "system", content: "人设。" };
  const bound: StreamMessage = { role: "user", content: "【绑定设定】\n## 沈砚\n正文" };
  const memory: StreamMessage = { role: "user", content: "【记忆】\n- (m1) 雪停了一起去塔下" };
  const q: StreamMessage = { role: "user", content: "「你还在等？」" };
  const a: StreamMessage = { role: "assistant", content: "「等谁不重要。」" };
  const history = [system, bound, memory, q, a];
  const meta = createSessionMeta();
  meta.turnStarts.push(q);
  return {
    history,
    session: {
      history,
      snapshot: { turns: [], history, meta, usage: null, taskId: null },
      boundBlock: bound,
      memoryBlock: memory,
    },
  };
}

describe("saveSession / loadSession", () => {
  it("round-trips both block identities into the restored history", async () => {
    files.clear();
    const { session } = fixture();
    await saveSession("/p", AGENT_ID, session);
    const loaded = await loadSession("/p", AGENT_ID);
    expect(loaded).not.toBeNull();
    // 身份指回**恢复出的** history 里的对象，不是原对象——重启后原对象已不存在。
    expect(loaded!.boundBlock).toBe(loaded!.history[1]);
    expect(loaded!.memoryBlock).toBe(loaded!.history[2]);
    expect(String(loaded!.memoryBlock!.content)).toContain("雪停了一起去塔下");
  });

  it("reads a legacy file without the memoryBlock field as \"no block\"", async () => {
    files.clear();
    const { session } = fixture();
    await saveSession("/p", AGENT_ID, session);
    const raw = JSON.parse(files.get(sessionPath("/p", AGENT_ID))!) as Record<string, unknown>;
    delete raw.memoryBlock;
    files.set(sessionPath("/p", AGENT_ID), JSON.stringify(raw));

    const loaded = await loadSession("/p", AGENT_ID);
    expect(loaded).not.toBeNull();
    expect(loaded!.boundBlock).toBe(loaded!.history[1]);
    // null 而不是 undefined / 越界对象——调用方（select）据此走 ensureBlocks 补块。
    expect(loaded!.memoryBlock).toBeNull();
  });

  it("drops an out-of-range block index instead of guessing", async () => {
    files.clear();
    const { session } = fixture();
    await saveSession("/p", AGENT_ID, session);
    const raw = JSON.parse(files.get(sessionPath("/p", AGENT_ID))!) as Record<string, unknown>;
    raw.memoryBlock = 999;
    raw.boundBlock = -1;
    files.set(sessionPath("/p", AGENT_ID), JSON.stringify(raw));

    const loaded = await loadSession("/p", AGENT_ID);
    expect(loaded).not.toBeNull();
    expect(loaded!.boundBlock).toBeNull();
    expect(loaded!.memoryBlock).toBeNull();
  });
});
