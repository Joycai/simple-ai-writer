/**
 * 「转换文档」这一个动作，给渲染它的每一枚按钮共用——顶栏的 `ConvertButton` 和
 * 编辑区说明页（`FileNotice`）上的那一枚。
 *
 * 两枚按钮同时在场（打开一份 `.docx` 时顶栏和页面各有一枚），所以进行中必须是
 * 同一份状态：`convertJobs` 按路径记着，点了哪一枚，另一枚都跟着变「转换中…」。
 * 文件树右键的入口不走这里——它有自己的横幅回执，只共用 `convertJobs` 的占位。
 */

import { useProjectStore } from "../../stores/projectStore";
import { convertProjectFile } from "../../lib/import";
import { isSamePath } from "../../lib/paths";
import { beginConvert, convertBlocker, endConvert, useConvertJobs } from "./convertJobs";

export function useConvertDoc(path: string) {
  const refreshFileTree = useProjectStore((s) => s.refreshFileTree);
  const setActiveFilePath = useProjectStore((s) => s.setActiveFilePath);
  const jobs = useConvertJobs();
  // 同一文件夹里正在转的那一份（可能就是自己）——在就等（见 convertJobs 文首）。
  const blocker = convertBlocker(jobs, path);
  const waitingOn = blocker !== null && !isSamePath(blocker, path) ? blocker : null;
  const failed = jobs.failed && isSamePath(jobs.failed.path, path) ? jobs.failed : null;

  /** Resolves to the failure's reason, or `null` when it converted (or was already running). */
  const run = async (): Promise<string | null> => {
    if (!beginConvert(path)) return null;
    const project = useProjectStore.getState().projectPath;
    let failure: string | undefined;
    try {
      const target = await convertProjectFile(path);
      // 转换途中换了项目：新项目的树不用刷，转出来的那一篇也不属于它，不跳过去。
      if (useProjectStore.getState().projectPath !== project) return null;
      await refreshFileTree();
      // 成功不留痕迹：转出来的那一篇立刻成为当前文档，面包屑自己就把话说了。
      setActiveFilePath(target);
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e);
    } finally {
      endConvert(path, failure);
    }
    return failure ?? null;
  };

  return { run, busy: blocker !== null, waitingOn, failed };
}
