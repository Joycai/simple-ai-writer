/**
 * 计费组编辑抽屉 — 设计稿 05l 屏 1b / 1c / 1d。
 *
 * 一条不变量决定了这个组件的形状：**切计价方式只换下面的字段区，不清空
 * 别的方式的值**。所以表单是一个完整的 `FeeGroup`（三种模式的字段全在），
 * 分段控件只改 `billingMode`；切到按规格再切回按 token，三个 token 价还在。
 *
 * 另外两处措辞上的讲究：
 * - 缓存价的占位符写「＝ 输入价」而不是「0」——留空是「跟输入价一样」，
 *   填 0 是「缓存真免费」，两件事差着整笔钱。
 * - 档位表三个条件的占位符写「任意」——空条件匹配一切，不是「忘了填」。
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";

import {
  BILLING_MODES, OUTPUT_UNITS,
  type BillingMode, type FeeGroup, type OutputUnit, type SpecRate,
} from "../../../lib/ai/feeGroup";
import { chargesInputImages, feeConfigOf } from "../../../lib/ai/feeGroup";
import { feeSummary, hasCatchAllRate, isPriced } from "../../../lib/ai/feeGroupLabel";
import { useFeeLabelWords } from "./feeWords";
import hub from "./ProvidersModels.module.css";
import s from "./FeeGroups.module.css";
import ui from "../settingsUi.module.css";

/** 空着的格画虚线：它说的是「没填」，而填了 0 的格是实线——0 是一个决定。 */
function numField(value: string, onChange: (v: string) => void, placeholder: string, bad = false) {
  const unset = value.trim() === "";
  return { value, placeholder, onChange, unset, bad };
}

type NumFieldProps = ReturnType<typeof numField>;

/**
 * 金额靠右、条件靠左。
 *
 * 右对齐是给**数**用的（一列金额的小数点要成一条线）；档位表里的尺寸与
 * 质量是词，右对齐会让它们的读序和相邻那一列的数字互相拉扯。
 */
function NumInput({ value, placeholder, onChange, unset, bad, align = "right" }: NumFieldProps & { align?: "left" | "right" }) {
  return (
    <input
      className={`${hub.input} ${s.cell} ${hub.mono} ${unset ? hub.unset : ""} ${bad ? s.badPrice : ""}`}
      type="text"
      inputMode={align === "right" ? "decimal" : "text"}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      style={{ textAlign: align }}
    />
  );
}

/** 表单里价格一律是字符串：受控数字输入框清空后会变成 NaN，而「清空」是
 *  作者的一次编辑中途，不该当场变成 0。保存时才落成数。 */
interface Draft {
  name: string;
  billingMode: BillingMode;
  inputPrice: string;
  cacheInputPrice: string;
  outputPrice: string;
  requestPrice: string;
  outputUnit: OutputUnit;
  rates: { size: string; quality: string; seconds: string; price: string }[];
  inputUnitPrice: string;
  inputFreeUnits: string;
}

const numStr = (n: number | null | undefined): string =>
  n === null || n === undefined || !Number.isFinite(n) ? "" : String(n);

function toDraft(g: FeeGroup | null): Draft {
  return {
    name: g?.name ?? "",
    billingMode: g?.billingMode ?? "token",
    inputPrice: numStr(g?.inputPrice),
    // null（＝同输入价）与 0（＝真免费）在表单里也必须分得开：前者是空串。
    cacheInputPrice: g?.cacheInputPrice === null || g?.cacheInputPrice === undefined ? "" : String(g.cacheInputPrice),
    outputPrice: numStr(g?.outputPrice),
    requestPrice: numStr(g?.requestPrice),
    outputUnit: g?.outputUnit ?? "image",
    rates: (g?.outputRates ?? []).map((r) => ({
      size: r.size ?? "", quality: r.quality ?? "",
      seconds: r.seconds === undefined ? "" : String(r.seconds),
      price: numStr(r.price),
    })),
    inputUnitPrice: numStr(g?.inputUnitPrice),
    inputFreeUnits: numStr(g?.inputFreeUnits),
  };
}

