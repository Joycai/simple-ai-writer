/** Model identity is a fallback, never an override of an author's declaration. */
import type { ImageCaps, Model } from "./configDb";
import type { ImageDialect } from "./imageDialects";

export function inferImageFamily(modelId: string): ImageDialect | undefined {
  const id = modelId.toLowerCase();
  if (/gpt[-_. ]image[-_. ]2[.-]5(?:\b|_)/.test(id)) return "gpt-image-2.5";
  if (/gpt[-_. ]image[-_. ]2(?:\b|_)/.test(id)) return "gpt-image-2";
  if (/nano[-_ ]?banana[-_ ]?2(?:\b|_)|gemini[-_.]3[.-]1[-_.]flash[-_.]image(?:\b|_)/.test(id)) return "nanobanana-2";
  if (/nano[-_ ]?banana|gemini[-_.](?:2[.-]5[-_.]flash|3[-_.]pro)[-_.]image/.test(id)) return "nanobanana";
  if (/grok[-_.]imagine[-_.]image/.test(id)) return "grok-imagine";
  if (/seedream[-_.]5[.-]0[-_.](?:pro|flash)/.test(id)) return "seedream-5-pro";
  if (/seedream[-_.]5[.-]0[-_.]lite/.test(id)) return "seedream-5-lite";
  if (/seedream[-_.]4[.-][05]/.test(id)) return "seedream-4";
  if (/wan2[.-]7[-_.]image/.test(id)) return "wan2.7";
  if (/qwen[-_.]image[-_.][23][.-]0/.test(id)) return "qwen-image";
  return undefined;
}

/** Derived values stay out of persistence; generic explicitly disables ID inference. */
export function resolvedImageCaps(modelId: string, caps?: ImageCaps): ImageCaps | undefined {
  if (caps?.route === "comfyui") return caps;
  const dialect = caps?.dialect ?? inferImageFamily(modelId);
  if (!dialect) return caps;
  const maxRefs = dialect === "nanobanana-2" ? 14
    : dialect === "seedream-5-pro" ? 10
      : dialect === "seedream-5-lite" || dialect === "seedream-4" ? 14 : undefined;
  return { ...(dialect !== "generic" ? { edit: dialect !== "grok-imagine" } : {}),
    ...(maxRefs ? { maxRefs } : {}), ...caps, dialect };
}

export function withImageFamily<T extends Pick<Model, "modelId" | "caps">>(model: T): T {
  return { ...model, caps: resolvedImageCaps(model.modelId, model.caps) };
}
