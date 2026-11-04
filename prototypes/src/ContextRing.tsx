import { useEffect, useRef, useState } from "react";
import { ArrowUp, ChevronDown, Minimize2, X, Zap } from "lucide-react";
import "./context-ring.css";
import { ContextRing as ProductionContextRing } from "../../src/components/ai/ContextRing";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import zh from "../../src/i18n/locales/zh-CN.json";
import en from "../../src/i18n/locales/en.json";
import type { ContextBreakdown } from "../../src/lib/agent/contextBreakdown";

const reviewI18n = createInstance();
void reviewI18n.init({ lng: "zh-CN", resources: { "zh-CN": { translation: zh }, en: { translation: en } }, interpolation: { escapeValue: false } });

type Scenario = "normal" | "high" | "empty" | "running" | "unknown" | "error" | "preflight";
export function ContextRing({ production = false }: { production?: boolean }) {
  const [scenario, setScenario] = useState<Scenario>("normal");
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<"idle" | "busy" | "done" | "failed">("idle");
  const [auto, setAuto] = useState(true);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const unknown = scenario === "unknown";
  const used = scenario === "empty" ? 0 : phase === "done" ? 18.2 : scenario === "high" ? 746.7 : 28.7;
  const pct = Math.round(used / 839 * 100);
  // Same segment order and theme tokens as the production ContextBar.
  const quantities = scenario === "high" && phase !== "done"
    ? [32.4, 56, 84, 125.6, 448.7]
    : [12.4, 1.2, 0.8, 1.6, Math.max(0, used - 16)];
  const segments = [
    { key: "system", label: "系统与工具" },
    { key: "summary", label: "摘要" },
    { key: "seed", label: "种子" },
    { key: "injected", label: "注入条目" },
    { key: "conversation", label: "对话" },
  ].map((segment, index) => ({ ...segment, tokens: used ? quantities[index] : 0 }));
  const liveContext: ContextBreakdown = {
    segments: [...segments.map(seg => ({ key: seg.key as ContextBreakdown["segments"][number]["key"], tokens: seg.tokens * 1000 })), { key: "free", tokens: Math.max(0, 839-used)*1000 }],
    usedTokens: used * 1000, ceilingTokens: 839000, contextSize: unknown ? 0 : 1049000,
    canFold: scenario !== "empty", compactMarkerPct: scenario === "empty" ? null : 70,
    willCompact: scenario === "high" && phase !== "done", over: false, foldDeferred: false,
    autoCompact: auto, compactBoundBy: "ceiling", stateMode: false, raisedFromTokens: null,
  };
  const denominator = Math.max(839, used);
  const disabled = phase === "busy" || phase === "done" || ["empty", "running", "unknown"].includes(scenario);
  useEffect(() => {
    if (phase !== "busy") return;
    const timer = window.setTimeout(() => setPhase(scenario === "error" ? "failed" : "done"), 1600);
    return () => window.clearTimeout(timer);
  }, [phase, scenario]);
  useEffect(() => {
    if (!open) return;
    panel.current?.focus();
    const outside = (event: PointerEvent) => {
      if (!anchor.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  return <div className="cr-page">
    <header className="cr-intro"><span className="eyebrow accent">05 / COMPOSER DETAIL</span><h1>把空间还给对话</h1><p>上下文收进「片段」旁的一枚圆环。需要时，再展开。</p></header>
    <div className="cr-controls"><label>演示状态 <select value={scenario} onChange={e => { setScenario(e.target.value as Scenario); setPhase("idle"); }}>
      <option value="normal">正常 · 截图用量</option><option value="high">接近上限</option><option value="empty">新会话</option><option value="running">助手运行中</option><option value="unknown">窗口未知</option><option value="error">归纳失败</option>{production && <option value="preflight">扮演 · 发送前预估</option>}
    </select></label><label><input type="checkbox" checked={auto} onChange={e => setAuto(e.target.checked)} /> 自动归纳</label><span>本地交互演示 · 不调用模型</span></div>
    <section className="cr-chat" aria-label="助手面板原型">
      <header className="cr-chat-head"><div><h2>资料整理</h2><small>对话助手 <span> / </span> 示例模型 · 1.0M</small></div><span className="muted">未命名会话</span></header>
      <div className="cr-transcript"><div className="cr-user">整理这些参考文件，提炼一份可以继续写作的提纲。</div><div className="cr-answer"><small>✓ 已读取 3 份参考文件</small><p>已按主题整理资料，并保留了关键出处。</p><ul><li>背景与目标：交代问题和适用范围。</li><li>主要发现：归并重复内容，保留不同观点。</li><li>后续工作：补充案例，再展开正文。</li></ul><p>你可以继续补充材料，或从任一部分开始写。</p></div></div>
      <div className="cr-compose"><div className="cr-context-actions"><span>＋ 选区　　＋ 引用</span><span>□ 计划模式　 ·　 能力 3⌄</span></div><div className="cr-input"><textarea aria-label="消息草稿" placeholder="让 Agent 做什么…（输入 @ 引用知识库条目或文件）" /><div className="cr-input-footer"><span className="cr-snippet"><Zap size={13}/>片段<ChevronDown size={12}/></span>
      {production ? <I18nextProvider i18n={reviewI18n}><ProductionContextRing entryTerm="条目" context={liveContext}
        preflight={scenario === "preflight" ? { pre: {
          contextSize: 1049000, ceilingTokens: 839000, lowerBoundTokens: 6900,
          lowerBoundPct: 6900 / 839000 * 100, over: false,
          segments: [{ key: "system", tokens: 3000 }, { key: "bound", tokens: 2900 },
            { key: "memory", tokens: 1000 }, { key: "unknown", tokens: 832100 }],
        }, resident: ["Narrator"], unexpanded: 2, stale: 1 } : null}
        compacting={phase === "busy"} busy={scenario === "running"} contextVersion={phase === "done" ? 1 : 0}
        onCompact={() => setPhase("busy")} feedback={phase === "done" ? { requestId: 1, contextVersion: 1, result: { status: "success", fromTokens: scenario === "high" ? 746700 : 28700, toTokens: 18200 } }
          : phase === "failed" ? { requestId: 1, contextVersion: 0, result: { status: "failed", message: "演示：服务暂不可用。" } } : undefined} /></I18nextProvider> : (
      <div className="cr-anchor" ref={anchor} onKeyDown={e => { if(e.key === "Escape" && open) { e.stopPropagation(); close(); } }}>
        <button ref={trigger} className={`cr-ring-button ${pct >= 85 ? "cr-warning" : ""}`} aria-label={unknown ? "上下文用量，窗口未知" : `上下文已用 ${pct}%，点击查看详情`} aria-expanded={open} aria-controls="context-detail" aria-haspopup="dialog" title={unknown ? "窗口未知，查看上下文详情" : `上下文已用 ${pct}% · ${used}k / 839k tk`} onClick={() => setOpen(v => !v)}>
          <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><circle className="cr-track" cx="12" cy="12" r="9"/>{unknown
            ? <circle className="cr-fill" cx="12" cy="12" r="9" pathLength="100" strokeDasharray="3 5"/>
            : segments.map((seg, index) => <circle key={seg.key} className={`cr-fill cr-segment-${seg.key}`} cx="12" cy="12" r="9" pathLength="100"
                strokeDasharray={`${seg.tokens / denominator * 100} 100`}
                strokeDashoffset={-segments.slice(0, index).reduce((sum, item) => sum + item.tokens, 0) / denominator * 100}
                transform="rotate(-90 12 12)"/>)}{unknown && <text x="12" y="16" textAnchor="middle">?</text>}</svg>
        </button>
        {open && <div id="context-detail" ref={panel} className="cr-popover" role="dialog" aria-labelledby="cr-title" tabIndex={-1}>
          <header><strong id="cr-title">上下文</strong><button aria-label="关闭详情" onClick={close}><X size={15}/></button></header>
          <div className="cr-reading"><strong>{unknown ? "—" : `${pct}%`}</strong><span>{unknown ? "窗口大小未知" : "已使用"}<small>{unknown ? "暂无法计算占比" : `约 ${used}k / 839k tk`}</small></span></div>
          <div className="cr-detail-track">{!unknown && segments.map(seg => <span key={seg.key} className={`cr-segment-${seg.key}`} style={{width: `${seg.tokens / denominator * 100}%`}} />)}</div>
          <dl>{segments.map(seg => <div key={seg.key}><dt><i className={`cr-swatch cr-segment-${seg.key}`} aria-hidden="true"/>{seg.label}</dt><dd>{used ? `${seg.tokens.toFixed(1)}k` : "—"}</dd></div>)}<div><dt><i className="cr-swatch cr-free" aria-hidden="true"/>空余</dt><dd>{unknown ? "—" : `${Math.max(0, 839-used).toFixed(1)}k`}</dd></div></dl>
          <div className="cr-capacity"><span>可用输入上限 <b>{unknown ? "未提供" : "839k"}</b></span><span>模型总窗口 <b>{unknown ? "未提供" : "1,049k"}</b></span></div>
          <p className="cr-hint">{scenario === "empty" ? "发送第一条消息后显示用量。" : scenario === "high" ? auto ? "已达到归纳线，下次请求前将归纳较早的对话。" : "自动归纳已关闭，可手动归纳以腾出空间。" : `自动归纳${auto ? "已开启" : "已关闭"}。用量为估算值。`}</p>
          <div className="cr-compact"><p>将较早的对话整理为摘要，保留近期对话。摘要可能省略细节。</p><button disabled={disabled} onClick={() => setPhase("busy")}><Minimize2 size={14}/>{phase === "busy" ? "归纳中…" : phase === "done" ? "已归纳" : phase === "failed" ? "重试归纳" : "立即归纳"}<span>Compact</span></button><small role="status">{phase === "done" ? `已归纳 · ${scenario === "high" ? "746.7" : "28.7"}k → 18.2k tk` : phase === "failed" ? "归纳失败，原对话保持不变。请重试。" : phase === "busy" ? "正在整理上下文，请稍候…" : scenario === "running" ? "等待当前回复结束后可归纳。" : scenario === "empty" ? "暂无可归纳的历史对话。" : unknown ? "请先配置模型窗口大小。" : "归纳会调用模型，按模型计费用量。"}</small></div>
        </div>}
      </div>)}<span className="cr-footer-hint">思考 中⌄</span><span className="cr-send" aria-hidden="true"><ArrowUp size={17}/></span></div></div></div>
    </section><div className="cr-notes"><p><b>常驻只留一枚环</b><br/>20px 图形 / 32px 点击区域 / 不显示常驻数字</p><p><b>点击向上展开</b><br/>详情覆盖对话，不挤压输入框；Esc 或点外部关闭</p><p><b>归纳留在详情内</b><br/>执行进度、成功读数与失败重试都在原位反馈</p></div>
  </div>;
}
