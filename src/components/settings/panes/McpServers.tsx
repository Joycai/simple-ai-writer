import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { importMcpServers, isMcpEnabled, readMcpServers, removeMcpServer, setMcpEnabled, toggleMcpServer } from "../../../lib/mcp/config";
import { withMcp } from "../../../lib/mcp/client";
import { IS_TAURI } from "../../../lib/platform";
import { Row, Section, Toggle } from "./bits";
import form from "../settingsCommon.module.css";
import styles from "./McpServers.module.css";

const EXAMPLE = '{\n  "mcpServers": {\n    "joycai-images": {\n      "url": "http://127.0.0.1:39287/mcp",\n      "headers": { "Authorization": "Bearer YOUR_TOKEN" }\n    }\n  }\n}';

export function McpServers() {
  const { t } = useTranslation();
  const id = useId();
  const [on, setOn] = useState(isMcpEnabled);
  const [servers, setServers] = useState(readMcpServers);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const act = async (fn: () => Promise<string>) => {
    if (busy) return;
    setBusy(true); setStatus("");
    try { setStatus(await fn()); }
    catch { setStatus(t("mcp.failed")); }
    finally { setBusy(false); setTesting(false); controller.current = null; setServers(readMcpServers()); }
  };
  return (
    <Section label={t("mcp.title")}>
      <Row title={t("mcp.enable")} desc={t("mcp.description")}>
        <Toggle on={on} onChange={(next) => { setMcpEnabled(next); setOn(next); }} label={t("mcp.title")} />
      </Row>
      {on && <div className={styles.content}>
        <p className={form.hint}>{t(IS_TAURI ? "mcp.privacy" : "mcp.desktopOnly")}</p>
        {servers.map((server) => <div key={server.id} className={styles.server}>
          <Row title={server.name} desc={server.url} last>
            <Toggle on={server.enabled} onChange={(next) => { void act(async () => {
              await toggleMcpServer(server.id, next); return t("mcp.saved");
            }); }} label={server.name} />
          </Row>
          <div className={styles.actions}>
            <button type="button" className={form.btnSecondary} disabled={busy || !IS_TAURI}
              onClick={() => { void act(async () => {
                setTesting(true);
                controller.current = new AbortController();
                const tools = await withMcp(server, controller.current.signal, (client) => client.listTools(), 30_000);
                return t("mcp.connected", { name: server.name, count: tools.length, tools: tools.map((tool) => tool.name).join(", ") });
              }); }}>{t("mcp.test")}</button>
            <button type="button" className={form.btnSecondary} disabled={busy}
              onClick={() => { void act(async () => { await removeMcpServer(server.id); return t("mcp.removed"); }); }}>
              {t("mcp.remove")}
            </button>
          </div>
        </div>)}
        <label className={form.label} htmlFor={id}>{t("mcp.importLabel")}</label>
        <textarea id={id} className={`${form.input} ${form.textarea} ${styles.config}`} rows={8}
          value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={EXAMPLE}
          spellCheck={false} autoComplete="off" disabled={busy || !IS_TAURI} />
        <div className={styles.actions}>
          <button type="button" className={form.btnPrimary} disabled={busy || !draft.trim() || !IS_TAURI}
            onClick={() => { void act(async () => {
              await importMcpServers(draft); setDraft(""); return t("mcp.saved");
            }); }}>{t("mcp.import")}</button>
          {testing && <button type="button" className={form.btnSecondary} onClick={() => controller.current?.abort()}>{t("mcp.stop")}</button>}
        </div>
        <p role="status" aria-live="polite" className={styles.status}>{busy ? t("mcp.working") : status}</p>
      </div>}
    </Section>
  );
}
