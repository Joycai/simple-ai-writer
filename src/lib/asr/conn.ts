/**
 * 绑定的转写模型 + 它的端点 + 凭据，或者说清为什么没有。
 *
 * 照 `lib/translate/tool.ts` 的 `resolveTranslateConn`：动态 import aiStore，因为
 * `lib/` 不反向依赖 `stores/`，而这里确实要读作者在设置里绑了什么。
 */

import type { Model, Provider } from "../ai/configDb";
import { loadApiKey } from "../keyStore";
import { subAgentModel } from "../agent/subagent";
import type { AsrConn } from "./client";

export interface ResolvedAsr extends AsrConn {
  provider: Provider;
  model: Model;
}

/** 为什么用不了，给作者看的（i18n 在 UI 层做，这里是给模型 / 日志的英文）。 */
export type AsrUnavailable =
  | { reason: "unbound"; error: string }
  | { reason: "provider-gone"; error: string }
  | { reason: "no-key"; error: string };

export async function resolveAsrConn(): Promise<ResolvedAsr | AsrUnavailable> {
  const { useAiStore } = await import("../../stores/aiStore");
  const { models, providers, subAgents } = useAiStore.getState();

  const model = subAgentModel("asr", models, subAgents);
  if (!model) {
    return {
      reason: "unbound",
      error:
        "the transcription subagent is not usable. Tell the author to enable it in Settings → 子代理 " +
        "and bind a model whose 转写模型格式 is set (Settings → 供应商与模型).",
    };
  }
  const provider = providers.find((p) => p.id === model.providerId);
  if (!provider) {
    return { reason: "provider-gone", error: `the provider serving "${model.name}" is gone. Tell the author to re-add it.` };
  }
  // 和翻译模型不同，这条路只通向 DashScope，没有 key 的本地端点不存在——空 key
  // 在这里是配置错误，报出来比让上传接口回一个 401 更早、更准。
  const apiKey = (await loadApiKey(provider.id)) ?? "";
  if (!apiKey) {
    return { reason: "no-key", error: `the provider serving "${model.name}" has no API key. Tell the author to set one.` };
  }
  return { provider, model, apiKey, baseUrl: provider.baseUrl, modelId: model.modelId };
}

export function isAsrUnavailable(r: ResolvedAsr | AsrUnavailable): r is AsrUnavailable {
  return "reason" in r;
}
