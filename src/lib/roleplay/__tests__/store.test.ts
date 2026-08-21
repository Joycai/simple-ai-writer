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
const dirs = new Set<string>();

vi.mock("../../fs/fileio", () => ({
  readFile: vi.fn(async (p: string) => {
    const v = files.get(p);
    if (v === undefined) throw new Error(`ENOENT ${p}`);
    return v;
  }),
  writeFile: vi.fn(async (p: string, c: string) => { files.set(p, c); }),
  appendFile: vi.fn(),
  makeDir: vi.fn(async (p: string) => { dirs.add(p); }),
  fileExists: vi.fn(async (p: string) => files.has(p) || dirs.has(p)),
  readDir: vi.fn(async (p: string) => {
    const kids = new Set<string>();
    for (const d of [...dirs, ...files.keys()]) {
      if (d.startsWith(`${p}/`)) kids.add(d.slice(p.length + 1).split("/")[0]);
    }
    return [...kids].map((name) => ({
      name, path: `${p}/${name}`, isDirectory: !files.has(`${p}/${name}`),
    }));
  }),
  renamePath: vi.fn(),
  removeFile: vi.fn(async (p: string) => { files.delete(p); }),
}));

import { createSessionMeta } from "../../agent/compact";
import type { StreamMessage } from "../../ai/types";
import {
  loadRoster, loadSession, rosterPath, saveSession, sessionPath, type RoleplaySession,
} from "../store";

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

/**
 * 花名册的损坏恢复。「JSON 合法但条目全坏」曾经是盲区：一对返回相同值的死
 * 分支让目录重建从未发生，损坏的花名册被读成「一个 agent 都没有」。
 */
describe("loadRoster", () => {
  const persona = { mode: "prompt", dirPath: null, prompt: "一个路过的旅人" };

  it("a valid empty roster does not trigger a rebuild", async () => {
    files.clear(); dirs.clear();
    files.set(rosterPath("/p"), JSON.stringify({ v: 1, authorPersona: persona, agents: [] }));
    const { roster, rebuilt } = await loadRoster("/p");
    expect(rebuilt).toBe(false);
    expect(roster.agents).toEqual([]);
    expect(roster.authorPersona.prompt).toBe("一个路过的旅人");
  });

  it("rebuilds from directories when every entry fails to coerce", async () => {
    files.clear(); dirs.clear();
    // 条目全坏（缺 id），但 JSON 本身合法。
    files.set(rosterPath("/p"), JSON.stringify({
      v: 1, authorPersona: persona, agents: [{ name: "没有 id" }, 42],
    }));
    dirs.add("/p/.ai-writer/roleplay");
    dirs.add("/p/.ai-writer/roleplay/rp-abc-0001");
    files.set(
      "/p/.ai-writer/roleplay/rp-abc-0001/agent.md",
      "---\nid: rp-abc-0001\nkind: character\nname: 沈砚\n---\n\n说话短。\n",
    );
    const { roster, rebuilt } = await loadRoster("/p");
    expect(rebuilt).toBe(true);
    expect(roster.agents.map((a) => a.id)).toEqual(["rp-abc-0001"]);
    expect(roster.agents[0].name).toBe("沈砚");
    // 条目坏了不等于 persona 也坏了——能救的都带上。
    expect(roster.authorPersona.prompt).toBe("一个路过的旅人");
  });

  it("rebuilds when the file is not JSON at all", async () => {
    files.clear(); dirs.clear();
    files.set(rosterPath("/p"), "{not json");
    dirs.add("/p/.ai-writer/roleplay");
    dirs.add("/p/.ai-writer/roleplay/rp-abc-0001");
    files.set(
      "/p/.ai-writer/roleplay/rp-abc-0001/agent.md",
      "---\nid: rp-abc-0001\nkind: narrator\nname: 旁白\n---\n",
    );
    const { roster, rebuilt } = await loadRoster("/p");
    expect(rebuilt).toBe(true);
    expect(roster.agents[0].kind).toBe("narrator");
  });
});
