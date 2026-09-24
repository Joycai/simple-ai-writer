/**
 * 中转站上游 — the channel drawer's prefix table and the model drawer's
 * 「上游」 section (task spec 03-ui-spec; capability-gating-plan §8.11).
 *
 * Shown only on a relay platform (New API / 自定义): a relay fronts several
 * upstreams, and which one a model is behind decides what it can do. The
 * prefixes are the relay owner's own names, so they are the author's data,
 * typed here — the code only knows the upstreams and what each was measured
 * doing (`lib/ai/relayUpstream.ts`, `UPSTREAM_CAPABILITIES`).
 *
 * Wording: 「渠道」 is the provider row; 「上游」 is what sits behind a relay
 * (docs/reference/terminology.md).
 */
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { Select } from "../../common/Select";
import { Field, Section } from "./ModelDrawerBits";
import { UPSTREAM_CAPABILITIES, upstreamApplies } from "../../../lib/ai/capabilities";
import {
  RELAY_UPSTREAMS, bracketPrefixes,
  type RelayUpstreamChoice, type RelayUpstreamId, type ResolvedUpstream,
} from "../../../lib/ai/relayUpstream";
import styles from "../settingsCommon.module.css";
import u from "./Upstream.module.css";

/** Which upstreams forward the official API, and which translate it — the two groups of every menu. */
const FORWARD: ReadonlySet<RelayUpstreamId> = new Set(["bedrock", "official", "azure"]);

function upstreamOptions(t: (k: string) => string): { value: string; label: string; group: string }[] {
  return RELAY_UPSTREAMS.map((id) => ({
    value: id,
    label: id === "official"
      ? `${t(`aiConfig.upstream.name.${id}`)} · ${t("aiConfig.upstream.unmeasured")}`
      : t(`aiConfig.upstream.name.${id}`),
    group: t(FORWARD.has(id) ? "aiConfig.upstream.kindForward" : "aiConfig.upstream.kindReverse"),
  }));
}

/** One row as edited: the upstream may not be picked yet. */
export interface PrefixRow {
  prefix: string;
  upstream: RelayUpstreamId | "";
}

type RowError = "dup" | "empty" | "noUpstream";

/**
 * What is wrong with each row, if anything. A row left entirely blank is not
 * an error — it is the one just added. Saving drops every flagged row, in the
 * order `parseUpstreamPrefixes` does: only a complete row claims its prefix,
 * so a half-typed row above never makes the complete one below a duplicate.
 */
export function rowErrors(rows: readonly PrefixRow[]): (RowError | undefined)[] {
  const seen = new Set<string>();
  return rows.map((r) => {
    const p = r.prefix.trim().toLowerCase();
    if (!p && !r.upstream) return undefined;
    if (!p) return "empty";
    if (!r.upstream) return "noUpstream";
    if (seen.has(p)) return "dup";
    seen.add(p);
    return undefined;
  });
}

