/**
 * The hint under a declaration the current route will not send — the PDF and
 * video switches, which stay visible (and able to be turned off) because the
 * declaration is the model's and outlives a route switch
 * (channel-model-route-plan §7 第 4 条; capability-gating-plan §2.4).
 *
 * Nothing here decides: the verdict's reason code is the table's answer, and
 * this only picks the sentence (§2.3 — sentences live in the locale files).
 * "This route has no spelling for it" is true of one reason only, `family`;
 * since the video cells (C4) a `no` is as often a platform measured refusing
 * the part, or one nobody measured, and each says so in its own words.
 */
import type { TFunction } from "i18next";

import type { CapabilityReason } from "../../../lib/ai/capabilities";
import type { PlatformId } from "../../../lib/ai/platforms";
import type { RelayUpstreamId } from "../../../lib/ai/relayUpstream";

interface NotSentContext {
  /** The route's long name (「Chat Completions」…), for the `family` sentence. */
  route: string;
  platform: PlatformId;
  modelId: string;
  /** The relay upstream the verdict was asked with, if any. */
  upstream?: RelayUpstreamId;
}

/** Why a declared capability is not sent on this route, in the author's words. */
export function declNotSentNote(t: TFunction, reason: CapabilityReason, ctx: NotSentContext): string {
  if (reason === "family") return t("aiConfig.models.declNotOnRoute", { route: ctx.route });
  const upstream = ctx.upstream ? t(`aiConfig.upstream.name.${ctx.upstream}`) : "";
  if (reason === "upstream" && upstream) return t("aiConfig.upstream.notSent", { upstream });
  const why = t(`aiConfig.capReason.${reason}`, {
    platform: t(`aiConfig.platforms.${ctx.platform}`), model: ctx.modelId, upstream,
  });
  return t("aiConfig.models.declNotSent", { why });
}
