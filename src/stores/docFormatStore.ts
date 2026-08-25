/**
 * 排版格式预设的状态。
 *
 * 装机级，不是项目级：一套公文格式要跨所有项目复用（见
 * docs/feature/docx/01-agent-design.md §7）。一期只有内置预设 + 一个「默认是
 * 哪一套」的选择，后者存 `lib/prefs`；作者自建和「从 Word 文件读取」进二期。
 *
 * `imitated` 那一段是**会话内**的：从一份 .docx 读来的格式先落在这里，作者点
 * 「存为预设」才会进盘。二期接上 `read_doc_format` 时它就有内容了。
 */

import { create } from "zustand";
import {
  BUILTIN_FORMATS,
  DEFAULT_FORMAT_ID,
  type DocFormatPreset,
} from "../lib/docx/format";
import { readPref, writePref } from "../lib/prefs";

const PREF_KEY = "app:docxDefaultFormat";

interface DocFormatState {
  /** 内置 + 会话内模仿来的。作者自建的进二期。 */
  presets: DocFormatPreset[];
  /** AI 不特别指定格式时用的那一套。 */
  defaultId: string;
  /** 设置页里当前在看的那一行（与「是默认」正交——设计稿 1d 的两条通道）。 */
  selectedId: string;

  setDefault: (id: string) => void;
  select: (id: string) => void;
  /** 二期：把 `read_doc_format` 读到的格式挂进会话。 */
  addImitated: (preset: DocFormatPreset) => void;
}

/** 存下来的 id 可能指向一个已经不存在的预设（降级、改版），所以要复核。 */
function initialDefault(): string {
  const saved = readPref(PREF_KEY);
  return saved && BUILTIN_FORMATS.some((p) => p.id === saved) ? saved : DEFAULT_FORMAT_ID;
}

export const useDocFormatStore = create<DocFormatState>((set) => ({
  presets: BUILTIN_FORMATS,
  defaultId: initialDefault(),
  selectedId: initialDefault(),

  setDefault: (id) => {
    writePref(PREF_KEY, id);
    set({ defaultId: id });
  },
  select: (id) => set({ selectedId: id }),
  addImitated: (preset) =>
    set((s) => ({
      presets: [...s.presets.filter((p) => p.id !== preset.id), preset],
      selectedId: preset.id,
    })),
}));

/**
 * 非 React 侧（agent 工具）要的那两样。读的是当下的 store，不是模块加载时的
 * 快照——预设列表会变。
 */
export function currentFormats(): { presets: DocFormatPreset[]; defaultId: string } {
  const { presets, defaultId } = useDocFormatStore.getState();
  return { presets, defaultId };
}