/** 渠道抽屉 · 上游: the author's table of prefixes, plus the unmapped ones this channel's models start with. */
export function UpstreamPrefixTable({
  rows, onChange, modelIds,
}: {
  rows: PrefixRow[];
  onChange: (rows: PrefixRow[]) => void;
  /** The ids of this channel's models, for the 「还有」 suggestions. */
  modelIds: readonly string[];
}) {
  const { t } = useTranslation();
  const errors = rowErrors(rows);
  const found = bracketPrefixes(modelIds, rows);
  const set = (i: number, patch: Partial<PrefixRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const options = upstreamOptions(t);
  return (
    <div className={styles.fieldGroup}>
      <label className={styles.label}>{t("aiConfig.upstream.label")}</label>
      {/* A group, not an ARIA table: every control carries its own label, and
          the add button and error lines would not fit a table's cells. */}
      <div className={u.table} role="group" aria-label={t("aiConfig.upstream.label")}>
        {rows.length > 0 && (
          <div className={`${u.row} ${u.head}`} aria-hidden>
            <span>{t("aiConfig.upstream.prefixCol")}</span>
            <span>{t("aiConfig.upstream.upstreamCol")}</span>
            <span />
          </div>
        )}
        {rows.map((row, i) => (
          <div key={i} className={u.item}>
            <div className={`${u.row} ${errors[i] ? u.rowErr : ""}`}>
              <input
                className={u.prefix}
                value={row.prefix}
                placeholder={t("aiConfig.upstream.prefixPlaceholder")}
                aria-label={t("aiConfig.upstream.prefixCol")}
                onChange={(e) => set(i, { prefix: e.target.value })}
              />
              <Select
                className={u.pick}
                value={row.upstream}
                options={options}
                placeholder={t("aiConfig.upstream.pick")}
                ariaLabel={t("aiConfig.upstream.upstreamCol")}
                onChange={(v) => set(i, { upstream: v as RelayUpstreamId })}
              />
              <button type="button" className={u.del} aria-label={t("aiConfig.upstream.remove")}
                onClick={() => onChange(rows.filter((_, j) => j !== i))}>
                <X size={12} strokeWidth={2} />
              </button>
            </div>
            {errors[i] && <div className={u.err}>{t(`aiConfig.upstream.err.${errors[i]}`)}</div>}
          </div>
        ))}
        <button type="button" className={u.add} onClick={() => onChange([...rows, { prefix: "", upstream: "" }])}>
          + {t("aiConfig.upstream.addPrefix")}
        </button>
      </div>
      {found.length > 0 && (
        <div className={u.found}>
          <span>{t("aiConfig.upstream.found")}</span>
          {found.map((p) => (
            <button key={p} type="button" className={u.foundChip}
              onClick={() => onChange([...rows.filter((r) => r.prefix.trim() || r.upstream), { prefix: p, upstream: "" }])}>
              {p}
            </button>
          ))}
        </div>
      )}
      <div className={styles.hint}>{t("aiConfig.upstream.upstreamHint")}</div>
    </div>
  );
}

/** The resolved upstream in words, with where it came from. */
function sourceLine(t: (k: string, o?: Record<string, string>) => string, r: ResolvedUpstream, modelId: string): string {
  const name = r.upstream ? t(`aiConfig.upstream.name.${r.upstream}`) : "";
  if (r.source === "prefix") return t("aiConfig.upstream.src.prefix", { upstream: name, prefix: r.prefix ?? "" });
  if (r.source === "inferred") return t("aiConfig.upstream.src.inferred", { upstream: name, word: r.word ?? "" });
  if (r.source === "model") return r.upstream ? t("aiConfig.upstream.src.model") : t("aiConfig.upstream.src.modelNone");
  const bracket = /^\[[^\]\s]+\]/.exec(modelId.trim())?.[0];
  return bracket ? t("aiConfig.upstream.src.unsetBracket", { prefix: bracket }) : t("aiConfig.upstream.src.unset");
}

/** 模型抽屉 · 上游: follow the channel, or choose; says what it resolved to and what that upstream was measured doing. */
export function UpstreamSection({
  open, onToggle, choice, onChoice, resolved, followed, modelId,
}: {
  open: boolean;
  onToggle: () => void;
  /** The model's own choice; absent = follow the channel. */
  choice: RelayUpstreamChoice | undefined;
  onChoice: (c: RelayUpstreamChoice | undefined) => void;
  /** What the model resolves to now, choice included. */
  resolved: ResolvedUpstream;
  /** What following the channel would resolve to — the 「跟随渠道」 option's 「现在」. */
  followed: ResolvedUpstream;
  modelId: string;
}) {
  const { t } = useTranslation();
  const up = resolved.upstream;
  const applies = !!up && upstreamApplies(up, modelId);
  const followNow = followed.upstream ? t(`aiConfig.upstream.name.${followed.upstream}`) : t("aiConfig.upstream.src.unset");
  const options = [
    { value: "", label: t("aiConfig.upstream.followNow", { upstream: followNow }) },
    ...upstreamOptions(t),
    { value: "none", label: `${t("aiConfig.upstream.none")} · ${t("aiConfig.upstream.noneSub")}`, group: t("aiConfig.upstream.kindOther") },
  ];
  const summary = up
    ? t(`aiConfig.upstream.name.${up}`)
    : t(resolved.source === "model" ? "aiConfig.upstream.sumNone" : "aiConfig.upstream.sumUnset");
  return (
    <Section label={t("aiConfig.upstream.label")} open={open} onToggle={onToggle} summary={summary} unset={!up}>
      <Field
        label={t("aiConfig.upstream.label")}
        hint={up ? t(`aiConfig.upstream.note.${up}`) : t("aiConfig.upstream.modelHint")}
        note={sourceLine(t, resolved, modelId)}
        noteTone={resolved.source === "inferred" || !up ? "faint" : "ok"}
        warn={up && modelId.trim() && !applies
          ? t("aiConfig.upstream.notCovered", { models: UPSTREAM_CAPABILITIES[up].modelsLabel })
          : undefined}
      >
        <Select
          className={choice === undefined ? u.follow : undefined}
          value={choice ?? ""}
          options={options}
          ariaLabel={t("aiConfig.upstream.label")}
          onChange={(v) => onChoice(v === "" ? undefined : (v as RelayUpstreamChoice))}
        />
      </Field>
    </Section>
  );
}
