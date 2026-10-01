/** Real browser resolver/writer and approval UI, with fictional files behind mocked Tauri IPC. */
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { resolve } from 'node:path';
const [outputArg, modules] = process.argv.slice(2);
if (!outputArg || !modules) throw new Error('Usage: node scripts/pptx/approval-smoke.mjs NEW_OUTPUT_DIR EXTERNAL_NODE_MODULES');
const require = createRequire(resolve(modules, '../package.json'));
const { chromium } = require('playwright');
const out = resolve(outputArg); await mkdir(out, { recursive: false });
const source = await readFile('src/lib/pptx/native/__tests__/fixtures/six-layouts.slides.json','utf8');
const logo = (await readFile('public/logo.png')).toString('base64');
const server = await createServer({ configFile: false, root: process.cwd(), logLevel: 'error',
  esbuild: { jsx: 'automatic' },
  css: { transformer: 'lightningcss', lightningcss: { cssModules: { animation: false } } },
  plugins: [{name:'p4-harness',
    resolveId(id) { if(id === '/p4-runtime.js') return id; },
    load(id) { if(id === '/p4-runtime.js') return "export {default as React} from 'react'; export {createRoot} from 'react-dom/client';"; },
    configureServer(s) { s.middlewares.use('/p4', (_req,res) => {res.setHeader('Content-Type','text/html');res.end('<html><body><div id="root"></div></body></html>');}); }}],
  server: {host:'127.0.0.1',port:0} });
let browser;
try {
 await server.listen(); browser = await chromium.launch({channel:'chrome',headless:true});
 const page = await browser.newPage({viewport:{width:1000,height:1000}});
 page.on('pageerror',e=>console.log('PAGEERROR',e.message));
 await page.goto(server.resolvedUrls.local[0]+'p4');
 await page.evaluate(async ({source,logo})=>{
  const {mockIPC}=await import('/node_modules/@tauri-apps/api/mocks.js');
  const disk=new Map([['/fixture/deck.slides.json',new TextEncoder().encode(source)],['/fixture/public/logo.png',Uint8Array.from(atob(logo),c=>c.charCodeAt(0))],['/fixture/deck.pptx',new Uint8Array([80,75,1,2,3])]]);
  window.p4={disk};
  const b64=b=>btoa(Array.from(b,c=>String.fromCharCode(c)).join(''));
  mockIPC((cmd,p)=>{
   if(cmd==='fs_exists') return disk.has(p.path);
   if(cmd==='fs_read_head') {const b=disk.get(p.path);if(!b)throw Error('missing');return {size:b.length,head:b64(b.slice(0,p.maxBytes))};}
   if(cmd==='fs_read_range') {const b=disk.get(p.path);return {size:b.length,bytes:b64(b.slice(p.offset,p.offset+p.maxBytes))};}
   if(cmd==='fs_read_text_file')return new TextDecoder().decode(disk.get(p.path));
   if(cmd==='fs_write_binary_file') {disk.set(p.path,Uint8Array.from(atob(p.data),c=>c.charCodeAt(0)));return;}
   if(cmd==='fs_create_dir')return;
   if(cmd==='fs_rename'){disk.set(p.to,disk.get(p.from));disk.delete(p.from);return;}
   if(cmd==='fs_remove_file'){disk.delete(p.path);return;}
   if(cmd==='fs_copy') {disk.set(p.to,disk.get(p.from).slice());return;}
   throw Error('Unmocked IPC '+cmd);
  });
  const {React,createRoot}=await import('/p4-runtime.js');
  const {default:i18n}=await import('/src/i18n/index.ts');await i18n.changeLanguage('en');
  const {applyThemeId}=await import('/src/lib/theme/scheme.ts');applyThemeId('paper','light');
  await import('/src/styles/tokens.css');await import('/src/styles/global.css');
  const {ApprovalCard}=await import('/src/components/ai/ApprovalCard.tsx');
  const {useProjectStore}=await import('/src/stores/projectStore.ts');useProjectStore.setState({projectPath:'/fixture'});
  const {useAgentStore}=await import('/src/stores/agentStore.ts');
  const {setPptxExportEnabled}=await import('/src/lib/pptx/flag.ts');setPptxExportEnabled(true);
  const {applyProposal}=await import('/src/lib/agent/proposalApply.ts');
  const deps={projectPath:()=>'/fixture',activeFilePath:()=>null,editor:()=>({saveNow:async()=>{}}),entries:()=>({}),refreshFileTree:async()=>{}};
  const {exportPptxTool}=await import('/src/lib/agent/pptxTools.ts');
  const root=createRoot(document.getElementById('root'));
  window.p4.render=async(width,lang,scheme)=>{
   await i18n.changeLanguage(lang);applyThemeId(scheme==='dark'?'night':'paper',scheme);
   root.render(React.createElement('div',{style:{width,padding:16}},React.createElement(ApprovalCard,{item:window.p4.item})));
  };
  window.p4.result=exportPptxTool('browser',{source_path:'/fixture/deck.slides.json'},{projectPath:'/fixture',requestApproval:proposal=>new Promise(resolve=>{
    window.p4.item={proposal,resolve,runId:'fixture',at:Date.now()};
    useAgentStore.setState({approve:async()=>{try{const outcome=await applyProposal(proposal,deps);window.p4.outcome=outcome;resolve({approved:true,backupPath:outcome.report});}catch(e){window.p4.error=String(e);resolve({approved:false,reason:String(e)});}},reject:()=>resolve({approved:false})});
    window.p4.render(640,'en','light');
  })}).then(result=>{window.p4.done=result;return result;});
 },{source,logo});
 await page.getByText('Native editable slides',{exact:true}).waitFor({timeout:60000});
 for(const [width,lang,scheme] of [[640,'en','light'],[272,'en','dark'],[272,'zh-CN','light'],[640,'zh-CN','dark']]) {
   await page.evaluate(([width,lang,scheme])=>window.p4.render(width,lang,scheme),[width,lang,scheme]);
   await page.waitForTimeout(250);
   await page.locator('#root > div > div').screenshot({path:`${out}/card-${width}-${lang}-${scheme}.png`});
   console.log('card',width,lang,scheme,await page.evaluate(()=>({width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth,text:document.body.innerText})));
 }
 await page.evaluate(()=>window.p4.render(640,'en','light'));await page.waitForTimeout(200);
 console.log('buttons',await page.getByRole('button').allTextContents());
 await page.getByRole('button',{name:'Approve',exact:true}).click();
 await page.waitForFunction(()=>window.p4.done);
 const result=await page.evaluate(()=>({done:window.p4.done,outcome:window.p4.outcome,error:window.p4.error,bytes:Array.from(window.p4.disk.get('/fixture/deck.pptx')),backups:[...window.p4.disk.keys()].filter(p=>p.includes('/backups/'))}));
 if(result.error||!result.outcome)throw Error(JSON.stringify(result));
 await writeFile(`${out}/native.pptx`,Buffer.from(result.bytes));delete result.bytes;
 result.browser = browser.version(); result.scope = 'Real browser fonts/layout/writer and UI; filesystem IPC simulated; no live model or Tauri window.';
 await writeFile(`${out}/result.json`,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally {await browser?.close();await server.close();}
