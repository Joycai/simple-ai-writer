/**
 * 排版格式预设的状态。
 *
 * 装机级，不是项目级：一套公文格式要跨所有项目复用（见
 * docs/feature/docx/01-agent-design.md §7）。内置的住在代码里，作者自建的落在
 * `config.db`（`lib/docx/presets`），从一份 .docx 读来的先只活在这次会话里——
 * 作者点「存为预设」才落盘。
 *
 * 「默认是哪一套」存 `lib/prefs`。它可能指向一个已经被删掉的预设，所以每次
 * 列表变化都要复核一次，而不是只在启动时校验。
 */

import { create } from "zustand";
import {
  BUILTIN_FORMATS,
  DEFAULT_FORMAT_ID,
  type DocFormat,
  type DocFormatPreset,
} from "../lib/docx/format";
import { deleteCustomFormat, loadCustomFormats, saveCustomFormat } from "../lib/docx/presets";
import { readPref, writePref } from "../lib/prefs";

const PREF_KEY = "app:docxDefaultFormat";

interface DocFormatState {
  /** 内置 + 作者自建 + 本会话模仿来的，按这个顺序。 */
  presets: DocFormatPreset[];
  /** AI 不特别指定格式时用的那一套。 */
  defaultId: string;
  /** 设置页里当前在看的那一行（与「是默认」正交——设计稿 1d 的两条通道）。 */
  selectedId: string;
  hydrated: boolean;

  hydrate: () => Promise<void>;
  setDefault: (id: string) => void;
  select: (id: string) => void;
  /** 新建或改写一套自建预设，落盘。 */
  saveFormat: (preset: DocFormatPreset) => Promise<void>;
  /** 删一套自建预设。内置的删不掉——调用方不该给它们删按钮。 */
  removeFormat: (id: string) => Promise<void>;
  /** 「复制一份」：任何一套（含内置）都能复制成一套可改的自建预设，返回新 id。 */
  duplicate: (id: string) => Promise<string | null>;
  /** 把 `read_doc_format` 读到的格式挂进本次会话。 */
  addImitated: (preset: DocFormatPreset) => void;
}

function savedDefault(): string {
  return readPref(PREF_KEY) || DEFAULT_FORMAT_ID;
}

/** 默认指向一个不存在的预设时退回内置——否则每次导出都会报「找不到格式」。 */
function reconcile(presets: DocFormatPreset[], wanted: string): string {
  return presets.some((p) => p.id === wanted) ? wanted : DEFAULT_FORMAT_ID;
}

/** `<label> 副本` / `<label> 副本 2`……在**同一批** label 里避重。 */
function copyLabel(base: string, taken: readonly string[]): string {
  const first = `${base} 副本`;
  if (!taken.includes(first)) return first;
  for (let n = 2; ; n++) {
    const candidate = `${first} ${n}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

/**
 * 新预设的 id。**不用时间戳**（`Date.now()` 在纯逻辑里是个测不了的输入），
 * 也不用随机数：从现有 id 里推出下一个序号，同一份列表永远得到同一个答案。
 */
export function nextCustomId(presets: readonly DocFormatPreset[]): string {
  const used = new Set(presets.map((p) => p.id));
  for (let n = 1; ; n++) {
    const id = `custom-${n}`;
    if (!used.has(id)) return id;
  }
}

export const useDocFormatStore = create<DocFormatState>((set, get) => ({
  presets: BUILTIN_FORMATS,
  defaultId: reconcile(BUILTIN_FORMATS, savedDefault()),
  selectedId: reconcile(BUILTIN_FORMATS, savedDefault()),
  hydrated: false,

  hydrate: async () => {
    if (get().hydrated) return;
    let custom: DocFormatPreset[] = [];
    try {
      custom = await loadCustomFormats();
    } catch (e) {
      // 读不出自建预设不该让这一页打不开：内置那几套永远在。
      console.warn("[docx] 自建排版格式读取失败，只显示内置的：", e);
    }
    set((s) => {
      const imitated = s.presets.filter((p) => p.imitatedFrom);
      const presets = [...BUILTIN_FORMATS, ...custom, ...imitated];
      return {
        presets,
        hydrated: true,
        defaultId: reconcile(presets, savedDefault()),
        selectedId: reconcile(presets, s.selectedId),
      };
    });
  },

  setDefault: (id) => {
    writePref(PREF_KEY, id);
    set({ defaultId: id });
  },
  select: (id) => set({ selectedId: id }),

  saveFormat: async (preset) => {
    await saveCustomFormat(preset);
    set((s) => {
      const presets = s.presets.some((p) => p.id === preset.id)
        ? s.presets.map((p) => (p.id === preset.id ? preset : p))
        // 自建的排在内置之后、模仿来的之前，和设置页的分组一致
        : [...s.presets.filter((p) => !p.imitatedFrom), preset, ...s.presets.filter((p) => p.imitatedFrom)];
      return { presets, selectedId: preset.id };
    });
  },

  removeFormat: async (id) => {
    await deleteCustomFormat(id);
    set((s) => {
      const presets = s.presets.filter((p) => p.id !== id);
      const defaultId = reconcile(presets, s.defaultId);
      // 删掉的正好是默认——默认必须落回一个真实存在的预设，并且**写回偏好**，
      // 否则下次启动读到的还是那个死 id。
      if (defaultId !== s.defaultId) writePref(PREF_KEY, defaultId);
      return { presets, defaultId, selectedId: reconcile(presets, s.selectedId) };
    });
  },

  duplicate: async (id) => {
    const { presets } = get();
    const source = presets.find((p) => p.id === id);
    if (!source) return null;
    const copy: DocFormatPreset = {
      id: nextCustomId(presets),
      label: copyLabel(source.label, presets.map((p) => p.label)),
      builtin: false,
      format: structuredClone(source.format) as DocFormat,
    };
    await get().saveFormat(copy);
    return copy.id;
  },

  addImitated: (preset) =>
    set((s) => ({
      presets: [...s.presets.filter((p) => p.id !== preset.id), preset],
      selectedId: preset.id,
    })),
}));

/**
 * 非 React 侧（agent 工具、briefing）要的那两样。读的是当下的 store，不是模块
 * 加载时的快照——预设列表会变。
 */
export function currentFormats(): { presets: DocFormatPreset[]; defaultId: string } {
  const { presets, defaultId } = useDocFormatStore.getState();
  return { presets, defaultId };
}
