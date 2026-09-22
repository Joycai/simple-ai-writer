/**
 * 计费组标签的措辞，从 i18n 取出来递给 `lib/ai/feeGroupLabel` 的纯函数。
 *
 * 分出来是为了那边能在 node 环境的测试里直接跑：价格的写法是「记错钱但不
 * 报错」的一类，值得有测试钉着，而钉它不该需要一个 i18n 实例。
 */
import { useTranslation } from "react-i18next";

import type { FeeLabelWords } from "../../../lib/ai/feeGroupLabel";
import type { OutputUnit } from "../../../lib/ai/feeGroup";

export function useFeeLabelWords(): FeeLabelWords {
  const { t } = useTranslation();
  const perUnit = {} as Record<OutputUnit, string>;
  for (const u of ["image", "second", "clip"] as OutputUnit[]) {
    perUnit[u] = t(`aiConfig.fees.perUnit.${u}`);
  }
  return {
    token: t("aiConfig.fees.modes.token"),
    request: t("aiConfig.fees.modes.request"),
    perUnit,
    perMillion: t("aiConfig.fees.perMillion"),
    perRequest: t("aiConfig.fees.perRequestSuffix"),
    input: t("aiConfig.fees.input"),
    cached: t("aiConfig.fees.cached"),
    output: t("aiConfig.fees.output"),
    tiers: (n: number) => t("aiConfig.fees.tiers", { n }),
    noRates: t("aiConfig.fees.noRates"),
    otherSpecsZero: t("aiConfig.fees.otherSpecsZero"),
    inputImage: (price: string) => t("aiConfig.fees.inputImageTag", { price }),
    inputFree: (n: number) => t("aiConfig.fees.inputFreeTag", { n }),
    unbound: t("aiConfig.fees.unbound"),
  };
}
