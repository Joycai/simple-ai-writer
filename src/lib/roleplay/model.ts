/**
 * 互动式角色扮演 — 领域类型与常量。
 *
 * 设计与取舍见 docs/feature/roleplay/。这里只放类型、常量和纯粹的校验，
 * 任何 IO 都在 ./store，任何上下文装配都在 ./context。
 */

/** 扮演（演一个人物）/ 旁白（不演人，看得见全场）。 */
export type AgentKind = "character" | "narrator";

/** 作者此刻在故事里是谁。 */
export interface AuthorPersona {
  mode: "lore" | "prompt" | "none";
  /** mode === "lore" 时有效，指向人物条目目录。 */
  dirPath: string | null;
  /** mode === "prompt" 时有效。 */
  prompt: string;
}

export const NO_PERSONA: AuthorPersona = { mode: "none", dirPath: null, prompt: "" };

export interface RoleplayAgent {
  id: string;
  kind: AgentKind;
  name: string;
  /** 主角条目目录；旁白恒为 null。 */
  primaryDirPath: string | null;
  /**
   * 常驻绑定，**复用 lib/context/loreSelect 的 pin 语法**（`dirPath` 或
   * `dirPath#facet.md`）。不是巧合：绑定就是「永久钉住」，和 AiPanel 的
   * `selectedLorePaths` 是同一个概念，只是作用域从一次任务变成一个 agent 的一生。
   */
  boundPaths: string[];
  /** null = 跟随全局 activeModelId。 */
  modelId: string | null;
  /** null = 用花名册的全局设置。 */
  authorPersona: AuthorPersona | null;
  /** 懒创建的 task workspace id（子代理/委派需要它落笔记）。 */
  taskId: string | null;
  createdAt: number;
  updatedAt: number;
  /** transcript 里的轮数，花名册直接显示，避免为了一个数字去解析文件。 */
  turnCount: number;
}

/** transcript 里的一轮。`index` 从 1 起，单调递增，是一切寻址的单位。 */
export interface SceneTurn {
  index: number;
  speaker: "author" | "agent";
  /** 显示名：作者身份名或角色名。作者无身份时为空串。 */
  speakerName: string;
  /** Unix 秒。 */
  at: number;
  text: string;
}

/** 同时最多几个 agent 在生成。信号量，不是三个分支——改成 5 就是改这个数。 */
export const MAX_CONCURRENT_RUNS = 3;

/** `read_scene` 省略范围时给最近多少轮。 */
export const DEFAULT_SCENE_WINDOW = 20;

/** 一次 `read_scene` 最多返回多少字符，超出按页续读。 */
export const SCENE_READ_CHAR_CAP = 8000;

/** 花名册摘要行最多显示多少字符。 */
export const ROSTER_PREVIEW_CHARS = 60;

/**
 * agent 目录名的合法字符。
 *
 * 校验而不是转义：这个 id 会拼进文件路径，而它可能来自一个手改过的
 * agents.json 或别人拷来的目录。见 lib/paths 的同类约束。
 */
const ID_RE = /^rp-[a-z0-9-]{1,60}$/;

export function isValidAgentId(id: string): boolean {
  return ID_RE.test(id);
}

/** `rp-<base36 时间戳>-<4 位随机>`，与 taskWorkspace 的 id 同风格。 */
export function generateAgentId(now: number, rand: number): string {
  const stamp = now.toString(36);
  const suffix = Math.floor(rand * 36 ** 4).toString(36).padStart(4, "0");
  return `rp-${stamp}-${suffix}`;
}

/**
 * 头像没有图片时的回退字。
 *
 * 取**最后**一个字符，不是第一个：设计稿里 沈砚→砚、老陈→陈、无名僧→僧、
 * 姜织→织，中文姓名的辨识度在名不在姓（一屋子姓沈的人会得到一样的方块）。
 * 按码点切分，所以 emoji 名字也只取一个字形而不是半个代理对。
 */
export function avatarGlyph(name: string): string {
  const chars = [...name.trim()];
  return chars.length ? chars[chars.length - 1] : "?";
}
