/** Production-component fixture; every external entry is replaced by in-memory actions. */
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { I18nextProvider } from "react-i18next";
import i18n from "../../src/i18n";
import "../../src/styles/global.css";
import { applyThemeId } from "../../src/lib/theme/scheme";
import { ConsistencyCheck } from "../../src/components/ai/ConsistencyCheck";
import { useConsistencyStore } from "../../src/stores/consistencyStore";
import { useAiStore } from "../../src/stores/aiStore";
import { useProjectStore } from "../../src/stores/projectStore";
import { useEditorStore } from "../../src/stores/editorStore";
import { useLoreStore } from "../../src/stores/loreStore";
import type { ConsistencyReport, WindowOutcome } from "../../src/lib/consistency/model";
const text = "服务响应时间为 30 分钟。\n备份保留 180 天。";
useProjectStore.setState({ projectPath: "/fixture", collections: ["服务资料", "产品资料"] });
useEditorStore.setState({ filePath: "/fixture/数据安全说明.md", content: text, setContent: content => useEditorStore.setState({ content }) });
useAiStore.setState({ activeModelId: "fixture", models: [{ id:"fixture",providerId:"fixture",modelId:"gpt-5",name:"示例模型",type:"text",enabled:true,priceIn:0,priceOut:0,priceCachedIn:0,contextSize:1048576,maxOutput:2000 }],providers:[{id:"fixture",name:"示例",baseUrl:"https://invalid.invalid",apiStandard:"openai",createdAt:0}],updateModel:async model=>{useAiStore.setState({models:[model]});} });
useLoreStore.setState({ index: { custom: ["服务响应承诺", "数据备份规范"].map((name,n)=>({ id:String(n),name,category:"custom",dirPath:`/fixture/lore/${n}`,aliases:[],summary:"示例依据",avatarPath:null,collections:["服务资料"],mdFiles:["index.md"],images:[],facets:[{file:"index.md",title:"概要",charCount:300,slot:null,keys:[],group:null,priority:0,mode:"auto" as const}]})) } });
const windowResult: WindowOutcome = { index:0,from:0,to:text.length,status:"done",recorded:2,summary:"",rounds:14,inputTokens:28000,outputTokens:1400,roundBudget:14 };
const report: ConsistencyReport = { filePath:"/fixture/数据安全说明.md",docChars:text.length,issues:[{id:"a",title:"服务响应时限不一致",severity:"conflict",category:"custom",quote:"30 分钟",reference:"服务响应承诺：2 小时",suggestion:"2 小时",line:1},{id:"b",title:"备份保留周期不一致",severity:"warning",category:"custom",quote:"180 天",reference:"数据备份规范：90 天",suggestion:"90 天",line:2}],passed:[],checkedCount:2,durationMs:60000,scope:{kind:"all"},focus:"",windows:[windowResult],uncheckedFrom:null,aborted:false,emptyRun:false };
const complete=()=>useConsistencyStore.setState({isScanning:false,report,windows:[windowResult],liveIssues:report.issues});
useConsistencyStore.setState({ loadScopeFor:()=>{},setScope:scope=>useConsistencyStore.setState({scope}),scan:async()=>{useConsistencyStore.setState({isScanning:true,report:null,windows:[{...windowResult,status:"running",rounds:6}],liveIssues:report.issues,startedAt:Date.now()});},abort:()=>useConsistencyStore.setState({isScanning:false,report:{...report,aborted:true,windows:[{...windowResult,status:"aborted"}]},windows:[{...windowResult,status:"aborted"}]}),rerunWindow:async()=>complete(),resume:async()=>complete() });
applyThemeId("paper","light");
function Review(){const[narrow,setNarrow]=useState(false);return <I18nextProvider i18n={i18n}><div style={{height:"100vh",display:"flex",flexDirection:"column"}}><nav style={{padding:12,display:"flex",gap:12,flexWrap:"wrap"}}><span>正式组件 · 仅示例数据</span><button onClick={()=>setNarrow(!narrow)}>宽窄切换</button><button onClick={complete}>完成示例</button><button onClick={()=>useConsistencyStore.setState({report:null,windows:[],isScanning:false})}>重置</button><button onClick={()=>applyThemeId("night","dark")}>深色</button><button onClick={()=>applyThemeId("paper","light")}>浅色</button></nav><div style={{flex:1,minHeight:0,width:narrow?380:"100%",maxWidth:"100%",margin:"auto",display:"flex"}}><ConsistencyCheck/></div></div></I18nextProvider>;}
createRoot(document.getElementById("root")!).render(<Review/>);
