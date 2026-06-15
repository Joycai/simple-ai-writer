import { useState } from "react";
import { useAiStore } from "../../stores/aiStore";
import { useProjectStore } from "../../stores/projectStore";
import type { ApiStandard, ModelType } from "../../lib/aiConfig";
import styles from "./SettingsModal.module.css";

const API_STANDARDS: { value: ApiStandard; label: string }[] = [
  { value: "openai", label: "OpenAI" },
  { value: "openai_compat", label: "OpenAI Compatible" },
  { value: "gemini", label: "Google Gemini" },
];

const MODEL_TYPES: { value: ModelType; label: string }[] = [
  { value: "text", label: "文本" },
  { value: "multimodal", label: "多模态" },
  { value: "image", label: "图像生成" },
  { value: "video", label: "视频" },
];

// ─── Providers Tab ────────────────────────────────────────────────────────────

function ProvidersTab() {
  const { projectPath } = useProjectStore();
  const { providers, addProvider, removeProvider } = useAiStore();
  const [form, setForm] = useState({ name: "", baseUrl: "", apiStandard: "openai" as ApiStandard, apiKey: "" });
  const [saving, setSaving] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const handleAdd = async () => {
    if (!projectPath || !form.name || !form.apiKey) return;
    setSaving(true);
    try {
      await addProvider(projectPath, { name: form.name, baseUrl: form.baseUrl, apiStandard: form.apiStandard }, form.apiKey);
      setForm({ name: "", baseUrl: "", apiStandard: "openai", apiKey: "" });
      setShowForm(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>已配置供应商</div>
        {providers.length === 0 && <div className={styles.emptyNote}>暂无供应商，点击下方添加</div>}
        <div className={styles.itemList}>
          {providers.map((p) => (
            <div key={p.id} className={styles.item}>
              <div className={styles.itemInfo}>
                <div className={styles.itemName}>{p.name}</div>
                <div className={styles.itemMeta}>{p.baseUrl || "(默认端点)"} · {p.apiStandard}</div>
              </div>
              <span className={styles.badge}>{p.apiStandard}</span>
              <button className={styles.deleteBtn} onClick={() => projectPath && removeProvider(projectPath, p.id)}>✕</button>
            </div>
          ))}
        </div>
      </div>

      {showForm ? (
        <div className={styles.form}>
          <div className={styles.sectionTitle}>添加供应商</div>
          <div className={styles.formRow}>
            <div className={styles.fieldGroup}>
              <label className={styles.label}>名称</label>
              <input className={styles.input} placeholder="OpenAI" value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className={styles.fieldGroup}>
              <label className={styles.label}>API 标准</label>
              <select className={styles.select} value={form.apiStandard}
                onChange={(e) => setForm({ ...form, apiStandard: e.target.value as ApiStandard })}>
                {API_STANDARDS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </div>
          </div>
          <div className={styles.fieldGroup}>
            <label className={styles.label}>Base URL (留空使用默认)</label>
            <input className={styles.input} placeholder="https://api.openai.com/v1" value={form.baseUrl}
              onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} />
          </div>
          <div className={styles.fieldGroup}>
            <label className={styles.label}>API Key</label>
            <input className={styles.input} type="password" placeholder="sk-…" value={form.apiKey}
              onChange={(e) => setForm({ ...form, apiKey: e.target.value })} />
          </div>
          <div className={styles.formActions}>
            <button className={styles.btnSecondary} onClick={() => setShowForm(false)}>取消</button>
            <button className={styles.btnPrimary} onClick={handleAdd}
              disabled={!form.name || !form.apiKey || saving}>
              {saving ? "保存中…" : "保存"}
            </button>
          </div>
        </div>
      ) : (
        <button className={styles.btnPrimary} onClick={() => setShowForm(true)}>+ 添加供应商</button>
      )}
    </div>
  );
}

// ─── Models Tab ───────────────────────────────────────────────────────────────

function ModelsTab() {
  const { projectPath } = useProjectStore();
  const { providers, models, addModel, removeModel, fetchAndImportModels } = useAiStore();
  const [form, setForm] = useState({ providerId: "", modelId: "", name: "", type: "text" as ModelType, priceIn: "", priceCachedIn: "", priceOut: "" });
  const [showForm, setShowForm] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [fetchedList, setFetchedList] = useState<{ id: string; name: string }[]>([]);
  const [saving, setSaving] = useState(false);

  const handleFetch = async () => {
    if (!projectPath || !form.providerId) return;
    setFetching(true);
    try {
      const list = await fetchAndImportModels(projectPath, form.providerId);
      setFetchedList(list);
    } catch (e) {
      alert(String(e));
    } finally {
      setFetching(false);
    }
  };

  const handleAdd = async () => {
    if (!projectPath || !form.providerId || !form.modelId) return;
    setSaving(true);
    try {
      await addModel(projectPath, {
        providerId: form.providerId,
        modelId: form.modelId,
        name: form.name || form.modelId,
        type: form.type,
        priceIn: parseFloat(form.priceIn) || 0,
        priceCachedIn: parseFloat(form.priceCachedIn) || 0,
        priceOut: parseFloat(form.priceOut) || 0,
        enabled: true,
      });
      setForm({ providerId: "", modelId: "", name: "", type: "text", priceIn: "", priceCachedIn: "", priceOut: "" });
      setShowForm(false);
      setFetchedList([]);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>已配置模型</div>
        {models.length === 0 && <div className={styles.emptyNote}>暂无模型</div>}
        <div className={styles.itemList}>
          {models.map((m) => {
            const pname = providers.find((p) => p.id === m.providerId)?.name ?? m.providerId;
            return (
              <div key={m.id} className={styles.item}>
                <div className={styles.itemInfo}>
                  <div className={styles.itemName}>{m.name}</div>
                  <div className={styles.itemMeta}>{pname} · {m.modelId}</div>
                </div>
                <span className={styles.badge}>{m.type}</span>
                <button className={styles.deleteBtn} onClick={() => projectPath && removeModel(projectPath, m.id)}>✕</button>
              </div>
            );
          })}
        </div>
      </div>

      {showForm ? (
        <div className={styles.form}>
          <div className={styles.sectionTitle}>添加模型</div>
          <div className={styles.formRow}>
            <div className={styles.fieldGroup}>
              <label className={styles.label}>供应商</label>
              <select className={styles.select} value={form.providerId}
                onChange={(e) => { setForm({ ...form, providerId: e.target.value }); setFetchedList([]); }}>
                <option value="">选择供应商…</option>
                {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div className={styles.fieldGroup}>
              <label className={styles.label}>模型类型</label>
              <select className={styles.select} value={form.type}
                onChange={(e) => setForm({ ...form, type: e.target.value as ModelType })}>
                {MODEL_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
          </div>

          {form.providerId && (
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button className={styles.fetchBtn} onClick={handleFetch} disabled={fetching}>
                {fetching ? "拉取中…" : "从 API 拉取可用模型"}
              </button>
              {fetchedList.length > 0 && (
                <select className={styles.select} style={{ flex: 1 }}
                  onChange={(e) => { const m = fetchedList.find(x => x.id === e.target.value); if (m) setForm(f => ({ ...f, modelId: m.id, name: m.name })); }}>
                  <option value="">选择…</option>
                  {fetchedList.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              )}
            </div>
          )}

          <div className={styles.formRow}>
            <div className={styles.fieldGroup}>
              <label className={styles.label}>Model ID</label>
              <input className={styles.input} placeholder="gpt-4o" value={form.modelId}
                onChange={(e) => setForm({ ...form, modelId: e.target.value })} />
            </div>
            <div className={styles.fieldGroup}>
              <label className={styles.label}>显示名称</label>
              <input className={styles.input} placeholder="GPT-4o" value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
          </div>

          <div className={styles.sectionTitle} style={{ marginBottom: 0 }}>计费 (USD / 1M tokens)</div>
          <div className={styles.formRow}>
            {[
              { key: "priceIn", label: "输入" },
              { key: "priceCachedIn", label: "缓存输入" },
              { key: "priceOut", label: "输出" },
            ].map(({ key, label }) => (
              <div key={key} className={styles.fieldGroup}>
                <label className={styles.label}>{label}</label>
                <input className={styles.input} type="number" min="0" step="0.01" placeholder="0.00"
                  value={(form as Record<string, string>)[key]}
                  onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
              </div>
            ))}
          </div>

          <div className={styles.formActions}>
            <button className={styles.btnSecondary} onClick={() => { setShowForm(false); setFetchedList([]); }}>取消</button>
            <button className={styles.btnPrimary} onClick={handleAdd} disabled={!form.providerId || !form.modelId || saving}>
              {saving ? "保存中…" : "添加"}
            </button>
          </div>
        </div>
      ) : (
        <button className={styles.btnPrimary} onClick={() => setShowForm(true)}>+ 添加模型</button>
      )}
    </div>
  );
}

// ─── Prompts Tab ──────────────────────────────────────────────────────────────

function PromptsTab() {
  const { projectPath } = useProjectStore();
  const { prompts, addPrompt, removePrompt } = useAiStore();
  const [form, setForm] = useState({ name: "", content: "", scene: "system" });
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);

  const handleAdd = async () => {
    if (!projectPath || !form.name || !form.content) return;
    setSaving(true);
    try {
      await addPrompt(projectPath, form);
      setForm({ name: "", content: "", scene: "system" });
      setShowForm(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>预置 Prompt</div>
        {prompts.length === 0 && <div className={styles.emptyNote}>暂无预置 Prompt</div>}
        <div className={styles.itemList}>
          {prompts.map((p) => (
            <div key={p.id} className={styles.item}>
              <div className={styles.itemInfo}>
                <div className={styles.itemName}>{p.name}</div>
                <div className={styles.itemMeta} style={{ maxWidth: 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.content}</div>
              </div>
              <span className={styles.badge}>{p.scene}</span>
              <button className={styles.deleteBtn} onClick={() => projectPath && removePrompt(projectPath, p.id)}>✕</button>
            </div>
          ))}
        </div>
      </div>

      {showForm ? (
        <div className={styles.form}>
          <div className={styles.sectionTitle}>新建 Prompt</div>
          <div className={styles.formRow}>
            <div className={styles.fieldGroup}>
              <label className={styles.label}>名称</label>
              <input className={styles.input} placeholder="古风写作风格" value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className={styles.fieldGroup}>
              <label className={styles.label}>场景</label>
              <select className={styles.select} value={form.scene}
                onChange={(e) => setForm({ ...form, scene: e.target.value })}>
                {["system", "continue", "polish", "rewrite", "summary"].map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
          </div>
          <div className={styles.fieldGroup}>
            <label className={styles.label}>内容</label>
            <textarea className={styles.input} rows={4} placeholder="你是一位擅长古风写作的助手…"
              value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })}
              style={{ resize: "vertical", fontFamily: "inherit" }} />
          </div>
          <div className={styles.formActions}>
            <button className={styles.btnSecondary} onClick={() => setShowForm(false)}>取消</button>
            <button className={styles.btnPrimary} onClick={handleAdd} disabled={!form.name || !form.content || saving}>
              {saving ? "保存中…" : "添加"}
            </button>
          </div>
        </div>
      ) : (
        <button className={styles.btnPrimary} onClick={() => setShowForm(true)}>+ 新建 Prompt</button>
      )}
    </div>
  );
}

// ─── Main modal ───────────────────────────────────────────────────────────────

const TABS = [
  { id: "providers", label: "供应商" },
  { id: "models", label: "模型" },
  { id: "prompts", label: "Prompt" },
];

interface Props {
  onClose: () => void;
}

export function SettingsModal({ onClose }: Props) {
  const [activeTab, setActiveTab] = useState("providers");

  return (
    <div className={styles.overlay} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={styles.modal}>
        <div className={styles.header}>
          <span className={styles.title}>⚙️ AI 配置</span>
          <button className={styles.closeBtn} onClick={onClose}>✕</button>
        </div>

        <div className={styles.tabs}>
          {TABS.map((t) => (
            <button key={t.id} className={`${styles.tab} ${activeTab === t.id ? styles.active : ""}`}
              onClick={() => setActiveTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>

        <div className={styles.content}>
          {activeTab === "providers" && <ProvidersTab />}
          {activeTab === "models" && <ModelsTab />}
          {activeTab === "prompts" && <PromptsTab />}
        </div>
      </div>
    </div>
  );
}
