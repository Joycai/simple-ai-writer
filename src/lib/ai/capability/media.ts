/**
 * Media admission: which kinds of media a request on this route, to this
 * model, may carry (docs/feature/video-input.md §「历史里的媒体按请求放行」).
 *
 * The one answer. The request plan holds it (`RequestPlan.media`) and
 * `streamCompletion` projects every message through it before an adapter
 * sees the request; the composer's attach gates (`canReadVideo`, `readsPdf`)
 * and the settings page's 将发送 summary ask the same function. Before, the
 * attach gates asked the tables on their own and nothing asked again at send
 * time — so a clip attached under one model stayed in the history and went
 * out, every turn, to whatever model the author switched to next.
 *
 * Two halves, both required:
 *   - **the model's declaration** — what the author said the model reads: its
 *     type (does it see pictures at all), `videoInput`, `pdfInput`. No probe
 *     can ask without spending a real payload.
 *   - **the route** — whether this wire has a spelling for the part at all, and
 *     on this platform was seen to read it (the `videoInput` / `pdfInput`
 *     capability cells). Every family spells a picture.
 */

import type { ModelType } from "../configDb";
import type { MediaKind } from "../mediaParts";
import type { Wire } from "../platforms";
import { hasCapability, type CapabilityModel } from "./resolve";
import { SEES_IMAGES } from "./rules";

/** Per kind, whether this request may carry it. */
export type MediaAdmission = Readonly<Record<MediaKind, boolean>>;

/**
 * What the model row declares about media. `connOptions()` fills all three
 * from the row; each is absent only in a hand-built bag (a probe, a live test,
 * a unit test), whose parts are the caller's own — there only the route half
 * applies.
 */
interface MediaDeclaration {
  modelType?: ModelType;
  videoInput?: boolean;
  pdfInput?: boolean;
}

/**
 * 这个模型能不能看图 —— 请求里能不能放 base64 图片、读图工具能不能在场、看图
 * 子代理能不能绑它，问的都是这一个问题（媒体放行里模型的那一半；configDb 再导出）。
 *
 * 两个类型都算：「多模态」是会看图的通用对话模型（qwen3.8-flash、deepseek-flash），
 * 「视觉理解」是专门看图的模型（qwen3-vl-*、qwen-vl-ocr）。两者在线上完全一样
 * （同一个 `image_url` 片段，docs/api/landscape.md §6），区别只在 app 里：视觉
 * 理解模型不当写手（`subAgentModel` 的 writer 分支）。一个有名字的判据而不是散在
 * 二十处的 `type === "multimodal"`，因为漏改一处就是一个看得见图却被当成纯文本
 * 的模型，而且什么都不报。
 */
export function canSeeImages(m: { type?: ModelType }): boolean {
  return m.type !== undefined && SEES_IMAGES.includes(m.type);
}

/**
 * The one answer: which media kinds this route × this model admits.
 *
 * `model` is the plan's capability model (id, relay upstream); its `type` is
 * taken from the declaration, so the tables' `modelTypes` rules see it.
 */
export function admittedMedia(wire: Wire, model: CapabilityModel, declared: MediaDeclaration): MediaAdmission {
  const typed: CapabilityModel = declared.modelType === undefined ? model : { ...model, type: declared.modelType };
  return {
    image: declared.modelType === undefined || canSeeImages({ type: declared.modelType }),
    video: declared.videoInput !== false && hasCapability("videoInput", wire, typed),
    pdf: declared.pdfInput !== false && hasCapability("pdfInput", wire, typed),
  };
}
