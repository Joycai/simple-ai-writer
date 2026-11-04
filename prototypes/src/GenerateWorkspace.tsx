import { useRef, useState } from "react";
import { ArrowRight, Check, ChevronDown, FileText, Plus, Search, SlidersHorizontal, X } from "lucide-react";
import "./generate-workspace.css";

const tasks = [
  { name: "续写", group: "通用任务", desc: "沿着当前内容，继续写下去" },
  { name: "重写", group: "通用任务", desc: "调整选中文字的结构与表达" },
  { name: "润色", group: "通用任务", desc: "保留原意，让表达更准确自然" },
  { name: "总结", group: "通用任务", desc: "提炼材料的重点与结论" },
  { name: "图示 / 页面", group: "通用任务", desc: "把内容组织为图示或页面" },
  { name: "自定义", group: "通用任务", desc: "按照你的要求完成任务" },
  { name: "应答撰写", group: "标书应答", desc: "结合需求与资料撰写应答内容" },
  { name: "应答核查", group: "标书应答", desc: "检查应答的覆盖与依据" },
  { name: "提取入库", group: "标书应答", desc: "整理值得保留的资料" },
  { name: "归纳主题", group: "反馈报告", desc: "从反馈中提炼共性主题" },
  { name: "溯源校对", group: "反馈报告", desc: "核对结论与原始材料" },
  { name: "汇总", group: "周报", desc: "汇总本周进展与下一步" },
  { name: "对照上期", group: "周报", desc: "比较变化，跟踪未完成事项" },
];
const sources = [
  { name: "产品介绍", group: "产品资料", text: "产品定位、核心能力与适用范围" },
  { name: "服务承诺", group: "服务资料", text: "服务时段、响应要求与交付约定" },
  { name: "实施方法", group: "服务资料", text: "项目阶段、实施步骤与验收标准" },
  { name: "客户案例", group: "产品资料", text: "已完成项目与应用场景" },
];
function Choices({ label, values, value, onChange }: { label: string; values: string[]; value: string; onChange: (v: string) => void }) {
  return <div className="gw-field"><span>{label}</span><div className="gw-choices">{values.map(v => <button key={v} aria-pressed={value === v} onClick={() => onChange(v)}>{v}</button>)}</div></div>;
}
export function GenerateWorkspace() {
  const [task, setTask] = useState(tasks[0]);
  const [query, setQuery] = useState("");
  const [sourceQuery, setSourceQuery] = useState("");
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [pins, setPins] = useState(["产品介绍", "服务承诺"]);
  const [length, setLength] = useState("1k 字");
  const [position, setPosition] = useState("文末");
  const [versions, setVersions] = useState("1 版");
  const [reference, setReference] = useState("2k 字");
  const [thinking, setThinking] = useState("中");
  const [requirements, setRequirements] = useState<Record<string, string>>({});
  const [extra, setExtra] = useState("");
  const [result, setResult] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const picker = useRef<HTMLDialogElement>(null);
  const library = useRef<HTMLDialogElement>(null);
  const budget = useRef<HTMLDialogElement>(null);
  const isContinue = task.name === "续写";
  const editing = ["重写", "润色"].includes(task.name);
  const toggle = (name: string) => setPins(p => p.includes(name) ? p.filter(n => n !== name) : [...p, name]);
  return <div className="gw-page">
    <header className="gw-intro"><div><span className="eyebrow accent">07 / GENERATE WORKSPACE</span><h1>让任务回到中心</h1><p>选好任务，专注内容。低频设置收在需要的地方。</p></div><span className="gw-prototype">交互原型 · 示例数据 · 不调用模型</span></header>
    <div className="gw-review"><button aria-pressed={narrow} onClick={() => setNarrow(!narrow)}>{narrow ? "切换宽面板" : "预览窄侧栏"}</button><label><input type="checkbox" checked={blocked} onChange={e => setBlocked(e.target.checked)} />模拟输入超限</label><span>可体验：更换任务 / 固定引用 / 运行设置</span></div>
    <div className={`gw-app ${narrow ? "gw-narrow" : ""}`}>
      <header className="gw-app-head"><div><strong>AI 助手</strong><small><i /> 示例渠道 / 示例模型 <b>1.0M</b></small></div><span>生成</span></header>
      <div className="gw-layout">
        <div className="gw-control">
          <div className="gw-scroll">
            <button className="gw-task" onClick={() => { setQuery(""); picker.current?.showModal(); }}><div><small>当前任务</small><strong>{task.name}</strong></div><span>{task.group}<em>更换 <ChevronDown size={14} /></em></span></button>
            <section className="gw-config"><div className="gw-section-title"><span><i />{task.name}配置</span><small>本次任务</small></div>
              {isContinue ? <><Choices label="续写长度" values={["200 字", "500 字", "1k 字", "2k 字"]} value={length} onChange={setLength} /><Choices label="续写位置" values={["开篇", "文末", "扩写选区"]} value={position} onChange={setPosition} /></> : editing ? <><div className="gw-selection"><FileText size={14} />已选文字 · 第 12–18 行 · 486 字</div><Choices label="参考上文" values={["不带", "1k 字", "2k 字", "4k 字"]} value={reference} onChange={setReference} /><p className="gw-help">仅作为参考，不会改写这部分文字。</p><Choices label="生成版本" values={["1 版", "2 版", "3 版"]} value={versions} onChange={setVersions} /></> : <p className="gw-help">{task.desc}。按下方要求组织结果。</p>}
              <label className="gw-input-label">{isContinue ? "写作方向" : "任务要求"}<textarea value={requirements[task.name] ?? ""} onChange={e => setRequirements({ ...requirements, [task.name]: e.target.value })} placeholder={isContinue ? "接下来想写什么？例如：展开实施步骤，重点说明交付与验收。" : "说明重点、语气，以及需要保留的内容…"} /></label>
              <details className="gw-extra"><summary>补充要求 <span>{extra ? "已填写" : "可选"}</span></summary><textarea aria-label="补充要求" value={extra} onChange={e => setExtra(e.target.value)} placeholder="例如：保留原有术语，不增加未经核实的数字。" /></details>
            </section>
            <section className="gw-sources"><div className="gw-section-title"><span>参考资料</span><small>自动匹配{pins.length ? ` + 固定 ${pins.length} 项` : "知识库"}</small></div><div className="gw-pins">{pins.slice(0, 2).map(p => <button key={p} title={`取消固定 ${p}`} onClick={() => toggle(p)}>{p}<X size={12} /></button>)}{pins.length > 2 && <span>另 {pins.length - 2} 项</span>}<button className="gw-manage" onClick={() => library.current?.showModal()}><Plus size={13} />{pins.length ? "管理引用" : "固定引用"}</button></div><details className="gw-extra"><summary>补充材料 <span>可选</span></summary><textarea aria-label="补充材料" placeholder="粘贴知识库之外的背景资料…" /></details></section>
            <details className="gw-runtime"><summary><span><SlidersHorizontal size={14} />运行设置</span><span>思考：{thinking}<ChevronDown size={13} /></span></summary><Choices label="思考力度" values={["低", "中", "高"]} value={thinking} onChange={setThinking} /><p className="gw-help">对当前模型生效。原型中的修改仅保留在本页。</p><button className="gw-text-button" onClick={() => budget.current?.showModal()}>查看上下文分配 <ArrowRight size={13} /></button></details>
          </div>
          <footer className="gw-execute"><div className="gw-document"><FileText size={13} />实施方案.md <span>{editing ? "处理选区" : "当前文档"}</span></div>{blocked && <p className="gw-warning">预计输入超过上限。缩小参考范围或移除部分引用后重试。</p>}<div className="gw-run-row"><button className="gw-meter" aria-label="查看上下文分配" onClick={() => budget.current?.showModal()}><svg viewBox="0 0 24 24" width="24" height="24"><circle cx="12" cy="12" r="9" fill="none" stroke="var(--color-bar-track)" strokeWidth="3" /><circle cx="12" cy="12" r="9" fill="none" stroke="var(--color-accent)" strokeWidth="3" strokeDasharray={blocked ? "57 57" : "8 57"} transform="rotate(-90 12 12)" /></svg><span>预计输入 {blocked ? "860k" : "28.7k"}<small>输出上限 2k tk</small></span></button><button className="gw-run" disabled={blocked} onClick={() => setResult(true)}>预览{task.name}<ArrowRight size={14} /></button></div></footer>
        </div>
        <section className="gw-result"><div className="gw-result-head"><span>生成结果</span><small>{result ? "示例结果 · 未写入文档" : "准备就绪"}</small></div>{result ? <article><span className="eyebrow">示例输出</span><h2>把实施过程写清楚</h2><p>项目实施分为准备、执行与验收三个阶段。每个阶段明确负责人、交付内容和完成条件，让团队能在同一份计划上跟踪进展。</p><h3>从共同确认的目标开始</h3><p>启动阶段先核对需求范围，整理现有资料，再将目标拆解为可检查的阶段成果。出现变更时同步记录影响和后续安排。</p><div className="gw-result-note">这是用于体验布局的固定示例，没有调用模型。</div><button className="gw-text-button" onClick={() => setResult(false)}>清除示例</button></article> : <div className="gw-empty"><FileText size={32} strokeWidth={1} /><h2>留出空间，给下一段内容</h2><p>确认左侧的任务与参考资料，<br />生成结果将在这里呈现。</p><div><span>01 确认任务</span><span>02 补充方向</span><span>03 查看结果</span></div></div>}<div className="gw-result-foot">实施方案.md<span>本地设计预览</span></div></section>
      </div>
    </div>
    <dialog ref={picker} className="gw-dialog" onClick={e => { if (e.target === e.currentTarget) picker.current?.close(); }}><header><div><small>选择要完成的工作</small><h2>更换任务</h2></div><button aria-label="关闭任务选择" onClick={() => picker.current?.close()}><X size={18} /></button></header><label className="gw-search"><Search size={15} /><input autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索任务或工作台…" /></label><div className="gw-dialog-list">{[...new Set(tasks.map(t => t.group))].map(group => { const list = tasks.filter(t => t.group === group && (t.name + t.group).includes(query)); return list.length ? <section key={group}><h3>{group}</h3>{list.map(t => <button className="gw-task-option" key={t.name} aria-pressed={t.name === task.name} onClick={() => { setTask(t); picker.current?.close(); }}><span><strong>{t.name}</strong><small>{t.desc}</small></span>{t.name === task.name && <Check size={16} />}</button>)}</section> : null; })}{!tasks.some(t => (t.name + t.group).includes(query)) && <p>没有匹配的任务，试试其他关键词。</p>}</div></dialog>
    <dialog ref={library} className="gw-dialog" onClick={e => { if (e.target === e.currentTarget) library.current?.close(); }}><header><div><small>知识库 · 本项目</small><h2>固定引用</h2></div><button aria-label="关闭引用管理" onClick={() => library.current?.close()}><X size={18} /></button></header><p className="gw-help">知识库会自动匹配相关内容。固定引用可额外指定需要参考的条目；它不决定结果写入位置。</p><label className="gw-search"><Search size={15} /><input value={sourceQuery} onChange={e => setSourceQuery(e.target.value)} placeholder="搜索参考资料…" /></label><label className="gw-only"><input type="checkbox" checked={selectedOnly} onChange={e => setSelectedOnly(e.target.checked)} />只看已固定（{pins.length}）</label><div className="gw-dialog-list">{sources.filter(s => s.name.includes(sourceQuery) && (!selectedOnly || pins.includes(s.name))).map(s => <label key={s.name} className="gw-source-option"><input type="checkbox" checked={pins.includes(s.name)} onChange={() => toggle(s.name)} /><span><strong>{s.name}</strong><small>{s.group} · {s.text}</small></span></label>)}{!sources.some(s => s.name.includes(sourceQuery) && (!selectedOnly || pins.includes(s.name))) && <p>没有匹配的资料。</p>}</div><details className="gw-extra"><summary>知识库预算 <span>8k tk</span></summary><p className="gw-help">自动匹配与固定引用共同占用预算；实际进入的内容仍受总输入上限约束。原型展示默认预算。</p></details><footer><small>正式产品会在项目中保留选择；本页仅作演示。</small><button className="gw-run" onClick={() => library.current?.close()}>完成</button></footer></dialog>
    <dialog ref={budget} className="gw-dialog gw-budget" onClick={e => { if (e.target === e.currentTarget) budget.current?.close(); }}><header><h2>本次输入预估</h2><button aria-label="关闭上下文详情" onClick={() => budget.current?.close()}><X size={18} /></button></header><strong className="gw-budget-number">{blocked ? "102.5%" : "3.4%"}</strong><p className="gw-help">预计输入 / 可用输入上限 · {blocked ? "860k" : "28.7k"} / 839k tk</p><dl>{[["系统与工具", "6.2k"], ["文档与选区", blocked ? "842k" : "10.7k"], ["参考资料", "8k"], ["任务要求及其他", "3.8k"]].map(([name, amount]) => <div key={name}><dt>{name}</dt><dd>{amount}</dd></div>)}</dl><p className="gw-help">模型总窗口 1.0M · 输出上限 2k tk<br />生成前预估，不代表实际计费用量。</p>{blocked && <p className="gw-warning">当前请求超限，请缩小参考范围。</p>}</dialog>
  </div>;
}
