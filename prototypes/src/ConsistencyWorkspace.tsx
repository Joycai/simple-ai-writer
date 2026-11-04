import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, FileText, ShieldCheck, X } from 'lucide-react';
import './generate-workspace.css';
import './consistency-workspace.css';

type Phase = 'idle' | 'running' | 'waiting' | 'done' | 'partial' | 'empty';
const phases: [Phase, string][] = [['idle','待开始'],['running','核对中'],['waiting','等待继续'],['done','已完成'],['partial','部分完成'],['empty','无有效记录']];
const entries = ['服务响应承诺','数据备份规范','安全资质说明','交付验收标准'];
const findings = [
  { title:'响应时限与服务承诺不一致', original:'发生故障后，技术支持将在 30 分钟内响应。', source:'服务响应承诺 · 响应机制', evidence:'标准服务响应时间为 2 小时内。', suggestion:'发生故障后，技术支持将在 2 小时内响应。' },
  { title:'备份保留周期需要修正', original:'备份数据至少保留 180 天。', source:'数据备份规范 · 保留策略', evidence:'日常备份保留 90 天，特殊项目另行约定。', suggestion:'日常备份数据保留 90 天；特殊项目按双方约定执行。' },
];
export function ConsistencyWorkspace() {
  const [phase,setPhase] = useState<Phase>('idle');
  const [narrow,setNarrow] = useState(false);
  const [round,setRound] = useState(1);
  const [limit,setLimit] = useState(14);
  const [scope,setScope] = useState('全部');
  const [draftScope,setDraftScope] = useState('全部');
  const [pins,setPins] = useState<string[]>(entries.slice(0,2));
  const [draftPins,setDraftPins] = useState<string[]>(pins);
  const [query,setQuery] = useState('');
  const [focus,setFocus] = useState('');
  const [thinking,setThinking] = useState('中');
  const [parallel,setParallel] = useState('1');
  const [dirty,setDirty] = useState(false);
  const [selected,setSelected] = useState<number[]>([]);
  const [ignored,setIgnored] = useState<number[]>([]);
  const [applied,setApplied] = useState<number[]>([]);
  const [notice,setNotice] = useState('');
  const [filter,setFilter] = useState('全部');
  const picker = useRef<HTMLDialogElement>(null);
  const budget = useRef<HTMLDialogElement>(null);
  const busy = phase === 'running' || phase === 'waiting';
  const finished = ['done','partial','empty'].includes(phase);
  const count = scope === '全部' ? 37 : scope === '集合' ? pins.length * 8 : pins.length;
  const referenceTokens = scope === '全部' ? 218 : count * 5.9;
  const inputTokens = 7.2 + referenceTokens + (phase === 'idle' ? 0 : 6.4);
  const angle = (tokens:number) => tokens / 839 * 360;
  const percent = (inputTokens / 839 * 100).toFixed(1);
  const hasResults = phase !== 'idle' && phase !== 'empty' && (phase !== 'running' || round >= 4);
  const change = () => { if (phase !== 'idle') setDirty(true); };
  const start = () => { setRound(1);setLimit(14);setPhase('running');setDirty(false);setSelected([]);setIgnored([]);setApplied([]);setNotice(''); };
  const scenario = (next:Phase) => {setPhase(next);setRound(next === 'idle' ? 1 : next === 'running' ? 6 : 11);setLimit(14);setSelected([]);setIgnored([]);setApplied([]);setNotice('');setDirty(false);};
  useEffect(() => {
    if(phase !== 'running') return;
    const timer = window.setTimeout(() => {if(round >= limit - 3) setPhase('waiting');else setRound(r=>r+1);},1800);
    return ()=>window.clearTimeout(timer);
  },[phase,round,limit]);
  return <div className="gw-page cw-page">
    <header className="gw-intro"><div><span className="eyebrow accent">08 / CONSISTENCY WORKSPACE</span><h1>核对有依据，过程看得见</h1><p>配置留在左侧，计划与发现始终在眼前。</p></div><span className="gw-prototype">交互原型 · 虚构数据 · 不调用模型</span></header>
    <div className="gw-review"><label>演示状态 <select value={phase} onChange={e=>scenario(e.target.value as Phase)}>{phases.map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label><button aria-pressed={narrow} onClick={()=>setNarrow(!narrow)}>{narrow?'恢复宽屏':'预览窄窗口'}</button><span>自动演示轮数 · 所有修改仅保留在本页</span></div>
    <div className={`gw-app ${narrow?'cw-narrow':''}`}>
      <header className="gw-app-head"><div><strong>一致性检查</strong><small><i/>示例渠道 / 示例模型 <b>1.0M</b></small></div><span>AI 助手</span></header>
      <nav className="cw-tabs"><a href="#generate-workspace">生成</a><span>对话助手</span><strong>一致性检查</strong><span>扮演</span></nav>
      <div className="gw-layout cw-layout"><aside className="gw-control">
        <div className="gw-scroll">
          <div className="cw-doc"><FileText size={18}/><div><small>核对文档 · 示例</small><strong title="产品资料/数据安全保障说明.md">数据安全保障说明.md</strong><small>1,555 字 · 预计 1 段</small></div></div>
          <details className="cw-configuration" open><summary>核对配置 <span>{scope} · {count} 条候选</span></summary><fieldset disabled={busy}>
          <section className="gw-config"><div className="gw-section-title"><span><i/>核对配置</span><small>{busy?'本次配置已锁定':'本次任务'}</small></div><label className="cw-label">参考范围</label><button className="cw-scope" onClick={()=>{setDraftScope(scope);setDraftPins(pins);setQuery('');picker.current?.showModal();}}><span>{scope}<small>{count} 条候选</small></span><em>更改 ↗</em></button><p className="gw-help">{scope === '全部'?'跟随知识库当前取材范围。':'仅在所选范围内检索核对依据。'}</p>
          <label className="gw-input-label">核对重点 <small>可选</small><textarea value={focus} onChange={e=>{setFocus(e.target.value);change();}} placeholder="例如：重点核对数字、日期和服务承诺"/></label><p className="gw-help">留空则全面核对。</p></section>
          <details className="gw-runtime cw-advanced"><summary>高级设置 <span>并行 {parallel}</span></summary><label>并行分段数 <select value={parallel} onChange={e=>{setParallel(e.target.value);change();}}>{['1','2','3'].map(v=><option key={v}>{v}</option>)}</select></label><p className="gw-help">当前文档只需 1 段，实际并行数为 1。长文档按分段数执行。</p></details>
          </fieldset></details>
          {dirty&&<p className="gw-warning">配置已更改，重新核对后生效。右侧保留上次结果。</p>}
          <div className="cw-note"><ShieldCheck size={15}/><p>核对期间只读取资料。<br/>建议由你确认后应用。</p></div>
        </div>
        <footer className="gw-execute"><div className="cw-model"><button className="gw-meter" title="查看上下文组成与用量" aria-label="查看上下文详情" onClick={()=>budget.current?.showModal()}><span className="cw-ring" style={{background:`conic-gradient(var(--color-text-muted) 0 ${angle(5.7)}deg,var(--color-text-secondary) ${angle(5.7)}deg ${angle(7.2)}deg,var(--color-accent) ${angle(7.2)}deg ${angle(7.2+referenceTokens)}deg,var(--color-warning) ${angle(7.2+referenceTokens)}deg ${angle(inputTokens)}deg,var(--color-bar-track) ${angle(inputTokens)}deg)`}}/><span>{phase==='idle'?'预估':'第 1 段'} · {percent}%<small>{inputTokens.toFixed(1)}k / 839k tk</small></span></button><label>思考 <select disabled={busy} value={thinking} onChange={e=>{setThinking(e.target.value);change();}}>{['低','中','高'].map(v=><option key={v}>{v}</option>)}</select></label></div><button className="gw-run cw-start" onClick={busy?()=>{setPhase('partial');setNotice('已停止。已有发现保留，本段尚未完成核对。');}:start}>{busy?'停止核对':phase==='idle'?'开始核对':'重新核对'} <span>{busy?'■':'→'}</span></button></footer>
      </aside>
      <section className="gw-result"><div className="gw-result-head"><span>核对结果</span><small>{phases.find(([v])=>v===phase)?.[1]}</small></div><div className="cw-result-scroll">
      {phase==='idle'?<div className="gw-empty"><ShieldCheck size={38} strokeWidth={1}/><h2>让每个结论都有依据</h2><p>根据所选参考内容核对文档，<br/>逐项呈现原文、依据与修改建议。</p><div><span>01 制定计划</span><span>02 查证依据</span><span>03 审阅建议</span></div></div>:<>
        <section className="cw-progress"><div className="cw-progress-title"><strong>{phase==='running'?(round<4?'制定核对计划':'核对数字与服务承诺'):phase==='waiting'?'等待你决定下一步':phase==='done'?'本轮核对已完成':'本轮核对未完成'}</strong><span>第 {round} / {limit} 轮</span></div><details><summary>计划 {phase==='done'?'4':'2'}/4 <span>查看步骤</span></summary><ol className="cw-steps">{['梳理文档中的待核对事项','检索并读取参考依据','逐项记录核对结果','整理建议与未核实事项'].map((s,i)=><li key={s}>{phase==='done'||i<2?'✓':i===2?'◉':'○'} {s}</li>)}</ol></details><div className="cw-coverage">核对覆盖 <strong>{phase==='done'?'1 / 1 段':'0 / 1 段'}</strong><span>{phase==='done'?'本段已完成':'第 1 段尚未完成'}</span></div></section>
        {phase==='waiting'&&<section className="cw-budget-card"><strong>取证轮数已用完</strong><p>已使用 {round} 轮。可增加 8 轮继续查证，或用预留的 3 轮提交现有结果。</p><div><button className="gw-run" onClick={()=>{setLimit(v=>v+8);setRound(v=>v+1);setPhase('running');}}>继续 8 轮</button><button onClick={()=>{setRound(v=>v+3);setPhase('done');setNotice('演示：提交阶段完成，已记录 2 项建议和 5 项一致记录。');}}>提交现有结果</button><button onClick={()=>setPhase('partial')}>停止</button></div></section>}
        {(phase==='partial'||phase==='empty')&&<div className="cw-budget-card"><strong>{phase==='empty'?'没有有效核对记录':'仍有未完成的核对内容'}</strong><p>{phase==='empty'?'本轮未提交有效记录，不能据此认定内容一致。请查看日志后重试。':'已有发现可供审阅，但不能据此认定全文已核对。'}</p><button onClick={()=>{setLimit(v=>v+8);setPhase('running');}}>继续核对未完成部分</button></div>}
        {notice&&<p className="cw-notice" role="status">{notice}</p>}
        {hasResults&&<><div className="cw-findings-head"><strong>核对发现 <small>2 项建议</small></strong><select aria-label="筛选核对发现" value={filter} onChange={e=>setFilter(e.target.value)}>{['全部','待处理','已忽略','已应用'].map(v=><option key={v}>{v}</option>)}</select></div>{findings.map((f,i)=>{const status=applied.includes(i)?'已应用':ignored.includes(i)?'已忽略':'待处理';if(filter!=='全部'&&filter!==status)return null;return <section className="cw-finding" key={f.title}><header><label><input type="checkbox" disabled={status!=='待处理'} checked={selected.includes(i)} onChange={e=>setSelected(v=>e.target.checked?[...v,i]:v.filter(n=>n!==i))}/><strong>{f.title}</strong></label><small>{status}</small></header><dl><dt>原文</dt><dd>{f.original}</dd><dt>依据 · {f.source}</dt><dd>{f.evidence}</dd><dt>修改建议</dt><dd className="cw-suggestion">{f.suggestion}</dd></dl>{status!=='已应用'&&<button className="gw-text-button" onClick={()=>{setIgnored(v=>v.includes(i)?v.filter(n=>n!==i):[...v,i]);setSelected(v=>v.filter(n=>n!==i));}}>{status==='已忽略'?'恢复为待处理':'忽略此项'}</button>}</section>;})}{filter!=='全部'&&!findings.some((_,i)=>(applied.includes(i)?'已应用':ignored.includes(i)?'已忽略':'待处理')===filter)&&<p className="gw-help">此分类下暂无记录。</p>}{phase==='done'&&<details className="cw-passes"><summary><CheckCircle2 size={14}/>另有 5 项与参考内容一致</summary><p>服务范围、支持渠道、交付阶段、验收责任、备份频率。</p></details>}</>}
        <details className="cw-log"><summary>执行日志 · {round} 轮</summary><p>第 1 轮　制定核对计划</p><p>第 2–{Math.max(2,round-1)} 轮　检索正文并读取参考资料</p><p>第 {round} 轮　{phase==='empty'?'未收到有效记录':phase==='done'?'提交核对结果':'核对服务承诺'}</p><small>以上为交互演示日志。</small></details>
      </>}
      </div><footer className="gw-result-foot cw-results-footer"><span>{selected.length?`已选 ${selected.length} 项`:busy?'结果持续更新中':'选择建议后应用'}{busy&&selected.length>0?' · 核对结束后可应用':''}</span><button className="gw-run" disabled={!finished||!selected.length||dirty} onClick={()=>{setApplied(v=>[...v,...selected]);setNotice(`已在原型中应用 ${selected.length} 项建议，实际文件未修改。`);setSelected([]);}}>应用所选建议</button></footer></section></div>
    </div>
    <dialog ref={picker} className="gw-dialog" aria-label="参考范围" onClick={e=>{if(e.target===e.currentTarget)picker.current?.close();}}><header><div><small>核对依据</small><h2>参考范围</h2></div><button aria-label="关闭范围选择" onClick={()=>picker.current?.close()}><X size={18}/></button></header><div className="gw-choices">{['全部','集合','条目'].map(v=><button key={v} aria-pressed={draftScope===v} onClick={()=>{setDraftScope(v);setDraftPins([]);}}>{v}</button>)}</div>{draftScope==='全部'?<p className="gw-help">跟随知识库当前取材范围：全部 · 37 条候选。检索会按相关性选择依据。</p>:<><label className="gw-search"><input aria-label="搜索参考内容" placeholder={`搜索${draftScope}…`} value={query} onChange={e=>setQuery(e.target.value)}/></label>{(draftScope==='集合'?['产品资料','服务资料','交付资料']:entries).filter(v=>v.includes(query)).map(v=><label className="gw-source-option" key={v}><input type="checkbox" checked={draftPins.includes(v)} onChange={e=>setDraftPins(p=>e.target.checked?[...p,v]:p.filter(n=>n!==v))}/>{v}</label>)}{!(draftScope==='集合'?['产品资料','服务资料','交付资料']:entries).some(v=>v.includes(query))&&<p>没有匹配项。</p>}</>}<footer><button onClick={()=>picker.current?.close()}>取消</button><button className="gw-run" disabled={draftScope!=='全部'&&!draftPins.length} onClick={()=>{setScope(draftScope);setPins(draftPins);change();picker.current?.close();}}>确认范围</button></footer></dialog>
    <dialog ref={budget} className="gw-dialog gw-budget" aria-label="上下文详情" onClick={e=>{if(e.target===e.currentTarget)budget.current?.close();}}><header><h2>上下文详情</h2><button aria-label="关闭上下文详情" onClick={()=>budget.current?.close()}><X size={18}/></button></header><strong className="gw-budget-number">{percent}%</strong><p className="gw-help">{phase==='idle'?'本次输入预估':'第 1 段 · 当前输入估算'} / 可用输入 839k tk</p><dl>{[['系统与工具','5.7k'],['原文','1.5k'],['参考条目',`${referenceTokens.toFixed(1)}k`],['其他与执行记录',phase==='idle'?'0':'6.4k'],['可用余量',`${(839-inputTokens).toFixed(1)}k`]].map(([k,v],i)=><div key={k}><dt><i className={`cw-key cw-key-${i}`}/>{k}</dt><dd>{v}</dd></div>)}</dl><hr/><p className="gw-help">预计 1 段 · 实际并行 1<br/>模型总窗口 1.0M · 可用输入 839k</p>{phase!=='idle'&&<p className="gw-help">本轮累计用量（演示）<br/>输入 {(round*22.4).toFixed(1)}k · 输出 {(round*.6).toFixed(1)}k tk<br/>累计用量与当前上下文占用分别统计。</p>}</dialog>
  </div>;
}