const num = (v: string): number => {
  const n = parseFloat(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

/** 保存时才落成 `FeeGroup`。条件的归一化留给存储层（`serializeSpecRates`
 *  之后 `parseSpecRates` 读回来时过一遍），匹配那一侧才敢是纯相等。 */
export function draftToGroup(d: Draft): Omit<FeeGroup, "id" | "createdAt"> {
  const rates: SpecRate[] = d.rates.map((r) => {
    const out: SpecRate = { price: num(r.price) };
    if (r.size.trim()) out.size = r.size.trim();
    if (r.quality.trim()) out.quality = r.quality.trim();
    const sec = parseInt(r.seconds, 10);
    if (Number.isFinite(sec) && sec > 0) out.seconds = sec;
    return out;
  });
  return {
    name: d.name.trim(),
    billingMode: d.billingMode,
    inputPrice: num(d.inputPrice),
    cacheInputPrice: d.cacheInputPrice.trim() === "" ? null : num(d.cacheInputPrice),
    outputPrice: num(d.outputPrice),
    requestPrice: num(d.requestPrice),
    outputUnit: d.outputUnit,
    outputRates: rates,
    inputUnitPrice: num(d.inputUnitPrice),
    inputFreeUnits: Math.floor(num(d.inputFreeUnits)),
  };
}

export function FeeGroupDrawer({
  group,
  boundModels,
  onSave,
  onClose,
}: {
  /** null ＝ 新建。 */
  group: FeeGroup | null;
  boundModels: number;
  onSave: (g: Omit<FeeGroup, "id" | "createdAt">) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const words = useFeeLabelWords();
  const [d, setD] = useState<Draft>(() => toDraft(group));
  const [saving, setSaving] = useState(false);
  const patch = (p: Partial<Draft>) => setD((prev) => ({ ...prev, ...p }));
  const setRate = (i: number, p: Partial<Draft["rates"][number]>) =>
    setD((prev) => ({ ...prev, rates: prev.rates.map((r, j) => (j === i ? { ...r, ...p } : r)) }));

  const resolved: FeeGroup = { ...draftToGroup(d), id: group?.id ?? "", createdAt: group?.createdAt ?? 0 };
  const fee = feeConfigOf(resolved);
  // 只有「这一行没填价」是真错误：整行按 0 计，而作者以为自己配好了。
  const badRate = (i: number) => d.billingMode === "spec" && num(d.rates[i].price) <= 0;
  const blocked = d.billingMode === "spec" && d.rates.some((_, i) => badRate(i));

  const save = async () => {
    if (blocked || saving) return;
    setSaving(true);
    try {
      await onSave(draftToGroup(d));
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const unitHint = t(`aiConfig.fees.unitHint.${d.outputUnit}`);

  return (
    <div className={hub.drawer} role="dialog" aria-label={t("aiConfig.fees.drawerTitle")}>
      <div className={hub.drawerHead}>
        <div style={{ minWidth: 0 }}>
          <div className={hub.drawerTitle}>
            {group ? t("aiConfig.fees.editTitle") : t("aiConfig.fees.addTitle")}
          </div>
          <div className={hub.drawerSub}>{t("aiConfig.fees.drawerSub", { n: boundModels })}</div>
        </div>
        <span className={hub.footSpacer} />
        <button className={hub.iconBtn} onClick={onClose} title={t("common.cancel")}>
          <X size={16} />
        </button>
      </div>

      <div className={hub.drawerBody}>
        <div>
          <div className={ui.sectionLabel}>{t("aiConfig.fees.nameLabel")}</div>
          <input
            className={hub.input}
            value={d.name}
            placeholder={t("aiConfig.fees.namePlaceholder")}
            onChange={(e) => patch({ name: e.target.value })}
          />
        </div>

        <div>
          <div className={ui.sectionLabel}>{t("aiConfig.fees.modeLabel")}</div>
          <div className={s.seg} style={{ marginTop: "var(--space-2)" }}>
            {BILLING_MODES.map((m) => (
              <button
                key={m}
                type="button"
                className={`${s.segBtn} ${d.billingMode === m ? s.segOn : ""}`}
                onClick={() => patch({ billingMode: m })}
              >
                {t(`aiConfig.fees.modes.${m}`)}
              </button>
            ))}
          </div>
          <div className={s.hint}>{t(`aiConfig.fees.modeHint.${d.billingMode}`)}</div>
        </div>

        {d.billingMode === "token" && (
          <div>
            <div className={ui.sectionLabel}>
              {t("aiConfig.fees.tokenPrices")} · {t("aiConfig.fees.perMillionUnit")}
            </div>
            <div className={s.triple} style={{ marginTop: "var(--space-2)" }}>
              {([
                ["inputPrice", t("aiConfig.fees.input"), "0"],
                ["cacheInputPrice", t("aiConfig.fees.cached"), t("aiConfig.fees.cachePlaceholder")],
                ["outputPrice", t("aiConfig.fees.output"), "0"],
              ] as const).map(([key, label, ph]) => (
                <div key={key}>
                  <NumInput {...numField(d[key], (v) => patch({ [key]: v } as Partial<Draft>), ph)} />
                  <div className={`${s.cellSub} ${d[key].trim() === "" ? s.cellSubUnset : ""}`}>{label}</div>
                </div>
              ))}
            </div>
            <div className={s.hint}>{t("aiConfig.fees.cacheHint")}</div>
          </div>
        )}

        {d.billingMode === "request" && (
          <div>
            <div className={ui.sectionLabel}>{t("aiConfig.fees.requestPrice")}</div>
            <div style={{ marginTop: "var(--space-2)", maxWidth: 160 }}>
              <NumInput {...numField(d.requestPrice, (v) => patch({ requestPrice: v }), "0")} />
            </div>
            <div className={s.hint}>{t("aiConfig.fees.requestHint")}</div>
          </div>
        )}

        {d.billingMode === "spec" && (
          <div>
            <div className={ui.sectionLabel}>{t("aiConfig.fees.unitLabel")}</div>
            <div className={s.unitRow} style={{ marginTop: "var(--space-2)" }}>
              {OUTPUT_UNITS.map((u) => (
                <button
                  key={u}
                  type="button"
                  className={`${ui.chip} ${d.outputUnit === u ? ui.chipActive : ""}`}
                  onClick={() => patch({ outputUnit: u })}
                >
                  {t(`aiConfig.fees.units.${u}`)}
                </button>
              ))}
            </div>
            <div className={s.hint}>{unitHint}</div>

            <div className={ui.sectionLabel} style={{ marginTop: "var(--space-4)" }}>
              {t("aiConfig.fees.rateTable")}
            </div>
            <div className={s.rateGrid} style={{ marginTop: "var(--space-2)" }}>
              <div className={s.rateHead}>{t("aiConfig.fees.colSize")}</div>
              <div className={s.rateHead}>{t("aiConfig.fees.colQuality")}</div>
              <div className={s.rateHead}>{t("aiConfig.fees.colSeconds")}</div>
              <div className={`${s.rateHead} ${s.rateHeadRight}`}>{t("aiConfig.fees.colPrice")}</div>
              <div />
            </div>
            {d.rates.map((r, i) => (
              <div className={`${s.rateGrid} ${s.rateRow}`} key={i}>
                <NumInput {...numField(r.size, (v) => setRate(i, { size: v }), t("aiConfig.fees.anyValue"))} align="left" />
                <NumInput {...numField(r.quality, (v) => setRate(i, { quality: v }), t("aiConfig.fees.anyValue"))} align="left" />
                <NumInput {...numField(r.seconds, (v) => setRate(i, { seconds: v }), t("aiConfig.fees.anyValue"))} align="left" />
                <NumInput {...numField(r.price, (v) => setRate(i, { price: v }), "0", badRate(i))} />
                <button
                  type="button"
                  className={s.drop}
                  onClick={() => setD((p) => ({ ...p, rates: p.rates.filter((_, j) => j !== i) }))}
                  aria-label={t("aiConfig.fees.dropRate")}
                >
                  ×
                </button>
              </div>
            ))}
            <button
              type="button"
              className={s.addRate}
              onClick={() => setD((p) => ({ ...p, rates: [...p.rates, { size: "", quality: "", seconds: "", price: "" }] }))}
            >
              {t("aiConfig.fees.addRate")}
            </button>
            <div className={s.hint}>
              {hasCatchAllRate(resolved) ? t("aiConfig.fees.rateHintCatchAll") : t("aiConfig.fees.rateHintNoCatchAll")}
            </div>
          </div>
        )}

        {d.billingMode !== "token" && (
          <div className={s.inputSide}>
            <div className={ui.sectionLabel}>
              {d.billingMode === "spec" && d.outputUnit === "image"
                ? t("aiConfig.fees.inputImagesRef")
                : t("aiConfig.fees.inputImagesFrame")}
            </div>
            <div className={s.pair} style={{ marginTop: "var(--space-2)" }}>
              <div>
                <NumInput {...numField(d.inputUnitPrice, (v) => patch({ inputUnitPrice: v }), "0")} />
                <div className={s.cellSub}>{t("aiConfig.fees.inputUnitPrice")}</div>
              </div>
              <div>
                <NumInput {...numField(d.inputFreeUnits, (v) => patch({ inputFreeUnits: v }), "0")} />
                <div className={s.cellSub}>{t("aiConfig.fees.inputFreeUnits")}</div>
              </div>
            </div>
            <div className={s.hint}>
              {chargesInputImages(fee) ? t("aiConfig.fees.inputHintOn") : t("aiConfig.fees.inputHintOff")}
            </div>
          </div>
        )}
      </div>

      <div className={hub.drawerFoot}>
        <div className={`${s.summary} ${isPriced(resolved) ? "" : s.summaryUnset}`}>
          {feeSummary(resolved, words)}
        </div>
        <button className={ui.rowBtn} onClick={onClose}>{t("common.cancel")}</button>
        <button className={ui.primaryBtn} onClick={save} disabled={blocked || saving}>
          {t("common.save")}
        </button>
      </div>
    </div>
  );
}
