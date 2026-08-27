/**
 * 场景工具的**寻址**与**归档**。
 *
 * 两件事钉在这里：
 *
 * 1. 模型用什么词指一个场景。参数在 1.28 从 `agent` 改名为 `scene`，改名当天
 *    在飞的会话仍然会发旧参数，而那时的症状是「旁白突然说不认识这个场景」。
 *    地址在 13 里又长出 `#场号`，两种拼法都要能带后缀。
 * 2. **废弃场次默认不可见**。作者用「另起一场」作废的场次不进清单、不进检索的
 *    任何一层；点名仍然读得到，但内容前面必须挂一句作废提示——旁白是会往正文里
 *    写字的，把一个试验场当情节写进第三章是这个口子唯一真实的风险。
 */

import { describe, expect, it } from "vitest";
import {
  listScenesTool,
  readSceneMemoryTool,
  readSceneSummaryTool,
  readSceneTool,
  searchScenesTool,
  type AreaNote,
  type SceneInfo,
  type SceneReader,
} from "../sceneTools";
import type { SceneTurn } from "../model";

function localDay(at: number): string {
  const d = new Date(at * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const turn = (index: number, text: string): SceneTurn =>
  ({ index, speaker: "agent", speakerName: "角色", at: 1_755_000_000, text });

const SCENES: SceneInfo[] = [
  {
    agentId: "ag-ava", name: "阿瓦", primary: "", turnCount: 2,
    openMemory: 1, lastAt: 1, gist: "在雨里等人",
    sceneNo: 4,
    archives: [
      { no: 3, discarded: false, title: "雪停之后", turnCount: 40, from: 1_755_000_000, to: 1_755_200_000 },
      { no: 2, discarded: true, title: "试的一场", turnCount: 0, from: 0, to: 0 },
      { no: 1, discarded: false, title: "初见", turnCount: 6, from: 1_754_000_000, to: 1_754_000_000 },
    ],
  },
  {
    agentId: "ag-kael", name: "凯尔", primary: "", turnCount: 1,
    openMemory: 0, lastAt: 2, gist: "刚进城", sceneNo: 1, archives: [],
  },
];

const AREA: Record<string, AreaNote[]> = {
  "ag-ava": [
    { title: "塔下的约定", summary: "我答应她雪停就去塔下", keys: ["塔", "雪原"], scene: 3 },
    // 场号指不到任何一场（区是继承来的）——不该给出场次地址。
    { title: "上一个人留下的", summary: "别人的旧事", keys: ["旧事"], scene: 99 },
  ],
  "ag-kael": [],
};

const reader: SceneReader = {
  list: async () => SCENES,
  read: async (agentId, scene) => ({
    turns: [turn(1, `${agentId}#${scene} 说了一句话`)],
    total: 1,
    renumbered: false,
  }),
  summary: async (agentId, scene) => `${agentId}#${scene} 的摘要`,
  memory: async (agentId) => [
    { id: "m1", kind: "pact", title: `${agentId} 的约定`, body: "", status: "open" } as never,
  ],
  area: async (agentId) => AREA[agentId] ?? [],
};

const ctx = { scenes: reader };

describe("场景寻址：scene 与旧拼法 agent", () => {
  it("read_scene 两种拼法读到同一个场景", async () => {
    const viaScene = await readSceneTool("c1", { scene: "ag-ava" }, ctx);
    const viaAgent = await readSceneTool("c2", { agent: "ag-ava" }, ctx);
    expect(viaScene.content).toContain("说了一句话");
    expect(viaAgent.content).toBe(viaScene.content);
  });

  // 裸 id ＝当前这一场，而当前这一场也有号：地址空间没有洞，模型不用记特例。
  it("裸 id 和当前场号指向同一场", async () => {
    const bare = await readSceneTool("c1", { scene: "ag-ava" }, ctx);
    const numbered = await readSceneTool("c2", { scene: "ag-ava#4" }, ctx);
    expect(bare.content).toContain("ag-ava#4 说了一句话");
    expect(numbered.content).toBe(bare.content);
  });

  it("read_scene_summary / read_scene_memory 同样接受两种拼法", async () => {
    expect((await readSceneSummaryTool("c1", { scene: "ag-kael" }, ctx)).content)
      .toContain("的摘要");
    expect((await readSceneSummaryTool("c2", { agent: "ag-kael" }, ctx)).content)
      .toContain("的摘要");
    expect((await readSceneMemoryTool("c3", { scene: "ag-ava" }, ctx)).content)
      .toContain("ag-ava 的约定");
    expect((await readSceneMemoryTool("c4", { agent: "ag-ava" }, ctx)).content)
      .toContain("ag-ava 的约定");
  });

  it("场景 id 不存在时报出可用清单，而不是空手而归", async () => {
    const res = await readSceneTool("c1", { scene: "ag-nobody" }, ctx);
    expect(res.content).toContain("No scene with id");
    expect(res.content).toContain("ag-ava");
    expect(res.content).toContain("list_scenes");
  });

  // 编号有洞时**绝不**滑到相邻的一场——那会给出一个看起来完全正常、内容却属于
  // 另一场的答案。
  it("场号不存在时报出已有的场次，而不是就近取一场", async () => {
    const res = await readSceneTool("c1", { scene: "ag-ava#9" }, ctx);
    expect(res.content).toContain("没有第 9 场");
    expect(res.content).toContain("#3");
    expect(res.content).toContain("#4(当前)");
  });

  // 隔离的另一半：没有 reader 的界面上，工具说明自己不可用而不是静默返回空。
  it("不在扮演面板时明确说明，而不是返回空结果", async () => {
    const res = await readSceneTool("c1", { scene: "ag-ava" }, {});
    expect(res.content).toContain("narrator");
  });
});

describe("list_scenes 的归档附行", () => {
  it("每个角色一条主行 + 一条归档附行，带标题和日期", async () => {
    const res = await listScenesTool("c1", ctx);
    expect(res.content).toContain("当前第 4 场");
    expect(res.content).toContain("已封存 2 场");
    expect(res.content).toContain("#3「雪停之后」 40轮");
    // 日期按**本地时间**渲染（读它的是作者和模型，不是机器），所以期望值也得
    // 在本地时区算——写死 "2025-08-12" 会在另一个时区的机器上莫名其妙地红。
    expect(res.content).toContain(`${localDay(1_755_000_000)}~${localDay(1_755_200_000)}`);
    expect(res.content).toContain("#1「初见」");
  });

  // 作废的场次不进清单的正文，但要说出它们存在——作者点名要翻的时候，旁白得
  // 知道有这么几场。
  it("把作废的场次单独说明，不混进已封存那一行", async () => {
    const res = await listScenesTool("c1", ctx);
    expect(res.content).toContain("另有 1 场已作废");
    expect(res.content).toContain("不计入故事");
    expect(res.content).not.toContain("「试的一场」");
  });

  it("告诉模型地址长什么样", async () => {
    expect((await listScenesTool("c1", ctx)).content).toContain("<id>#<场号>");
  });
});

describe("废弃场次", () => {
  it("点名仍然读得到，但前面挂着作废提示", async () => {
    const res = await readSceneTool("c1", { scene: "ag-ava#2" }, ctx);
    expect(res.content).toContain("已被作者标为作废");
    expect(res.content).toContain("说了一句话");
  });

  it("摘要同样带提示", async () => {
    const res = await readSceneSummaryTool("c1", { scene: "ag-ava#2" }, ctx);
    expect(res.content).toContain("已被作者标为作废");
  });

  /**
   * 这一条是整片 PR 的安全网。归档打开之后，如果检索照样命中试验场，旁白就会
   * 把作者明确想丢弃的东西当成情节写进正文——比「读不到旧场次」更糟。
   */
  it("检索的两层都搜不到它", async () => {
    const res = await searchScenesTool("c1", { query: "说了", scene: "ag-ava" }, ctx);
    expect(res.content).toContain("ag-ava#3");
    expect(res.content).toContain("ag-ava#4");
    expect(res.content).not.toContain("ag-ava#2");
  });
});

describe("search_scenes 两层", () => {
  it("范围限定认两种拼法，省略则搜全部", async () => {
    const only = await searchScenesTool("c1", { query: "说了", scene: "ag-ava" }, ctx);
    expect(only.content).toContain("ag-ava");
    expect(only.content).not.toContain("ag-kael");

    const legacy = await searchScenesTool("c2", { query: "说了", agent: "ag-ava" }, ctx);
    expect(legacy.content).toBe(only.content);

    const all = await searchScenesTool("c3", { query: "说了" }, ctx);
    expect(all.content).toContain("ag-ava");
    expect(all.content).toContain("ag-kael");
  });

  // 范围限定也接受带场号的地址——模型手上拿到的就是那个形状。
  it("范围限定接受带场号的地址", async () => {
    const res = await searchScenesTool("c1", { query: "说了", scene: "ag-ava#3" }, ctx);
    expect(res.content).toContain("ag-ava");
    expect(res.content).not.toContain("ag-kael");
  });

  /**
   * 索引层存在的全部理由：作者用**自己的话**转述。他说「那次约定」，而两人当时
   * 说的是别的词——逐字检索一个字都对不上，而记忆区的关键字对得上。
   */
  it("转述命中索引层，并给出可以直接读的场次地址", async () => {
    const res = await searchScenesTool("c1", { query: "雪原" }, ctx);
    expect(res.content).toContain("索引命中");
    expect(res.content).toContain("塔下的约定");
    expect(res.content).toContain("→ ag-ava#3");
  });

  it("场次前情的标题也进索引层", async () => {
    const res = await searchScenesTool("c1", { query: "雪停之后" }, ctx);
    expect(res.content).toContain("前情「雪停之后」");
  });

  // 记忆区可以被继承：一条 `scene: 99` 说的是**上一个绑定者**的第 99 场，给出
  // 地址就是一个指错场的链接。宁可只显示条目。
  it("场号指不到任何一场时不给地址", async () => {
    const res = await searchScenesTool("c1", { query: "旧事" }, ctx);
    expect(res.content).toContain("上一个人留下的");
    expect(res.content).not.toContain("#99");
  });

  it("标注记忆区装的是角色以为的事", async () => {
    const res = await searchScenesTool("c1", { query: "雪原" }, ctx);
    expect(res.content).toContain("以为");
  });

  it("一处都不匹配时如实说，而不是给一份空清单", async () => {
    const res = await searchScenesTool("c1", { query: "绝不会出现的词" }, ctx);
    expect(res.content).toContain("没有任何一处匹配");
  });
});

describe("read_scene_memory 的两层", () => {
  it("常驻记忆之外，把已经沉进记忆区的旧事也列出来", async () => {
    const res = await readSceneMemoryTool("c1", { scene: "ag-ava" }, ctx);
    expect(res.content).toContain("ag-ava 的约定");
    expect(res.content).toContain("记忆区");
    expect(res.content).toContain("塔下的约定");
    expect(res.content).toContain("（第 3 场）");
  });

  it("记忆区为空时不冒出一个空标题", async () => {
    const res = await readSceneMemoryTool("c1", { scene: "ag-kael" }, ctx);
    expect(res.content).not.toContain("记忆区");
  });
});
