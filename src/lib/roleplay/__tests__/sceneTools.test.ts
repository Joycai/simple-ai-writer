/**
 * 场景工具的**寻址**：模型用什么词指一个场景。
 *
 * 参数在 1.28 从 `agent` 改名为 `scene`，因为模型面对的词汇从来就是「场景」
 * —— 工具名（read_scene / search_scenes）、`list_scenes` 的输出、每个参数说明
 * 都写 "Scene id"，只有线上参数名说 agent。那个错位和知识库侧的 name/entity
 * 是同一类，修法也一样：改名 + 接受旧拼法。
 *
 * 这里钉住的是「两种拼法解析到同一个场景」，因为改名当天在飞的会话仍然会发
 * 旧参数，而那时的症状会是「旁白突然说不认识这个场景」。
 */

import { describe, expect, it } from "vitest";
import {
  readSceneMemoryTool,
  readSceneSummaryTool,
  readSceneTool,
  searchScenesTool,
  type SceneInfo,
  type SceneReader,
} from "../sceneTools";

const SCENES: SceneInfo[] = [
  {
    agentId: "ag-ava", name: "阿瓦", primary: "", turnCount: 2,
    openMemory: 1, lastAt: 1, gist: "在雨里等人",
  },
  {
    agentId: "ag-kael", name: "凯尔", primary: "", turnCount: 1,
    openMemory: 0, lastAt: 2, gist: "刚进城",
  },
];

const reader: SceneReader = {
  list: async () => SCENES,
  read: async (agentId) => ({
    turns: [{ index: 1, role: "character", text: `${agentId} 说了一句话`, at: 1 } as never],
    total: 1,
    renumbered: false,
  }),
  summary: async (agentId) => `${agentId} 的摘要`,
  memory: async (agentId) => [
    { id: "m1", kind: "pact", title: `${agentId} 的约定`, body: "", status: "open" } as never,
  ],
};

const ctx = { scenes: reader };

describe("场景寻址：scene 与旧拼法 agent", () => {
  it("read_scene 两种拼法读到同一个场景", async () => {
    const viaScene = await readSceneTool("c1", { scene: "ag-ava" }, ctx);
    const viaAgent = await readSceneTool("c2", { agent: "ag-ava" }, ctx);
    expect(viaScene.content).toContain("ag-ava 说了一句话");
    expect(viaAgent.content).toBe(viaScene.content);
  });

  it("read_scene_summary / read_scene_memory 同样接受两种拼法", async () => {
    expect((await readSceneSummaryTool("c1", { scene: "ag-kael" }, ctx)).content)
      .toContain("ag-kael 的摘要");
    expect((await readSceneSummaryTool("c2", { agent: "ag-kael" }, ctx)).content)
      .toContain("ag-kael 的摘要");
    expect((await readSceneMemoryTool("c3", { scene: "ag-ava" }, ctx)).content)
      .toContain("ag-ava 的约定");
    expect((await readSceneMemoryTool("c4", { agent: "ag-ava" }, ctx)).content)
      .toContain("ag-ava 的约定");
  });

  it("search_scenes 的范围限定认两种拼法，省略则搜全部", async () => {
    const only = await searchScenesTool("c1", { query: "说了", scene: "ag-ava" }, ctx);
    expect(only.content).toContain("ag-ava");
    expect(only.content).not.toContain("ag-kael");

    const legacy = await searchScenesTool("c2", { query: "说了", agent: "ag-ava" }, ctx);
    expect(legacy.content).toBe(only.content);

    const all = await searchScenesTool("c3", { query: "说了" }, ctx);
    expect(all.content).toContain("ag-ava");
    expect(all.content).toContain("ag-kael");
  });

  it("场景 id 不存在时报出可用清单，而不是空手而归", async () => {
    const res = await readSceneTool("c1", { scene: "ag-nobody" }, ctx);
    expect(res.content).toContain("No scene with id");
    expect(res.content).toContain("ag-ava");
    expect(res.content).toContain("list_scenes");
  });

  // 隔离的另一半：没有 reader 的界面上，工具说明自己不可用而不是静默返回空。
  it("不在扮演面板时明确说明，而不是返回空结果", async () => {
    const res = await readSceneTool("c1", { scene: "ag-ava" }, {});
    expect(res.content).toContain("narrator");
  });
});
