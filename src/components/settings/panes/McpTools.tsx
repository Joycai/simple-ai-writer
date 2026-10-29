import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, ChevronDown, Copy, Search } from "lucide-react";
import { isObject } from "../../../lib/mcp/config";
import type { McpTool } from "../../../lib/mcp/client";
import styles from "./McpManagement.module.css";
export function McpTools({ tools }: { tools: McpTool[] }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [copied, setCopied] = useState("");
  const copy = async (value: string) => {
    try { await navigator.clipboard.writeText(value); setCopied(t("mcp.manage.copied")); }
    catch { setCopied(t("mcp.manage.copyFailed")); }
  };
  const filtered = tools.filter(tool => `${tool.name} ${tool.description ?? ""}`.toLowerCase().includes(query.toLowerCase()));
  return <><div className={styles.search}><Search size={15} /><input aria-label={t("mcp.manage.searchTools")} placeholder={t("mcp.manage.searchTools")} value={query} onChange={e => setQuery(e.target.value)} /></div>
    {!filtered.length && <p className={styles.empty}>{t(tools.length ? "mcp.manage.noMatches" : "mcp.manage.noTools")}</p>}
    {filtered.map(tool => <details className={styles.tool} key={tool.name}><summary><ChevronRight size={16} className={styles.closedIcon} /><ChevronDown size={16} className={styles.openIcon} /><div><code>{tool.name}</code><p>{tool.description}</p></div></summary><div className={styles.toolBody}>
      <div className={styles.actions}><button onClick={() => void copy(tool.name)}><Copy size={13} />{t("mcp.manage.copyName")}</button><button onClick={() => void copy(JSON.stringify(tool.inputSchema, null, 2))}><Copy size={13} />{t("mcp.manage.copySchema")}</button></div>
      {isObject(tool.inputSchema.properties) && Object.keys(tool.inputSchema.properties).length > 0 ? <div className={styles.tableScroll}><table><thead><tr><th>{t("mcp.manage.parameter")}</th><th>{t("mcp.manage.type")}</th><th>{t("mcp.manage.description")}</th></tr></thead><tbody>{Object.entries(tool.inputSchema.properties).map(([name, value]) => <tr key={name}><td><code>{name}</code>{Array.isArray(tool.inputSchema.required) && tool.inputSchema.required.includes(name) && <small className={styles.required}>{t("mcp.manage.required")}</small>}</td><td>{isObject(value) && typeof value.type === "string" ? value.type : t("mcp.manage.complex")}</td><td>{isObject(value) && typeof value.description === "string" ? value.description : "—"}{isObject(value) && (value.enum !== undefined || value.default !== undefined || value.properties !== undefined || value.items !== undefined || value.oneOf !== undefined || value.$ref !== undefined) && <details><summary>{t("mcp.manage.constraints")}</summary><pre>{JSON.stringify(value, null, 2)}</pre></details>}</td></tr>)}</tbody></table></div> : <p>{t("mcp.manage.schemaHint")}</p>}
      <details className={styles.schema}><summary>{t("mcp.manage.rawSchema")}</summary><pre>{JSON.stringify(tool.inputSchema, null, 2)}</pre></details>
    </div></details>)}<span role="status">{copied}</span></>;
}
