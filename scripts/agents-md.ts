/**
 * CLAUDE.md → AGENTS.md 的全部变换，不含 I/O。
 *
 * 两份 agent 指南必须是同一份内容：`CLAUDE.md` 是源，`AGENTS.md` 是它换个头
 * 的镜像——认 `AGENTS.md` 约定的 agent（Codex、Cursor…）于是读到同一张地图，
 * 而不是一份迟早漂开的抄本。漂开的代价不是难看：两边写的都是「坏了也不响」的
 * 硬规则，读到旧的那份的 agent 会照着旧规则改代码，而 CI 全绿。
 *
 * 变换只有一处：把头（标题 + 「这份文件给谁看」那句）换成中立的说法，正文从
 * `BODY_MARKER` 那行起原样搬过去。拆点认的是标记不是行号——`CLAUDE.md` 的头
 * 会长，行号会漂，而 `> **Progressive disclosure**` 是它头下第一块正文，改名时
 * grep 找得到（`docSourceRefs.test.ts` 讲的就是这件事）。
 *
 * `gen-agents-md.ts` 用它写文件，`src/lib/__tests__/agentsMdSync.test.ts` 用它
 * 算「AGENTS.md 此刻应该长什么样」。两边共用同一个函数，所以那条测试钉的是生成
 * 规则本身，不是又抄一遍的期望值。
 */

/** AGENTS.md 的正文从这一行开始（含）；它上面的一切都算头，会被换掉。 */
export const BODY_MARKER = "> **Progressive disclosure**";

/**
 * 换上去的那个头。「GENERATED … do not edit by hand」照 `contractData.ts` 的先例：
 * 说清谁生成的、漂了谁拦、怎么重来——三件事都得在文件自己身上写着，因为读到
 * 这个文件的是 agent 和人，不是提交历史。
 */
const HEAD = `# AGENTS.md

This file provides guidance to AI coding agents (Codex, Claude Code, Cursor, …) when working with code in this repository.

> **GENERATED from [\`CLAUDE.md\`](CLAUDE.md) by \`scripts/gen-agents-md.ts\` — do not edit by hand.** \`CLAUDE.md\` is the source; this file is its body under an agent-neutral head, so agents that follow the \`AGENTS.md\` convention read the same map. Edit \`CLAUDE.md\`, then run \`node scripts/gen-agents-md.ts\`; \`agentsMdSync.test.ts\` fails when the two drift.

`;

/** 由 CLAUDE.md 全文算出 AGENTS.md 全文。头对不上就抛，别悄悄生成半份指南。 */
export function renderAgentsMd(claudeMd: string): string {
  if (!claudeMd.startsWith("# CLAUDE.md\n")) {
    throw new Error("CLAUDE.md 的标题不是 \"# CLAUDE.md\" 了：同步改 scripts/agents-md.ts 的判断");
  }
  const at = claudeMd.indexOf(BODY_MARKER);
  if (at < 0) {
    throw new Error(`CLAUDE.md 里找不到正文起点 \`${BODY_MARKER}\`：那一节改名了就同步改 BODY_MARKER`);
  }
  return HEAD + claudeMd.slice(at);
}
