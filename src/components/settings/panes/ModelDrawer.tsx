import { useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { useAiStore } from "../../../stores/aiStore";
import { familyOf, type ImageRoute } from "../../../lib/ai/types";
import {
  REASONING_EFFORTS, THINKING_DIALECTS, supportsThinkingLevel,
  type ReasoningEffort, type ThinkingDialect,
} from "../../../lib/ai/reasoning";
import { defaultImageCaps, MAX_CONTEXT_SIZE, MAX_OUTPUT_SIZE, type ModelType } from "../../../lib/ai/configDb";
import { CONTEXT_SIZE_STOPS, formatContextSize } from "../../../lib/ai/contextSize";
import { ModelProbePanel } from "../ModelProbePanel";
import { Chip, ChipRow } from "./bits";
import styles from "../settingsCommon.module.css";
import hub from "./ProvidersModels.module.css";

const MODEL_TYPES: ModelType[] = ["text", "multimodal", "image", "video"];

interface Props {
  /** The group this drawer was opened from — a model cannot change hands. */
  providerId: string;
  /** null = add a new model under `providerId`. */
  modelId: string | null;
  onClose: () => void;
}

export function ModelDrawer({ providerId, modelId, onClose }: Props) {
  const { t } = useTranslation();
  const { providers, models, addModel, updateModel, fetchAndImportModels } = useAiStore();
  const existing = modelId ? models.find((m) => m.id === modelId) : undefined;
  const provider = providers.find((p) => p.id === providerId);

  const [form, setForm] = useState({
    modelId: existing?.modelId ?? "",
    name: existing?.name ?? "",
    type: existing?.type ?? ("text" as ModelType),
    priceIn: existing?.priceIn ? String(existing.priceIn) : "",
    priceCachedIn: existing?.priceCachedIn ? String(existing.priceCachedIn) : "",
    priceOut: existing?.priceOut ? String(existing.priceOut) : "",
    prefix: existing?.prefix ?? "",
    contextSize: existing?.contextSize ? String(existing.contextSize) : "",
    maxOutput: existing?.maxOutput ? String(existing.maxOutput) : "",
    pricePerImage: existing?.pricePerImage ? String(existing.pricePerImage) : "",
    capsSizes: (existing?.caps?.sizes ?? []).join(", "),
    capsRoute: existing?.caps?.route ?? "",
    reasoningEffort: existing?.reasoningEffort ?? ("default" as ReasoningEffort),
    // "" = 未声明，按协议族推导 —— 与存储上的 undefined 一一对应。
    thinkingDialect: (existing?.thinkingDialect ?? "") as ThinkingDialect | "",
  });
  // When the two limits came from a probe rather than the keyboard — kept out
  // of `form` because it is provenance, not something the author edits.
  const [probedAt, setProbedAt] = useState<number | undefined>(existing?.probedAt);
  // Out of `form` for a different reason: the price row below casts `form` to
  // Record<string, string> to index its fields, which a boolean would break.
  const [capsEdit, setCapsEdit] = useState(existing?.caps?.edit ?? false);
  const [fetching, setFetching] = useState(false);
  const [fetchedList, setFetchedList] = useState<{ id: string; name: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFetch = async () => {
    setFetching(true);
    setError(null);
    try {
      setFetchedList(await fetchAndImportModels(providerId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setFetching(false);
    }
  };

  const handleSave = async () => {
    if (!form.modelId) return;
    setSaving(true);
    setError(null);
    try {
      const parsedCtx = Math.min(MAX_CONTEXT_SIZE, Math.max(0, Math.floor(parseInt(form.contextSize, 10) || 0)));
      const contextSize = parsedCtx > 0 ? parsedCtx : undefined;
      const parsedOut = Math.min(MAX_OUTPUT_SIZE, Math.max(0, Math.floor(parseInt(form.maxOutput, 10) || 0)));
      const maxOutput = parsedOut > 0 ? parsedOut : undefined;
      // Image-only settings. Cleared for other types so a model that used to be
      // an image model doesn't keep billing per image after being switched.
      const isImageModel = form.type === "image";
      const parsedPerImage = parseFloat(form.pricePerImage);
      const pricePerImage = isImageModel && parsedPerImage > 0 ? parsedPerImage : undefined;
      const sizes = form.capsSizes.split(",").map((s) => s.trim()).filter(Boolean);
      const caps = isImageModel
        ? {
            edit: capsEdit,
            ...(sizes.length ? { sizes } : {}),
            ...(form.capsRoute ? { route: form.capsRoute as ImageRoute } : {}),
          }
        : undefined;
      const shared = {
        providerId,
        modelId: form.modelId,
        name: form.name || form.modelId,
        type: form.type,
        priceIn: parseFloat(form.priceIn) || 0,
        priceCachedIn: parseFloat(form.priceCachedIn) || 0,
        priceOut: parseFloat(form.priceOut) || 0,
        prefix: form.prefix.trim() || undefined,
        contextSize,
        maxOutput,
        probedAt,
        // "default" is stored as absent — one representation for "send
        // nothing", so a row never distinguishes never-set from set-to-default.
        reasoningEffort: form.reasoningEffort === "default" ? undefined : form.reasoningEffort,
        thinkingDialect: form.thinkingDialect || undefined,
        pricePerImage,
        caps,
      };
      if (existing) {
        await updateModel({ ...existing, ...shared });
      } else {
        await addModel({ ...shared, enabled: true });
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={hub.drawer} role="dialog" aria-label={t("aiConfig.models.addTitle")}>
      <div className={hub.drawerHead}>
        <div style={{ minWidth: 0 }}>
          <div className={hub.drawerTitle}>
            {existing ? t("aiConfig.models.editTitle") : t("aiConfig.models.addTitle")}
          </div>
          <div className={hub.drawerSub}>
            {t("aiConfig.hub.belongsTo", { provider: provider?.name ?? providerId })}
          </div>
        </div>
        <span className={hub.footSpacer} />
        <button className={hub.iconBtn} onClick={onClose} title={t("aiConfig.models.cancel")}>
          <X size={16} />
        </button>
      </div>

      <div className={hub.drawerBody}>
        {error && <div className={styles.errorNote}>{error}</div>}

        {!existing && (
          <div className={styles.fetchRow}>
            <button className={styles.fetchBtn} onClick={handleFetch} disabled={fetching}>
              {fetching ? t("aiConfig.models.fetching") : t("aiConfig.models.fetchBtn")}
            </button>
            {fetchedList.length > 0 && (
              <select className={`${styles.select} ${styles.fetchRowSelect}`}
                onChange={(e) => {
                  const m = fetchedList.find((x) => x.id === e.target.value);
                  if (m) setForm((f) => ({ ...f, modelId: m.id, name: m.name }));
                }}>
                <option value="">{t("aiConfig.models.selectOption")}</option>
                {fetchedList.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            )}
          </div>
        )}

        <div className={styles.formRow}>
          <div className={styles.fieldGroup}>
            <label className={styles.label}>{t("aiConfig.models.modelIdLabel")}</label>
            <input className={`${styles.input} ${hub.mono}`} placeholder="gpt-4o" value={form.modelId}
              onChange={(e) => setForm({ ...form, modelId: e.target.value })} />
          </div>
          <div className={styles.fieldGroup}>
            <label className={styles.label}>{t("aiConfig.models.displayNameLabel")}</label>
            <input className={styles.input} placeholder="GPT-4o" value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
        </div>

        <div className={styles.fieldGroup}>
          <label className={styles.label}>{t("aiConfig.models.typeLabel")}</label>
          <ChipRow>
            {MODEL_TYPES.map((type) => (
              <Chip
                key={type}
                label={t(`aiConfig.modelTypes.${type}`)}
                active={form.type === type}
                onClick={() => {
                  setForm({ ...form, type });
                  // Seed the edit capability from the provider's protocol the
                  // first time this becomes an image model, so the common case
                  // needs no thought and the odd one is still overridable.
                  if (type === "image" && !existing && provider) {
                    setCapsEdit(defaultImageCaps(provider.apiStandard).edit ?? false);
                  }
                }}
              />
            ))}
          </ChipRow>
        </div>

        <div className={styles.fieldGroup}>
          <label className={styles.label}>{t("aiConfig.models.billing")}</label>
          <div className={styles.formRow}>
            {[
              { key: "priceIn", label: t("aiConfig.models.priceInput") },
              { key: "priceCachedIn", label: t("aiConfig.models.priceCachedInput") },
              { key: "priceOut", label: t("aiConfig.models.priceOutput") },
            ].map(({ key, label }) => (
              <div key={key} className={styles.fieldGroup}>
                <input className={styles.input} type="number" min="0" step="0.01" placeholder="0.00"
                  value={(form as Record<string, string>)[key]}
                  onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
                <span className={styles.label}>{label}</span>
              </div>
            ))}
          </div>
        </div>

        {form.type === "image" && (
          <>
            <div className={styles.formRow}>
              <div className={styles.fieldGroup}>
                <label className={styles.label}>{t("aiConfig.models.pricePerImageLabel")}</label>
                <input className={styles.input} type="number" min="0" step="0.001" placeholder="0.00"
                  value={form.pricePerImage}
                  onChange={(e) => setForm({ ...form, pricePerImage: e.target.value })} />
                <div className={hub.fieldHint}>{t("aiConfig.models.pricePerImageHint")}</div>
              </div>
              <div className={styles.fieldGroup}>
                <label className={styles.label}>{t("aiConfig.models.capsSizesLabel")}</label>
                <input className={styles.input} placeholder="1024x1024, 1536x1024"
                  value={form.capsSizes}
                  onChange={(e) => setForm({ ...form, capsSizes: e.target.value })} />
                <div className={hub.fieldHint}>{t("aiConfig.models.capsSizesHint")}</div>
              </div>
            </div>
            <div className={styles.fieldGroup}>
              <label className={styles.label}>{t("aiConfig.models.capsRouteLabel")}</label>
              <select className={styles.select} value={form.capsRoute}
                onChange={(e) => setForm({ ...form, capsRoute: e.target.value })}>
                <option value="">{t("aiConfig.models.capsRouteAuto")}</option>
                <option value="images-api">{t("aiConfig.models.capsRouteImages")}</option>
                <option value="chat">{t("aiConfig.models.capsRouteChat")}</option>
                <option value="gemini">{t("aiConfig.models.capsRouteGemini")}</option>
              </select>
              <div className={hub.fieldHint}>{t("aiConfig.models.capsRouteHint")}</div>
            </div>
            <div className={styles.fieldGroup}>
              <label className={hub.checkLabel}>
                <input type="checkbox" checked={capsEdit} onChange={(e) => setCapsEdit(e.target.checked)} />
                {t("aiConfig.models.capsEditLabel")}
              </label>
              <div className={hub.fieldHint}>{t("aiConfig.models.capsEditHint")}</div>
            </div>
          </>
        )}

        {/* Context window, output cap, probing and the prefix prompt are all
            token-shaped concepts an image endpoint has no notion of. */}
        {form.type !== "image" && (
          <>
            <div className={styles.fieldGroup}>
              <label className={styles.label}>{t("aiConfig.models.contextSizeLabel")}</label>
              {/* Chips for the windows models actually ship with, plus a field
                  for the odd exact value (200k Claude, 64k local builds…). */}
              <ChipRow>
                <Chip
                  label={t("aiConfig.models.contextSizeUnset", { defaultValue: "未设置" })}
                  active={form.contextSize === ""}
                  onClick={() => setForm({ ...form, contextSize: "" })}
                />
                {CONTEXT_SIZE_STOPS.map((n) => (
                  <Chip
                    key={n}
                    label={formatContextSize(n)}
                    active={form.contextSize === String(n)}
                    onClick={() => setForm({ ...form, contextSize: String(n) })}
                  />
                ))}
                <input
                  className={hub.ctxExact}
                  type="number" min="0" max={MAX_CONTEXT_SIZE} step="1024"
                  placeholder={t("aiConfig.hub.exactValue")}
                  value={form.contextSize}
                  onChange={(e) => setForm({ ...form, contextSize: e.target.value })}
                  aria-label={t("aiConfig.models.contextSizeLabel")}
                />
              </ChipRow>
              <div className={hub.fieldHint}>{t("aiConfig.models.contextSizeHint")}</div>
            </div>

            <div className={styles.fieldGroup}>
              <label className={styles.label}>{t("aiConfig.models.maxOutputLabel")}</label>
              <input
                className={styles.input}
                type="number" min="0" max={MAX_OUTPUT_SIZE} step="512"
                placeholder={t("aiConfig.models.contextSizeUnset", { defaultValue: "未设置" })}
                value={form.maxOutput}
                onChange={(e) => setForm({ ...form, maxOutput: e.target.value })} />
              <div className={hub.fieldHint}>{t("aiConfig.models.maxOutputHint")}</div>
            </div>

            {/* Which shape of thinking parameter this model takes. Anthropic
                only: within that family the parameter changed between model
                generations, and on a relay the model id is free text, so the
                generation can't be derived — the author declares it. */}
            {provider && familyOf(provider.apiStandard) === "anthropic" && (
              <div className={styles.fieldGroup}>
                <label className={styles.label}>{t("aiConfig.models.thinkingDialectLabel")}</label>
                <div className={ui.chipRow}>
                  {(["", ...THINKING_DIALECTS] as const).map((d) =>
                    chip(
                      d === ""
                        ? t("aiConfig.models.thinkingDialectAuto")
                        : t(`aiConfig.models.thinkingDialect${d[0].toUpperCase()}${d.slice(1)}`),
                      form.thinkingDialect === d,
                      () => setForm({ ...form, thinkingDialect: d }),
                      d || "auto",
                    ),
                  )}
                </div>
                <div className={hub.fieldHint}>{t("aiConfig.models.thinkingDialectHint")}</div>
              </div>
            )}

            {/* Rendering this for a protocol whose adapter would ignore it
                would offer a setting that silently does nothing — the same
                reason defaultImageCaps refuses to promise an edit button.
                Widen as each family's mapping lands. */}
            {provider && supportsThinkingLevel(provider.apiStandard) && (
              <div className={styles.fieldGroup}>
                <label className={styles.label}>{t("aiConfig.models.reasoningEffortLabel")}</label>
                <ChipRow>
                  {REASONING_EFFORTS.map((e) => (
                    <Chip
                      key={e}
                      label={t(`aiConfig.models.reasoningEffort${e[0].toUpperCase()}${e.slice(1)}`)}
                      active={form.reasoningEffort === e}
                      onClick={() => setForm({ ...form, reasoningEffort: e })}
                    />
                  ))}
                </ChipRow>
                <div className={hub.fieldHint}>{t("aiConfig.models.reasoningEffortHint")}</div>
              </div>
            )}

            <ModelProbePanel
              providerId={providerId}
              modelId={form.modelId}
              contextSize={form.contextSize}
              maxOutput={form.maxOutput}
              priceIn={form.priceIn}
              priceOut={form.priceOut}
              onApply={(v) => {
                // Only overwrite a field the probe actually resolved — a run that
                // learned nothing about output length must leave that value alone.
                setForm((f) => ({
                  ...f,
                  contextSize: v.contextSize !== undefined ? String(v.contextSize) : f.contextSize,
                  maxOutput: v.maxOutput !== undefined ? String(v.maxOutput) : f.maxOutput,
                }));
                setProbedAt(v.probedAt);
              }}
            />
            {probedAt && (
              <div className={hub.fieldHint}>
                {t("aiConfig.probe.probedAt", { date: new Date(probedAt).toLocaleString() })}
              </div>
            )}

            <div className={styles.fieldGroup}>
              <label className={styles.label}>{t("aiConfig.models.prefixLabel")}</label>
              <textarea
                className={`${styles.input} ${styles.textarea} ${hub.proseArea}`}
                rows={4}
                placeholder={t("aiConfig.models.prefixPlaceholder")}
                value={form.prefix}
                onChange={(e) => setForm({ ...form, prefix: e.target.value })}
              />
              <div className={hub.fieldHint}>{t("aiConfig.models.prefixHint")}</div>
            </div>
          </>
        )}
      </div>

      <div className={hub.drawerFoot}>
        <span className={hub.escHint}>{t("aiConfig.hub.escToClose")}</span>
        <span className={hub.footSpacer} />
        <button className={styles.btnSecondary} onClick={onClose}>{t("aiConfig.models.cancel")}</button>
        <button className={styles.btnPrimary} onClick={handleSave} disabled={!form.modelId || saving}>
          {saving
            ? (existing ? t("aiConfig.models.editing") : t("aiConfig.models.saving"))
            : (existing ? t("aiConfig.models.edit") : t("aiConfig.models.add"))}
        </button>
      </div>
    </div>
  );
}
