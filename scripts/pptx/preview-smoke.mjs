/** Real browser resolver/writer and native slide preview/export UI, with fictional files behind mocked Tauri IPC. */
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { resolve } from 'node:path';
const [outputArg, modules] = process.argv.slice(2);
if (!outputArg || !modules) throw new Error('Usage: node scripts/pptx/preview-smoke.mjs NEW_OUTPUT_DIR EXTERNAL_NODE_MODULES');
const require = createRequire(resolve(modules, '../package.json'));
const { chromium } = require('playwright');
const out = resolve(outputArg); await mkdir(out, { recursive: false });
const source = await readFile('src/lib/pptx/native/__tests__/fixtures/six-layouts.slides.json','utf8');
const logo = (await readFile('public/logo.png')).toString('base64');
const server = await createServer({ configFile: false, root: process.cwd(), logLevel: 'error',
  esbuild: { jsx: 'automatic' },
  css: { transformer: 'lightningcss', lightningcss: { cssModules: { animation: false } } },
  plugins: [{name:'p5-harness',
    resolveId(id) { if(id === '/p5-runtime.js') return id; },
    load(id) { if(id === '/p5-runtime.js') return "export {default as React} from 'react'; export {createRoot} from 'react-dom/client';"; },
    configureServer(s) { s.middlewares.use('/p5', (_req,res) => {res.setHeader('Content-Type','text/html');res.end('<html><body><div id="root"></div></body></html>');}); }}],
  server: {host:'127.0.0.1',port:0} });
let browser;
try {
 await server.listen(); browser = await chromium.launch({channel:'chrome',headless:true});
 const page = await browser.newPage({viewport:{width:1000,height:1000}});
 page.on('pageerror',e=>console.log('PAGEERROR',e.message));
 await page.goto(server.resolvedUrls.local[0]+'p5');
 await page.evaluate(async ({source,logo})=>{
  const {mockIPC}=await import('/node_modules/@tauri-apps/api/mocks.js');
  const disk=new Map([['/fixture/deck.slides.json',new TextEncoder().encode(source)],['/fixture/public/logo.png',Uint8Array.from(atob(logo),c=>c.charCodeAt(0))],['/fixture/deck.pptx',new Uint8Array([80,75,1,2,3])]]);
  window.p5={disk};
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
  const {React,createRoot}=await import('/p5-runtime.js');
  const {default:i18n}=await import('/src/i18n/index.ts');await i18n.changeLanguage('en');
  const {applyThemeId}=await import('/src/lib/theme/scheme.ts');applyThemeId('paper','light');
  await import('/src/styles/tokens.css');await import('/src/styles/global.css');
  const {default:SlidesPreview}=await import('/src/components/editor/SlidesPreview.tsx');
  const {useProjectStore}=await import('/src/stores/projectStore.ts');
  const {useEditorStore}=await import('/src/stores/editorStore.ts');
  useProjectStore.setState({projectPath:'/fixture',activeFilePath:'/fixture/deck.slides.json',refreshFileTree:async()=>{}});
  const {setPptxExportEnabled}=await import('/src/lib/pptx/flag.ts');setPptxExportEnabled(true);
  const root=createRoot(document.getElementById('root'));
  window.p5.source=source;
  window.p5.render=async(width,lang,scheme,text=window.p5.source)=>{
   window.p5.source=text;
   useEditorStore.setState({filePath:'/fixture/deck.slides.json',content:text,isDirty:false});
   disk.set('/fixture/deck.slides.json',new TextEncoder().encode(text));
   await i18n.changeLanguage(lang);applyThemeId(scheme==='dark'?'night':'paper',scheme);
   root.render(React.createElement('div',{style:{width,height:900}},React.createElement(SlidesPreview,{source:text,filePath:'/fixture/deck.slides.json',projectPath:'/fixture'})));
  };
  await window.p5.render(900,'en','light');
 },{source,logo});
 await page.getByRole('img').waitFor({timeout:60000});
 for(let i=0;i<6;i++) {
   await page.locator('#root').screenshot({path:`${out}/slide-${i+1}.png`});
   if(i<5)await page.getByRole('button',{name:'Next slide',exact:true}).click();
 }
 for(const [width,lang,scheme] of [[320,'en','dark'],[320,'zh-CN','light'],[900,'zh-CN','dark']]) {
   await page.evaluate(args=>window.p5.render(...args),[width,lang,scheme]);
   await page.waitForTimeout(300);
   await page.locator('#root > div').screenshot({path:`${out}/preview-${width}-${lang}-${scheme}.png`});
 }
 await page.evaluate(()=>window.p5.render(900,'en','light'));
 await page.getByRole('button',{name:'Export PPTX',exact:true}).click();
 await page.getByRole('button',{name:'Write PPTX',exact:true}).waitFor();
 await page.locator('#root').screenshot({path:`${out}/review.png`});
 // Editing invalidates prepared bytes and removes the write control immediately.
 await page.evaluate(()=>window.p5.render(900,'en','light','{'));
 await page.getByRole('alert').waitFor();
 if(await page.getByRole('button',{name:'Write PPTX',exact:true}).count())throw Error('Stale review survived edit');
 if(!await page.getByRole('button',{name:'Export PPTX',exact:true}).isDisabled())throw Error('Invalid source export enabled');
 await page.evaluate(source=>window.p5.render(900,'en','light',source),source);
 await page.getByRole('img').waitFor();
 await page.getByRole('button',{name:'Export PPTX',exact:true}).click();
 await page.getByRole('button',{name:'Write PPTX',exact:true}).click();
 await page.getByRole('status').filter({hasText:'Exported:'}).waitFor();
 const result=await page.evaluate(()=>({bytes:Array.from(window.p5.disk.get('/fixture/deck.pptx')),backups:[...window.p5.disk.entries()].filter(([p])=>p.includes('/backups/')).map(([path,bytes])=>({path,bytes:Array.from(bytes)})),text:document.body.innerText}));
 if(result.backups.length!==1||result.backups[0].bytes.join(',')!=='80,75,1,2,3')throw Error('Backup mismatch');
 await writeFile(`${out}/native.pptx`,Buffer.from(result.bytes));delete result.bytes;
 result.browser=browser.version();result.scope='Real Chrome resolver/writer and native preview/export UI, mocked filesystem IPC; no live model or Tauri window.';
 result.checks=['six layouts rendered','English/Chinese light/dark narrow/wide','source edits invalidate review','invalid source blocks export','explicit export writes PPTX and backs up original bytes'];
 await writeFile(`${out}/result.json`,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally {await browser?.close();await server.close();}
