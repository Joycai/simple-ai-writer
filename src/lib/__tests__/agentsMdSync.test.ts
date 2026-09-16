/**
 * `AGENTS.md` 是 `CLAUDE.md` 的生成镜像，不许漂开。
 *
 * 仓库里认两种约定：Claude Code 读 `CLAUDE.md`，Codex / Cursor 一类读
 * `AGENTS.md`。两份文件写的是同一批东西——命令、目录地图、以及「坏了也不响」
 * 的硬规则。所以真正的问题不是要不要有第二份，是第二份怎么才不会变成旧的那份：
 * 手抄一份 24KB 的指南，下一次改 `CLAUDE.md` 的人（或 agent）不会想到还有个
 * 兄弟文件要跟着改，而 CI 全绿——读到旧硬规则的 agent 会照着旧规则改代码，这类
 * 坏正好是本项目用扫描闸门盯着的那一类。
 *
 * 于是 `AGENTS.md` 不手写：`scripts/gen-agents-md.ts` 从 `CLAUDE.md` 生成它
 * （变换只有换头一处，住在 `scripts/agents-md.ts`，与 `contractData.ts` 由
 * `gen-theme-contract.ts` 冻出来是同一个套路）。这条测试调的是同一个
 * `renderAgentsMd`，所以它钉的是生成规则本身，而不是又抄一遍的期望值。
 *
 * 第二个断言守的是另一条路：把 `CLAUDE.md` 原样复制过来也能让「两份一致」看起来
 * 成立，但那样 `AGENTS.md` 的头会自称是给 Claude Code 的——头必须是中立的那个，
 * 这正是生成器唯一做的事。
 */
import { describe, expect, it } from "vitest";
import { BODY_MARKER, renderAgentsMd } from "../../../scripts/agents-md.ts";

/** 按 cssKeyframeNames.test.ts 的先例就地声明（本项目 tsconfig 没有 @types/node）。 */
declare const require: (m: string) => {
  readFileSync(p: string, enc: string): string;
};
declare const process: { cwd(): string };

const fs = require("node:fs");
const read = (rel: string): string => fs.readFileSync(`${process.cwd()}/${rel}`, "utf8");

describe("AGENTS.md 镜像", () => {
  it("是 CLAUDE.md 此刻的生成结果", () => {
    expect(
      read("AGENTS.md"),
      `AGENTS.md 与 CLAUDE.md 漂开了。要改的是 CLAUDE.md（AGENTS.md 不手写），` +
        `改完跑 node scripts/gen-agents-md.ts 重新生成；` +
        `若你刚才改的正是 AGENTS.md，把那处改动搬回 CLAUDE.md 再生成一次。`,
    ).toBe(renderAgentsMd(read("CLAUDE.md")));
  });

  it("换的只有头，正文一行不动", () => {
    const agents = read("AGENTS.md");
    const claude = read("CLAUDE.md");
    expect(agents.startsWith("# AGENTS.md\n"), "AGENTS.md 得有自己的标题").toBe(true);
    expect(claude.startsWith("# CLAUDE.md\n"), "CLAUDE.md 的标题是生成器的拆点依据").toBe(true);
    expect(
      agents.slice(agents.indexOf(BODY_MARKER)),
      "正文从 " + BODY_MARKER + " 那行起必须与 CLAUDE.md 逐字相同",
    ).toBe(claude.slice(claude.indexOf(BODY_MARKER)));
  });
});
