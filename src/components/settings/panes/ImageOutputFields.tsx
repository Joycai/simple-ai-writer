import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ImageCaps } from "../../../lib/ai/configDb";
import { imageOutputSpec, type ImageParamSelection, type ImagePixelConstraints, type ImageSizingMode } from "../../../lib/ai/imageDialects";
import { Field, ToggleField } from "./ModelDrawerBits";
import { Select } from "../../common/Select";
import s from "./ModelDrawer.module.css";

type OutputConfig = Pick<ImageCaps, "overrides" | "defaults">;

/** Keep punctuation while typing, but publish parsed choices on every change
 * so saving without leaving this field still uses the latest values.
 */
export function ImageOutputMenuInput({ label, values, onChange }: {
  label: string;
  values: string[] | undefined;
  onChange: (values: string[]) => void;
}) {
  const [draft, setDraft] = useState(() => ({ values, text: values?.join(", ") ?? "" }));
  // A replacement configuration resets the text; our own parsed array keeps
  // its identity through the parent, preserving the author's unfinished edit.
  if (draft.values !== values) setDraft({ values, text: values?.join(", ") ?? "" });
  return <input className={s.input} aria-label={label} value={draft.text}
    onChange={(e) => {
      const text = e.target.value;
      const next = [...new Set(text.split(",").map((x) => x.trim()).filter(Boolean))];
      setDraft({ values: next, text });
      onChange(next);
    }} />;
}

/** Preset inheritance stays explicit; editing a menu never changes API field names. */
export function ImageOutputFields({ dialect, value, onChange }: {
  dialect: ImageCaps["dialect"];
  value: OutputConfig;
  onChange: (value: OutputConfig) => void;
}) {
  const { t } = useTranslation();
  const spec = imageOutputSpec({ dialect, ...value });
  const defaults = value.defaults ?? {};
  const canExact = dialect !== "nanobanana" && dialect !== "nanobanana-2" && dialect !== "grok-imagine";
  const setDefault = (key: keyof ImageParamSelection, next: string) => {
    const updated = { ...defaults, [key]: next };
    if (key === "sizingMode" && !next) delete updated.sizingMode;
    onChange({ ...value, defaults: updated });
  };
  const menu = (key: "aspects" | "resolutions" | "qualities") => (
    <Field label={t(`imageOutput.${key}`)} hint={t("imageOutput.listHint")}>
      <ImageOutputMenuInput label={t(`imageOutput.${key}`)} values={value.overrides?.[key]}
        onChange={(next) => onChange({ ...value, overrides: { ...value.overrides, [key]: next } })} />
    </Field>
  );
  const defaultMenu = (key: "aspect" | "resolution" | "quality", choices: readonly string[]) => (
    <Field label={t(`imageOutput.default_${key}`)} hint="">
      <Select className={s.fieldSelect} value={defaults[key] ?? ""}
        options={[{ value: "", label: t("imageOutput.default") }, ...choices.filter(Boolean).map((v) => ({ value: v, label: v }))]}
        onChange={(v) => setDefault(key, v)} ariaLabel={t(`imageOutput.default_${key}`)} />
    </Field>
  );
  return <>
    <ToggleField title={t("imageOutput.customize")} hint={t("imageOutput.customizeHint")}
      on={!!value.overrides} onChange={(on) => onChange({ ...value, overrides: on ? {
        modes: [...spec.modes], aspects: [...spec.aspects], resolutions: [...spec.resolutions], qualities: [...spec.qualities], pixels: { ...spec.pixels },
      } : undefined })} />
    {value.overrides && <>
      <Field label={t("imageOutput.modes")} hint="">
        <Select className={s.fieldSelect} value={(value.overrides.modes ?? spec.modes).join(",")}
          options={[{ value: "ratio", label: t("imageOutput.ratio") }, ...(canExact ? [{ value: "exact", label: t("imageOutput.exact") }, { value: "ratio,exact", label: t("imageOutput.both") }] : [])]}
          onChange={(v) => onChange({ ...value, overrides: { ...value.overrides, modes: v.split(",") as ImageSizingMode[] } })}
          ariaLabel={t("imageOutput.modes")} />
      </Field>
      {menu("aspects")}{menu("resolutions")}{menu("qualities")}
      {(["step", "minEdge", "maxEdge", "minPixels", "maxPixels", "maxRatio"] as const).map((key: keyof ImagePixelConstraints) =>
        <Field key={key} label={t(`imageOutput.${key}`)} hint={t("imageOutput.limitHint")}>
          <input className={s.input} aria-label={t(`imageOutput.${key}`)} type="number" min={1} step={key === "maxRatio" ? "any" : 1}
            value={value.overrides?.pixels?.[key] ?? ""}
            onChange={(e) => {
              const pixels = { ...value.overrides?.pixels };
              if (!e.target.value) delete pixels[key];
              else pixels[key] = Number(e.target.value);
              onChange({ ...value, overrides: { ...value.overrides, pixels } });
            }} />
        </Field>)}
    </>}
    <Field label={t("imageOutput.default_mode")} hint="">
      <Select className={s.fieldSelect} value={defaults.sizingMode ?? ""}
        options={[{ value: "", label: t("imageOutput.default") }, ...spec.modes.map((v) => ({ value: v, label: t(`imageOutput.${v}`) }))]}
        onChange={(v) => setDefault("sizingMode", v)} ariaLabel={t("imageOutput.default_mode")} />
    </Field>
    {spec.modes.includes("ratio") && <>{defaultMenu("aspect", spec.aspects)}{defaultMenu("resolution", spec.resolutions)}</>}
    {spec.qualities.length > 0 && defaultMenu("quality", spec.qualities)}
    {spec.modes.includes("exact") && <Field label={t("imageOutput.default_size")} hint={t("imageOutput.sizeHint")}>
      <input className={s.input} aria-label={t("imageOutput.default_size")} placeholder="1536x1024" value={defaults.size ?? ""} onChange={(e) => setDefault("size", e.target.value)} />
    </Field>}
  </>;
}
