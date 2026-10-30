import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ModelTextInput } from "./ModelDrawerBits";
import { Slider } from "../../common/Slider";
import { formatTokenLimit, parseTokenLimit, TOKEN_STEP, TOKEN_STOPS } from "./tokenLimit";
import s from "./TokenLimitControl.module.css";

interface Props {
  value: string;
  onChange: (value: string) => void;
  max: number;
  fallback?: number;
  label: string;
}

export function TokenLimitControl({ value, onChange, max, fallback, label }: Props) {
  const { t } = useTranslation();
  const hintId = useId();
  const track = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(276);
  useEffect(() => {
    const element = track.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const parsed = parseTokenLimit(value, max);
  const effective = parsed || fallback || TOKEN_STEP;
  const sliderMax = Math.min(max, 1048576);
  const stops = TOKEN_STOPS.filter((n) => n <= sliderMax);
  const select = (n: number) => onChange(formatTokenLimit(n));
  return <div className={s.control}>
    <div className={s.row}>
    <div ref={track} className={s.slider}>
      <Slider width={width} value={Math.min(sliderMax, Math.max(TOKEN_STOPS[0], effective))}
        min={TOKEN_STOPS[0]} max={sliderMax} step={TOKEN_STEP} scale="log2"
        ticks={stops.map((n) => ({ value: n, label: formatTokenLimit(n) }))} snapToTicks selectableTicks
        onChange={select} ariaLabel={label} valueText={formatTokenLimit(effective)} />
    </div>
    <ModelTextInput className={s.input} unset={parsed === 0} value={value}
      placeholder={fallback ? formatTokenLimit(fallback) : t("aiConfig.hub.exactValue")}
      aria-label={label} aria-describedby={hintId} aria-invalid={parsed === null || undefined}
      onChange={(e) => onChange(e.target.value)}
      onBlur={() => { if (parsed !== null) onChange(parsed ? formatTokenLimit(parsed) : ""); }} />
    </div>
    <span id={hintId} className={`${s.hint} ${parsed === null ? s.error : ""}`}>
      {t(parsed === null ? "aiConfig.models.tokenLimitInvalid" : "aiConfig.models.tokenLimitHint", { max: formatTokenLimit(max) })}
    </span>
  </div>;
}
