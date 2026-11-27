/** Real presentation components, fictional chat state. No app stores or IPC. */
import { useEffect, useState } from "react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { Bot, X } from "lucide-react";
import { SessionPermissionsMenu, SessionPermissionsBand } from "../../src/components/ai/SessionPermissionsMenu";
import { applyThemeId } from "../../src/lib/theme/scheme";
import { validateThemeText, uiThemeCss } from "../../src/lib/theme/validate";
import { TOKEN_CONTRACT } from "../../src/lib/theme/contractData";
import customTheme from "../../themes/morandi-garden-dark.css?raw";
import zh from "../../src/i18n/locales/zh-CN.json";
import en from "../../src/i18n/locales/en.json";
import drawer from "../../src/components/ai/AiDrawer.module.css";
import { themes } from "./fixtures";
import "./session-permissions-review.css";
const i18n = createInstance();
void i18n.init({ lng: "zh-CN", resources: { "zh-CN": { translation: zh }, en: { translation: en } }, interpolation: { escapeValue: false } });
const customId = "morandi-garden-dark";
export function SessionPermissionsReview() {
  const [theme, setTheme] = useState("paper");
  const [chats, setChats] = useState([false, false]);
  const [active, setActive] = useState(0);
  const [language, setLanguage] = useState("zh-CN");
  const enabled = chats[active];
  const change = (on: boolean) => setChats(previous => previous.map((value, index) => index === active ? on : value));
  useEffect(() => {
    const validation = validateThemeText(customTheme, customId, TOKEN_CONTRACT);
    if (validation.kind !== "ui") return;
    const style = document.createElement("style");
    style.textContent = `@layer tokens.user { ${uiThemeCss(customId, validation.tokens)} }`;
    document.head.append(style);
    return () => style.remove();
  }, []);
  return <I18nextProvider i18n={i18n}><div className="permission-review">
    <div className="permission-review-toolbar">
      <a href="#overview">← Design studio</a><span>正式权限组件 · 本地演示，不执行命令</span>
      <select aria-label="验收主题" value={theme} onChange={event => {
        const id = event.target.value; setTheme(id);
        applyThemeId(id, id === customId ? "dark" : themes.find(item => item.value === id)!.scheme);
      }}>{themes.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}<option value={customId}>自定义 · 莫兰迪暮色</option></select>
      <select aria-label="语言" value={language} onChange={event => { setLanguage(event.target.value); void i18n.changeLanguage(event.target.value); }}><option value="zh-CN">中文</option><option value="en">English</option></select>
    </div>
    <section className="permission-review-window" data-ai-surface>
      <div className={drawer.header}>
        <div className={drawer.avatar}><Bot size={16} /></div>
        <div className={drawer.titleBlock}><div className={drawer.title}>{active === 0 ? "开发本地数据工具" : `会话 ${active + 1}`}</div><div className="permission-review-model">Claude Sonnet · 演示模型</div></div>
        <div className={drawer.headerActions}>
          <SessionPermissionsMenu key={active} enabled={enabled} onChange={change} />
          <button className={drawer.headerBtn} onClick={() => { setActive(chats.length); setChats([...chats, false]); }}>新会话</button>
        </div>
      </div>
      <div className={drawer.modeTabs}><span className={`${drawer.modeTab} ${drawer.modeTabActive}`}>对话助手</span></div>
      <div className="permission-review-tabs">{chats.map((_, index) => <button key={index} aria-pressed={index === active} onClick={() => setActive(index)}>会话 {index + 1}</button>)}</div>
      {enabled && <SessionPermissionsBand onDisable={() => change(false)} />}
      <div className="permission-review-chat"><p className="permission-review-user">帮我运行测试，再检查构建结果。</p><p>可以在顶部的「会话权限」中开启代码开发，为当前会话授权脚本、依赖安装、构建与测试。</p><p className="permission-review-muted">这里使用正式菜单、确认框和状态带。对话内容为固定示例，授权状态仅保存在此演示页面。</p></div>
      <div className="permission-review-composer"><textarea aria-label="演示输入框" placeholder="输入消息…" /><div><span>Agent · 本地演示</span><X size={14} aria-hidden="true" /></div></div>
    </section>
  </div></I18nextProvider>;
}
