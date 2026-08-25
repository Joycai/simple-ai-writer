/* KB Admin — 一个没有构建步骤的单页应用。
 *
 * 一条贯穿全文件的规则：**所有来自服务端的名字都用文本节点渲染，不用 innerHTML。**
 * 知识库名、条目路径、设备名（X-Source-Device）全都是客户端上传的字符串，服务端
 * 明确说过它不解析、不清洗它们。这里是它们唯一一次被显示的地方，所以下面的 `el()`
 * 只接受字符串和节点，永远不拼 HTML —— 一次疏忽就等于把 XSS 交给任何能推送条目的人。
 */
'use strict';

// ── 微型渲染器 ─────────────────────────────────────────────────────────────

/**
 * el('div#id.row.on', {onClick, title}, ...children)
 *
 * `#id` and `.class` are parsed out of the tag string here rather than passed
 * as props, because `createElement('div#offline-banner')` is an
 * InvalidCharacterError in a browser — the selector has to be taken apart
 * before the tag name reaches the DOM.
 */
function el(spec, props, ...kids) {
  const [head, ...classes] = String(spec).split('.');
  const [tag, id] = head.split('#');
  const node = document.createElement(tag || 'div');
  if (id) node.id = id;
  if (classes.length) node.className = classes.join(' ');
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') node.className = [node.className, value].filter(Boolean).join(' ');
      else if (key === 'text') node.textContent = value;
      else if (key === 'style') node.setAttribute('style', value);
      else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key in node && typeof node[key] !== 'function') node[key] = value;
      else node.setAttribute(key, value === true ? '' : value);
    }
  }
  append(node, kids);
  return node;
}

function append(node, kids) {
  for (const kid of kids) {
    if (kid === null || kid === undefined || kid === false) continue;
    if (Array.isArray(kid)) append(node, kid);
    else if (kid instanceof Node) node.appendChild(kid);
    else node.appendChild(document.createTextNode(String(kid)));
  }
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/** 一个线性图标。d 用 | 分成多条 path，全部继承 currentColor。 */
function icon(d, size = 15) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.style.flex = 'none';
  for (const one of d.split('|')) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', one);
    svg.appendChild(path);
  }
  return svg;
}

const ICON = {
  overview: 'M4 13h7V4H4zM13 20h7v-9h-7zM4 20h7v-4H4zM13 8h7V4h-7z',
  kbs: 'M4 5.5A2 2 0 016 4h12v16H6a2 2 0 01-2-2z|M8 8h7M8 12h7',
  token: 'M15 7a4 4 0 11-3.5 5.9L7 17.4V21H3v-4l8.5-8.5A4 4 0 0115 7z',
  activity: 'M3 12h4l3 7 4-14 3 7h4',
  wrench: 'M14.5 4a5 5 0 00-6.2 6.2L3 15.5 8.5 21l5.3-5.3A5 5 0 0020 9.5l-3 3-2.5-2.5 3-3A5 5 0 0014.5 4z',
  config: 'M12 15a3 3 0 100-6 3 3 0 000 6z|M4.6 15.5a1.6 1.6 0 00-1.5-1.1H3a2 2 0 010-4h.1a1.6 1.6 0 001.5-1.1 1.6 1.6 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.6 1.6 0 001.8.3 1.6 1.6 0 001.1-1.5V3a2 2 0 014 0v.1a1.6 1.6 0 001.1 1.5 1.6 1.6 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 00-.3 1.8 1.6 1.6 0 001.5 1.1H21a2 2 0 010 4h-.1a1.6 1.6 0 00-1.5 1.1 1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-1.8-.3 1.6 1.6 0 00-1.1 1.5V21a2 2 0 01-4 0v-.1a1.6 1.6 0 00-1.1-1.5 1.6 1.6 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.6 1.6 0 00.3-1.8z',
  configs: 'M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z|M4 7v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7|M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  logout: 'M9 20H5a2 2 0 01-2-2V6a2 2 0 012-2h4|M16 17l5-5-5-5|M21 12H9',
  refresh: 'M21 12a9 9 0 11-2.6-6.4|M21 3v6h-6',
  copy: 'M9 9h10v10H9z|M5 15V5h10',
  download: 'M12 3v12|M7 11l5 5 5-5|M4 21h16',
  trash: 'M4 7h16|M9 7V5h6v2|M6 7l1 13h10l1-13',
  close: 'M6 6l12 12|M18 6L6 18',
  warn: 'M12 3l10 17H2z|M12 10v5|M12 17.4v.1',
  ok: 'M20 6L9 17l-5-5',
  menu: 'M4 7h16|M4 12h16|M4 17h16',
  eye: 'M2.5 12C5 7 8.5 4.8 12 4.8S19 7 21.5 12C19 17 15.5 19.2 12 19.2S5 17 2.5 12z|M12 15a3 3 0 100-6 3 3 0 000 6z',
  moon: 'M20 14.5A8.5 8.5 0 019.5 4a8.5 8.5 0 1010.5 10.5z',
};

// ── 格式化 ─────────────────────────────────────────────────────────────────

function bytes(n) {
  if (n === null || n === undefined) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return unit === 0 ? `${n} B` : `${value.toFixed(1)} ${units[unit]}`;
}

function pad(n) { return String(n).padStart(2, '0'); }

function stamp(ms, withSeconds) {
  if (!ms) return '—';
  const d = new Date(ms);
  const date = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}${withSeconds ? ':' + pad(d.getSeconds()) : ''}`;
  return `${date} ${time}`;
}

function clockNow() {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function ago(ms) {
  if (!ms) return '从未';
  const diff = Date.now() - ms;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `今天 ${stamp(ms).slice(6)}`;
  if (diff < 172_800_000) return '昨天';
  return stamp(ms);
}

function duration(ms) {
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return `${Math.max(1, Math.floor(ms / 60_000))} 分钟`;
  if (hours < 48) return `${hours} 小时`;
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
}

const ACTIONS = {
  'create': ['创建', 'ok'],
  'replace': ['替换', 'ok'],
  'delete': ['删除', 'warn'],
  'download': ['下载', 'muted'],
  'create-kb': ['建库', 'ok'],
  'config-create': ['建配置档', 'ok'],
  'config-upload': ['推配置', 'ok'],
  'config-download': ['拉配置', 'muted'],
  'config-rename': ['配置改名', 'muted'],
  'config-delete': ['删配置', 'bad'],
  'delete-kb': ['删库', 'bad'],
  'rename-kb': ['改名', 'muted'],
  'unauthorized': ['被拒', 'bad'],
  'admin-login': ['后台登录', 'muted'],
  'config': ['改配置', 'muted'],
  'restart': ['重启', 'muted'],
};

// ── 与服务端说话 ───────────────────────────────────────────────────────────

class ApiError extends Error {
  constructor(status, code, message) {
    super(message || '请求失败');
    this.status = status;
    this.code = code;
  }
}

async function api(path, options = {}) {
  const init = {
    method: options.method || 'GET',
    credentials: 'same-origin',
    headers: {},
  };
  if (options.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  let response;
  try {
    response = await fetch('/admin/api' + path, init);
  } catch (e) {
    setOffline(true);
    throw new ApiError(0, 'offline', '连不上服务器');
  }
  setOffline(false);
  if (response.status === 204) return null;
  const text = await response.text();
  let payload = null;
  if (text) { try { payload = JSON.parse(text); } catch { payload = null; } }
  if (!response.ok) {
    // 401 在这里统一处理：任何一个请求发现会话没了，就整页回到登录，
    // 并记住当前 hash —— 重新登录后回到原来那一页，不丢上下文。
    if (response.status === 401 && !options.noAuthRedirect) {
      S.auth = false;
      S.returnTo = location.hash || '#/overview';
      render();
    }
    throw new ApiError(response.status, (payload && payload.code) || 'error', payload && payload.message);
  }
  return payload;
}

// ── 全局状态 ───────────────────────────────────────────────────────────────

const S = {
  auth: false,
  anonymous: false,
  /// 匿名模式下，操作者点过「仍然进入」没有。默认 false：一台关掉了鉴权的服务器
  /// 直接把后台放进来，等于把它最该被看见的状态藏了起来。
  anonymousAck: false,
  adminConfigured: true,
  username: '',
  expiresAtMs: 0,
  view: 'overview',
  param: '',
  returnTo: '',
  offline: false,
  refreshedAt: '',
  cache: {},
};

function setOffline(value) {
  if (S.offline === value) return;
  S.offline = value;
  const banner = document.getElementById('offline-banner');
  if (banner) banner.classList.toggle('hidden', !value);
  if (value) startReconnect();
}

let reconnectTimer = null;
function startReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setInterval(async () => {
    try {
      await fetch('/health', { cache: 'no-store' });
      clearInterval(reconnectTimer);
      reconnectTimer = null;
      setOffline(false);
      route();
    } catch { /* 还没回来，下一轮再试 */ }
  }, 5000);
}

// ── toast / 模态 ───────────────────────────────────────────────────────────

/**
 * 带退场地移走一个浮层：加 `.closing`，动画/过渡放完再从 DOM 里摘掉。
 *
 * 收尾**不能**用一个写死的 setTimeout 对齐 CSS 里的时长：`prefers-reduced-motion`
 * 把全站动画压到 .01ms（app.css 末尾那条覆盖），那时候固定等待会让一个已经
 * 看不见的节点又挡上几百毫秒。所以听 animationend / transitionend，
 * 另留一个兜底 —— 标签页在后台时动画根本不跑，那两个事件一个都不会来。
 */
function dismiss(node) {
  if (node.classList.contains('closing')) return;
  node.classList.add('closing');
  const done = () => node.remove();
  node.addEventListener('animationend', done, { once: true });
  node.addEventListener('transitionend', done, { once: true });
  setTimeout(done, 400);
}

function toast(message, bad) {
  const host = document.getElementById('toasts');
  const node = el('div.toast' + (bad ? '.bad' : ''), null,
    icon(bad ? ICON.warn : ICON.ok, 14),
    el('span', { text: message }));
  host.appendChild(node);
  setTimeout(() => dismiss(node), 4000);
}

function reportError(e) {
  if (e instanceof ApiError && e.status === 401) return;
  toast((e && e.message) || '出错了', true);
}

/** 一个模态。`build(close)` 返回内容节点。 */
function modal(build, wide) {
  const backdrop = el('div.backdrop');
  const close = () => { dismiss(backdrop); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const panel = el('div.modal' + (wide ? '.wide' : ''));
  append(panel, [build(close)]);
  backdrop.appendChild(panel);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(backdrop);
  const first = panel.querySelector('input, button');
  if (first) first.focus();
  return close;
}

/**
 * 破坏性操作的确认框。
 *
 * `typeToConfirm` 存在时，按钮一直禁用到用户把那个字面量敲进去 —— 删掉一个知识库
 * 没有回收站，而"确定吗"这三个字挡不住任何人。
 */
function confirmDanger({ title, body, typeToConfirm, confirmLabel, onConfirm }) {
  modal((close) => {
    const input = typeToConfirm
      ? el('input', { type: 'text', placeholder: typeToConfirm, autocomplete: 'off' })
      : null;
    const go = el('button.btn.btn-solid-danger', {
      text: confirmLabel || '删除',
      disabled: !!typeToConfirm,
      onClick: async () => {
        go.disabled = true;
        try { await onConfirm(); close(); }
        catch (e) { go.disabled = false; reportError(e); }
      },
    });
    if (input) {
      input.addEventListener('input', () => { go.disabled = input.value.trim() !== typeToConfirm; });
    }
    return el('div', null,
      el('h3', { text: title }),
      el('p', null, body),
      input && el('div.field', null,
        el('label', null, '输入 ', el('span.mono', { text: typeToConfirm }), ' 以确认：'),
        input),
      el('div.foot', null,
        el('button.btn', { text: '取消', onClick: close }),
        go));
  });
}

function copyable(text, label) {
  return el('button.icon-btn', {
    title: '复制',
    onClick: async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(text);
        toast((label || '内容') + '已复制');
      } catch {
        toast('浏览器不让复制，请手动选中', true);
      }
    },
  }, icon(ICON.copy, 13));
}

function codeBlock(text) {
  return el('div.code', null,
    el('button', { text: '复制', onClick: async () => {
      try { await navigator.clipboard.writeText(text); toast('已复制'); }
      catch { toast('浏览器不让复制，请手动选中', true); }
    } }),
    text);
}

// ── 路由与外壳 ─────────────────────────────────────────────────────────────

const VIEWS = [
  { id: 'overview', label: '总览', icon: ICON.overview },
  { id: 'kbs', label: '知识库', icon: ICON.kbs },
  { id: 'tokens', label: 'Token', icon: ICON.token },
  { id: 'activity', label: '活动日志', icon: ICON.activity },
  { id: 'configs', label: '配置备份', icon: ICON.configs },
  { id: 'maintenance', label: '维护与备份', icon: ICON.wrench },
  { id: 'config', label: '配置', icon: ICON.config },
];

function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

function parseHash() {
  const raw = (location.hash || '#/overview').slice(2);
  const [view, ...rest] = raw.split('/');
  return { view: view || 'overview', param: decodeURIComponent(rest.join('/') || '') };
}

async function route() {
  const { view, param } = parseHash();
  S.view = view;
  S.param = param;
  render();
}

function render() {
  const root = document.getElementById('root');
  root.className = '';
  clear(root);
  if (!S.auth) { root.appendChild(loginView()); return; }
  root.appendChild(shell());
}

function shell() {
  const body = el('div.page-body', null, el('div.skeleton', { style: 'height:80px' }));
  const nav = navPanel();
  const wrap = el('div.shell', null,
    nav,
    el('div.main', null,
      el('div#offline-banner.offline' + (S.offline ? '' : '.hidden'), null,
        icon(ICON.warn, 14),
        el('span', null, '服务器不可达——正在每 5 秒重试。页面上的数据是断线前的快照，操作已禁用。'),
        el('span.grow'),
        el('button.btn', { text: '立即重试', onClick: () => route() })),
      mobileBar(nav),
      body));

  const view = VIEWS.find((v) => v.id === S.view) || VIEWS[0];
  const renderer = RENDERERS[view.id];
  Promise.resolve()
    .then(() => renderer(body))
    .catch((e) => {
      clear(body);
      body.appendChild(el('div.panel', null,
        el('h3', null, '这一页没能加载出来'),
        el('p.note', { text: e?.message || String(e) }),
        el('div.btn-row', { style: 'margin-top:14px' },
          el('button.btn', { text: '重试', onClick: () => route() }))));
      if (!(e instanceof ApiError)) console.error(e);
    });
  return wrap;
}

function mobileBar(nav) {
  return el('div.sheet-nav', null,
    el('button.icon-btn', {
      onClick: () => {
        nav.classList.add('open');
        const scrim = el('div.nav-scrim', { onClick: () => { nav.classList.remove('open'); scrim.remove(); } });
        document.body.appendChild(scrim);
      },
    }, icon(ICON.menu, 18)),
    el('b', { text: (VIEWS.find((v) => v.id === S.view) || VIEWS[0]).label }),
    el('span.grow'),
    S.cache.version ? el('span.faint.mono', { text: 'v' + S.cache.version }) : null);
}

function navPanel() {
  const items = VIEWS.map((view) =>
    el('button.nav-item' + (view.id === S.view ? '.on' : ''), {
      onClick: () => { S.navOpen = false; document.querySelector('.nav-scrim')?.remove(); go('#/' + view.id); },
    }, icon(view.icon, 15), el('span', { text: view.label })));

  return el('nav.nav', null,
    el('div.nav-head', null,
      el('b', null, 'KB Admin'),
      el('div', { text: location.host })),
    el('div.nav-items', null, items),
    el('div.nav-foot', null,
      el('div.avatar', { text: (S.username || '?').slice(0, 1).toUpperCase() }),
      el('div.who', null,
        el('b', { text: S.username || '匿名' }),
        el('span', { text: S.anonymous ? '匿名模式' : (S.expiresAtMs ? '会话剩 ' + duration(S.expiresAtMs - Date.now()) : '') })),
      el('button.icon-btn', { title: '切换主题', onClick: cycleTheme }, icon(ICON.moon, 15)),
      !S.anonymous && el('button.icon-btn', {
        title: '退出登录',
        onClick: async () => {
          try { await api('/logout', { method: 'POST' }); } catch { /* 本来就没登录 */ }
          S.auth = false;
          render();
        },
      }, icon(ICON.logout, 15))));
}

function cycleTheme() {
  const order = ['auto', 'light', 'dark'];
  const current = document.documentElement.dataset.theme || 'auto';
  const next = order[(order.indexOf(current) + 1) % order.length];
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('aiw-kb-theme', next); } catch { /* 无痕模式 */ }
  toast({ auto: '主题：跟随系统', light: '主题：纸面', dark: '主题：夜间' }[next]);
}

function pageHead(title, ...extras) {
  return el('div.page-head', null, el('h1', { text: title }), extras);
}

function refreshButton(onClick) {
  return [
    el('span.grow'),
    el('span.refreshed', { text: S.refreshedAt ? '最后刷新于 ' + S.refreshedAt : '' }),
    el('button.btn', { onClick }, icon(ICON.refresh, 13), el('span', { style: 'margin-left:6px' }, '刷新')),
  ];
}

// ── 07-1 登录 ──────────────────────────────────────────────────────────────

function loginView() {
  const user = el('input', { type: 'text', value: S.username || 'admin', autocomplete: 'username' });
  const pass = el('input', { type: 'password', autocomplete: 'current-password' });
  const errorSlot = el('div');
  const submit = el('button.btn.btn-primary.btn-block', { text: '登录' });

  const doLogin = async () => {
    clear(errorSlot);
    submit.disabled = true;
    try {
      await api('/login', {
        method: 'POST',
        body: { username: user.value, password: pass.value },
        noAuthRedirect: true,
      });
      await boot();
      if (S.returnTo) { const to = S.returnTo; S.returnTo = ''; go(to); }
      else go('#/overview');
    } catch (e) {
      // 用户名和密码分不清是哪个错了 —— 服务端不说，这里也不猜。
      errorSlot.appendChild(el('div.error-line', null,
        e.code === 'locked_out' ? icon(ICON.warn, 13) : null,
        el('span', { text: e.message || '登录失败' })));
      pass.value = '';
      pass.focus();
    } finally {
      submit.disabled = false;
    }
  };
  submit.addEventListener('click', doLogin);
  for (const field of [user, pass]) {
    field.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  }

  const probe = el('div.probe', null, el('span.dot'), el('span', null, '正在探测服务器…'));
  fetch('/health', { cache: 'no-store' })
    .then((r) => r.json())
    .then((health) => {
      clear(probe);
      append(probe, [
        el('span.dot.ok.live'),
        el('span', { text: '服务器可达' }),
        el('span.mono.faint', { text: `GET /health · 200 · ${health.service} ${health.version}` }),
      ]);
    })
    .catch(() => {
      clear(probe);
      append(probe, [el('span.dot.err'), el('span', null, '服务器不可达——地址对吗？')]);
    });

  const card = el('div.card', null,
    el('h2', null, '解锁管理后台'),
    el('p.sub', null, '这是服务器管理后台的账户，在配置文件的 ',
      el('span.mono', null, '[admin]'), ' 段里。它与 app 里填的同步 token 不是一回事。'),
    errorSlot,
    el('div.field', null, el('label', null, '用户名'), user),
    el('div.field', null, el('label', null, '密码'),
      el('div.with-suffix', null, pass,
        el('button', {
          type: 'button', title: '显示密码',
          onClick: () => { pass.type = pass.type === 'password' ? 'text' : 'password'; },
        }, icon(ICON.eye, 15)))),
    submit);

  const disabled = !S.adminConfigured
    ? el('div.card', { style: 'margin-top:14px' },
        el('h2', null, '管理后台还没有账户'),
        el('p.sub', null, '配置文件里没有 ', el('span.mono', null, '[admin]'),
          ' 段，所以这个后台是关着的。加上下面两行然后重启服务：'),
        codeBlock('[admin]\nusername = "admin"\npassword = "换成你自己的密码"'))
    : null;

  return el('div.login-wrap', null,
    el('div.login', null,
      el('div.login-brand', null, el('b', null, 'Simple AI Writer'), el('span', null, 'KB SERVER · 管理后台')),
      S.anonymous ? anonymousCard() : card,
      disabled,
      probe));
}

/**
 * 匿名模式下的登录页变体（设计稿 07-1b）。
 *
 * 这里不要求密码，是因为 allow_anonymous 关掉的是整台服务器的鉴权 —— 同步 API
 * 已经对所有人敞开了，再给后台上一把锁，只是在没有墙的房子上锁一扇门。
 */
function anonymousCard() {
  return el('div.card', { style: 'border-left:3px solid var(--err)' },
    el('div', { style: 'display:flex; align-items:center; gap:9px; margin-bottom:10px; color:var(--err)' },
      icon(ICON.warn, 15),
      el('b', { style: 'font:600 15px var(--serif)' }, '该服务器未启用鉴权')),
    el('p.sub', null, '它以 ', el('span.mono', null, 'allow_anonymous = true'),
      ' 启动——任何能访问它的人都能读写全部知识库。除非它只监听 ',
      el('span.mono', null, '127.0.0.1'), ' 或在可信内网里，否则请立刻关掉。'),
    codeBlock('[server]\nallow_anonymous = false'),
    el('button.btn.btn-block', {
      style: 'margin-top:14px',
      text: '仍然进入（无需登录）',
      onClick: async () => { S.anonymousAck = true; await boot(); go('#/overview'); },
    }));
}

// ── 07-2 总览 ──────────────────────────────────────────────────────────────

async function renderOverview(body) {
  const data = await api('/overview');
  S.refreshedAt = clockNow();
  S.cache.version = data.server.version;
  clear(body);

  const head = pageHead('总览', ...refreshButton(() => route()));
  body.parentNode.insertBefore(head, body);

  const server = data.server;
  body.appendChild(el('div.strip', null,
    el('div', { style: 'display:flex; align-items:center; gap:9px' },
      el('span.dot.ok.live'),
      el('b', { style: 'font-size:13px' }, '运行中'),
      el('span.faint', { style: 'font-size:11.5px' },
        `v${server.version} · 已运行 ${duration(server.uptimeMs)}`)),
    el('div.sep'),
    el('div.kv', null, el('label', null, '监听'), el('div', { text: server.bind })),
    el('div.sep'),
    el('div.kv', null, el('label', null, '数据目录'),
      el('div', null, el('span', { text: server.dataDir }), copyable(server.dataDir, '路径'))),
    el('div.sep'),
    el('div.kv', null, el('label', null, '配置文件'),
      el('div', null, el('span', { text: server.configPath }), copyable(server.configPath, '路径')))));

  const stats = data.stats;
  body.appendChild(el('div.grid-4', { style: 'margin-top:16px' },
    tile('知识库', stats.kbs, 'GET /v1/kbs'),
    tile('条目总数', stats.entries, 'Σ kb.entryCount'),
    tile('占用空间', ...splitBytes(stats.bytes), 'Σ entries[].size'),
    tile('24h 写入', stats.writes24h, 'audit.log')));

  const recent = el('div.panel', null,
    el('h3', null, '最近活动', el('span.grow'),
      el('a', { href: '#/activity' }, '查看全部 →')));
  if (!data.recent.length) {
    recent.appendChild(el('p.note', null, '还没有任何写入。app 第一次推送之后，这里就会有东西。'));
  } else {
    for (const event of data.recent) recent.appendChild(activityLine(event));
  }

  const notices = el('div.panel', null, el('h3', null, '需要注意'));
  if (!data.notices.length) {
    notices.appendChild(el('div', { style: 'display:flex; gap:9px; align-items:center; color:var(--ok)' },
      icon(ICON.ok, 15), el('span', { style: 'font-size:12.5px' }, '没有需要处理的事。')));
  }
  for (const notice of data.notices) {
    notices.appendChild(el('div.notice' + (notice.level === 'error' ? '.error' : ''), null,
      el('b', { text: notice.title }),
      el('p', { text: notice.body }),
      // 每条警告都带一个能按的按钮 —— 一条只会说"有问题"的提示，等于没提示。
      el('button.btn', { text: notice.actionLabel, onClick: () => go('#/' + notice.action) })));
  }

  body.appendChild(el('div.split', { style: 'margin-top:16px' }, recent, notices));
}

function splitBytes(n) {
  const text = bytes(n);
  const [value, unit] = text.split(' ');
  return [value, unit];
}

function tile(label, value, unitOrSrc, maybeSrc) {
  const unit = maybeSrc === undefined ? null : unitOrSrc;
  const src = maybeSrc === undefined ? unitOrSrc : maybeSrc;
  return el('div.tile', null,
    el('label', { text: label }),
    el('b', null, String(value), unit ? el('small', { text: unit }) : null),
    el('div.src', { text: src }));
}

function activityLine(event) {
  const [label, tone] = ACTIONS[event.action] || [event.action, 'muted'];
  const bad = event.status >= 400;
  return el('div', {
    style: 'display:flex; gap:10px; align-items:baseline; padding:7px 0; border-bottom:1px solid var(--border-soft); font-size:12px',
  },
    el('span.mono.faint', { style: 'flex:none; width:40px', text: stamp(event.atMs).slice(6) }),
    el('span', { style: `flex:none; width:52px; color:var(--${tone === 'bad' ? 'err' : tone === 'ok' ? 'ok' : 'muted'})`, text: label }),
    el('span', { style: 'flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap',
      text: [event.kb, event.path].filter(Boolean).join(' / ') }),
    el('span.faint', { style: 'flex:none; font-size:11px', text: event.device || '未知设备' }),
    el('span.status' + (bad ? '.bad' : ''), { text: String(event.status) }));
}

// ── 07-3 知识库列表 ────────────────────────────────────────────────────────

async function renderKbs(body) {
  const data = await api('/kbs');
  S.refreshedAt = clockNow();
  clear(body);

  const total = data.kbs.reduce((sum, kb) => sum + (kb.bytes || 0), 0);
  const search = el('input.search', { type: 'text', placeholder: '搜索名称或 id' });
  const sort = el('select.compact', null,
    el('option', { value: 'updated', text: '最近更新' }),
    el('option', { value: 'name', text: '名称' }),
    el('option', { value: 'bytes', text: '体积' }));

  const head = pageHead('知识库',
    el('span.tag', { text: `${data.kbs.length} 个 · ${bytes(total)}` }),
    el('span.grow'),
    search, sort,
    el('button.btn.btn-primary', { text: '+ 新建知识库', onClick: () => createKbModal() }));
  body.parentNode.insertBefore(head, body);

  const list = el('div.rows');
  const draw = () => {
    clear(list);
    const needle = search.value.trim().toLowerCase();
    let rows = data.kbs.filter((kb) =>
      !needle || kb.name.toLowerCase().includes(needle) || kb.id.toLowerCase().includes(needle));
    const mode = sort.value;
    rows.sort((a, b) => mode === 'name' ? a.name.localeCompare(b.name, 'zh')
      : mode === 'bytes' ? b.bytes - a.bytes
      : b.updatedAtMs - a.updatedAtMs);

    if (!data.kbs.length) { list.appendChild(emptyKbs()); return; }
    if (!rows.length) {
      list.appendChild(el('div.empty', null,
        el('b', { text: `没有匹配「${search.value.trim()}」的知识库` }),
        el('button.btn', { text: '清除搜索', onClick: () => { search.value = ''; draw(); } })));
      return;
    }
    for (const kb of rows) list.appendChild(kbRow(kb));
  };
  search.addEventListener('input', draw);
  sort.addEventListener('change', draw);
  draw();

  body.appendChild(list);
  body.appendChild(el('p.note', { style: 'margin-top:12px' },
    '行数据 ← GET /admin/api/kbs · 名称=kb.name · id=kb.id · 条目=kb.entryCount · 更新=kb.updatedAtMs · 设备=kb.lastDevice（可缺失）'));
}

function kbRow(kb) {
  return el('div.row', null,
    el('div.grow', { style: 'min-width:0' },
      el('div.title', null,
        el('b', { text: kb.name }),
        el('span.id', { text: kb.id })),
      el('div.meta', null,
        el('span', null, el('b', { text: String(kb.entryCount) }), ' 条'),
        el('span', null, el('b', { text: bytes(kb.bytes) })),
        el('span', null, '最后更新 ',
          el('span.mono', { text: kb.updatedAtMs ? stamp(kb.updatedAtMs) : '—' }),
          ' · ',
          kb.lastDevice
            ? el('span', { text: '来自 ' + kb.lastDevice })
            : el('span.faint', null, '设备未上报')),
        kb.digest && el('span.mono', { title: kb.digest, text: 'digest ' + kb.digest.slice(0, 8) }))),
    el('div.actions', null,
      el('button.btn', { text: '打开', onClick: () => go('#/kbs/' + encodeURIComponent(kb.id)) }),
      el('button.btn', { text: '重命名', onClick: () => renameKbModal(kb) }),
      el('button.btn.btn-danger', { text: '删除', onClick: () => deleteKbModal(kb) })));
}

function emptyKbs() {
  return el('div.empty', null,
    el('b', null, '这台服务器上还没有知识库'),
    el('div.steps', null,
      el('div.step', null, el('i', null, '1'), '在 Simple AI Writer 里打开 设置 → 知识库同步，填入这台服务器的地址和一个同步 token'),
      el('div.step', null, el('i', null, '2'), '新建或选择一个知识库，把当前项目绑定到它'),
      el('div.step', null, el('i', null, '3'), '第一次「推送到远端」之后，它就会出现在这里')),
    el('button.btn.btn-primary', { text: '也可以直接在这里新建', onClick: () => createKbModal() }));
}

/**
 * 服务端 `slug_for_kb_name` 的预览。
 *
 * 名字里一个 ASCII 字符都没有时，服务端用的是 `kb-<名称摘要前 6 位>`——那要算
 * sha256，这里不算：预览一个算错的 id 比不预览更糟。这种情况直接说明它会长什么样。
 */
function slugPreview(name) {
  let out = '', lastDash = false;
  for (const ch of name.toLowerCase()) {
    if (/[a-z0-9]/.test(ch)) { out += ch; lastDash = false; }
    else if (!lastDash && out) { out += '-'; lastDash = true; }
  }
  out = out.replace(/-+$/, '').slice(0, 48);
  return out || null;
}

function createKbModal() {
  modal((close) => {
    const name = el('input', { type: 'text', placeholder: '东海奇谭' });
    const id = el('input', { type: 'text', placeholder: 'ascii-slug', autocomplete: 'off' });
    const preview = el('div.note', { style: 'margin-top:6px' });
    const errorSlot = el('div');
    const update = () => {
      clear(preview);
      const chosen = id.value.trim() || slugPreview(name.value.trim());
      if (chosen) {
        append(preview, ['将创建为 ', el('span.mono', { text: chosen })]);
      } else if (name.value.trim()) {
        append(preview, ['将创建为 ', el('span.mono', null, 'kb-<名称摘要>'),
          el('span.faint', null, '　（名称里没有 ASCII 字符，id 由服务端按名称生成）')]);
      }
    };
    name.addEventListener('input', update);
    id.addEventListener('input', update);
    update();

    const create = el('button.btn.btn-primary', {
      text: '创建',
      onClick: async () => {
        clear(errorSlot);
        create.disabled = true;
        try {
          const kb = await api('/kbs', {
            method: 'POST',
            body: { name: name.value.trim(), id: id.value.trim() || undefined },
          });
          close();
          toast(`已创建「${kb.name}」`);
          go('#/kbs/' + encodeURIComponent(kb.id));
        } catch (e) {
          create.disabled = false;
          errorSlot.appendChild(el('div.error-line', null,
            el('b.mono', { text: e.code }), ' ', el('span', { text: e.message })));
        }
      },
    });

    return el('div', null,
      el('h3', null, '新建知识库'),
      errorSlot,
      el('div.field', null, el('label', null, '显示名'), name),
      el('div.field', null,
        el('label', null, 'ID（可选，留空由服务端生成）'), id, preview),
      el('div.foot', null,
        el('button.btn', { text: '取消', onClick: close }),
        create));
  });
}

function renameKbModal(kb) {
  modal((close) => {
    const name = el('input', { type: 'text', value: kb.name });
    return el('div', null,
      el('h3', null, '重命名'),
      el('p', null, '只改显示名。', el('b', null, 'id 不能改'),
        '——它是每台机器的绑定地址和每个 URL 的一部分，改掉等于把所有机器悄悄解绑。'),
      el('div.field', null, el('label', null, '显示名'), name),
      el('div.field', null, el('label', null, 'ID（不可改）'),
        el('div.mono.faint', { text: kb.id })),
      el('div.foot', null,
        el('button.btn', { text: '取消', onClick: close }),
        el('button.btn.btn-primary', {
          text: '保存',
          onClick: async () => {
            try {
              await api('/kbs/' + encodeURIComponent(kb.id), { method: 'PATCH', body: { name: name.value } });
              close();
              toast('已改名');
              route();
            } catch (e) { reportError(e); }
          },
        })));
  });
}

function deleteKbModal(kb) {
  confirmDanger({
    title: `删除「${kb.name}」？`,
    body: el('span', null,
      '服务器上这 ', el('b', { text: String(kb.entryCount) }), ' 个条目（',
      el('b', { text: bytes(kb.bytes) }), '）会被永久删除，', el('b', null, '没有回收站'),
      '。这不会影响任何一台机器上的本地副本——但之后它们再也拉不回来了。'),
    typeToConfirm: kb.id,
    confirmLabel: '永久删除',
    onConfirm: async () => {
      await api('/kbs/' + encodeURIComponent(kb.id), { method: 'DELETE' });
      toast(`已删除「${kb.name}」`);
      go('#/kbs');
    },
  });
}

// ── 07-4 / 07-5 知识库详情 + 条目抽屉 ──────────────────────────────────────

const PAGE_SIZE = 200;

async function renderKbDetail(body) {
  const id = S.param;
  if (!id) { go('#/kbs'); return; }
  const data = await api('/kbs/' + encodeURIComponent(id));
  S.refreshedAt = clockNow();
  clear(body);

  const kb = data.kb;
  const head = el('div.page-head', null,
    el('div', { style: 'width:100%' },
      el('div', { style: 'font-size:12px; color:var(--muted); margin-bottom:6px' },
        el('a', { href: '#/kbs' }, '知识库'), ' / ', el('span', { text: kb.name })),
      el('div', { style: 'display:flex; align-items:baseline; gap:12px; flex-wrap:wrap' },
        el('h1', { text: kb.name }),
        el('span.mono.faint', { text: kb.id }),
        el('span.grow'),
        el('span.refreshed', { text: '最后刷新于 ' + S.refreshedAt }),
        el('button.btn', { onClick: () => route() }, icon(ICON.refresh, 13)),
        el('a.btn.btn-tinted', {
          href: `/admin/api/kbs/${encodeURIComponent(kb.id)}/backup.tar.gz`,
          style: 'text-decoration:none',
        }, '下载整库备份'))));
  body.parentNode.insertBefore(head, body);

  body.appendChild(el('div.strip', null,
    el('span.mono', { title: kb.digest || '', style: 'cursor:pointer' },
      'digest ' + (kb.digest || '').slice(0, 12)),
    kb.digest ? copyable(kb.digest, 'digest') : null,
    el('div.sep'),
    el('span', null, el('b', { text: data.entries.length.toLocaleString() }), ' 条'),
    el('div.sep'),
    el('span', null, el('b', { text: bytes(kb.bytes) })),
    el('div.sep'),
    el('span.faint', { style: 'font-size:11.5px', text: kb.lastDevice ? '最后写入来自 ' + kb.lastDevice : '还没有被写过' }),
    el('span.grow'),
    el('span.mono.faint', { style: 'font-size:10.5px', text: `GET /v1/kbs/${kb.id}/manifest` })));

  if (!data.entries.length) { body.appendChild(emptyKb(kb)); return; }

  // 筛选状态放在闭包里，不进全局 —— 它只对这一次渲染有意义。
  let category = '';
  let needle = '';
  const selected = new Set();

  const search = el('input.search.wide', { type: 'text', placeholder: '按 path 搜索' });
  const chips = el('div.chips');
  const table = el('div.table');
  const bulk = el('div', { class: 'hidden' });

  const drawChips = () => {
    clear(chips);
    chips.appendChild(el('button.chip' + (category === '' ? '.on' : ''), {
      text: `全部 ${data.entries.length.toLocaleString()}`,
      onClick: () => { category = ''; drawChips(); drawTable(); },
    }));
    for (const cat of data.categories) {
      chips.appendChild(el('button.chip' + (category === cat.name ? '.on' : ''), {
        text: `${cat.name} ${cat.count.toLocaleString()}`,
        onClick: () => { category = cat.name; drawChips(); drawTable(); },
      }));
    }
  };

  const drawBulk = () => {
    clear(bulk);
    bulk.className = selected.size ? 'strip' : 'hidden';
    if (!selected.size) return;
    append(bulk, [
      el('span', null, '已选 ', el('b', { text: String(selected.size) }), ' 条'),
      el('span.grow'),
      el('button.btn.btn-danger', {
        text: '批量删除',
        onClick: () => confirmDanger({
          title: `删除选中的 ${selected.size} 个条目？`,
          body: '这些条目会从服务器上永久消失。本地副本不受影响，但之后拉不回来了。',
          confirmLabel: `删除 ${selected.size} 条`,
          onConfirm: async () => {
            const result = await api(`/kbs/${encodeURIComponent(kb.id)}/entries/delete`, {
              method: 'POST',
              body: { paths: [...selected] },
            });
            toast(`已删除 ${result.deleted} 条` + (result.failed.length ? `，${result.failed.length} 条失败` : ''),
              result.failed.length > 0);
            route();
          },
        }),
      }),
      el('button.icon-btn', { onClick: () => { selected.clear(); drawTable(); } }, icon(ICON.close, 14)),
    ]);
  };

  const drawTable = () => {
    clear(table);
    const rows = data.entries.filter((entry) =>
      (!category || entry.path.startsWith(category + '/')) &&
      (!needle || entry.path.toLowerCase().includes(needle)));

    table.appendChild(el('div.th', { style: rowGrid() },
      el('span'), el('span', null, '路径 PATH'), el('span', null, 'HASH'),
      el('span.right', null, '体积'), el('span', null, '更新时间'), el('span')));

    if (!rows.length) {
      table.appendChild(el('div.empty', null,
        el('b', { text: `没有匹配「${needle}」的条目` }),
        el('p', null, '搜索只按 path 匹配——服务端不解析条目内容，正文里的词搜不到。'),
        el('button.btn', { text: '清除搜索', onClick: () => { search.value = ''; needle = ''; drawTable(); } })));
      drawBulk();
      return;
    }

    // 一次只挂 200 行，滚到底再挂下一批。三千个条目全渲染是三千个 DOM 节点，
    // 每次敲一下筛选框就重建一遍 —— 分批不是优化，是这一页能用的前提。
    let drawn = 0;
    let lastGroup = null;
    const sentinel = el('div', { style: 'height:1px' });

    const drawBatch = () => {
      const slice = rows.slice(drawn, drawn + PAGE_SIZE);
      for (const entry of slice) {
        const group = entry.path.split('/')[0];
        if (group !== lastGroup) {
          lastGroup = group;
          const stats = data.categories.find((c) => c.name === group);
          table.insertBefore(el('div.group', null,
            el('b', { text: group + '/' }),
            stats && el('span', { text: `${stats.count.toLocaleString()} 条 · ${bytes(stats.bytes)}` })), sentinel);
        }
        table.insertBefore(entryRow(kb, entry, selected, drawBulk), sentinel);
      }
      drawn += slice.length;
      if (drawn >= rows.length) {
        sentinel.textContent = '';
        observer.disconnect();
      }
    };

    const observer = new IntersectionObserver((items) => {
      if (items.some((i) => i.isIntersecting) && drawn < rows.length) drawBatch();
    }, { root: null, rootMargin: '400px' });

    table.appendChild(sentinel);
    drawBatch();
    observer.observe(sentinel);
    drawBulk();
  };

  search.addEventListener('input', () => { needle = search.value.trim().toLowerCase(); drawTable(); });

  body.appendChild(el('div', { style: 'display:flex; gap:12px; align-items:center; margin-top:16px; flex-wrap:wrap' },
    search, chips));
  body.appendChild(el('div.panel', { style: 'margin-top:12px; padding:6px 22px 14px' }, table));
  body.appendChild(bulk);
  drawChips();
  drawTable();
}

function rowGrid() {
  return 'grid-template-columns:32px minmax(0,1fr) 150px 84px 110px 96px';
}

function entryRow(kb, entry, selected, onSelectionChange) {
  const box = el('input', {
    type: 'checkbox',
    checked: selected.has(entry.path),
    onClick: (e) => {
      e.stopPropagation();
      if (box.checked) selected.add(entry.path); else selected.delete(entry.path);
      row.classList.toggle('on', box.checked);
      onSelectionChange();
    },
  });
  const row = el('div.tr' + (selected.has(entry.path) ? '.on' : ''), {
    style: rowGrid(),
    onClick: () => entryDrawer(kb, entry),
  },
    el('span', { style: 'display:grid; place-items:center' }, box),
    el('span', { style: 'overflow:hidden; text-overflow:ellipsis; white-space:nowrap', text: entry.path }),
    el('span.mono.faint', { title: entry.hash, text: entry.hash.slice(0, 12) }),
    el('span.right.mono', { style: 'font-size:11.5px', text: bytes(entry.size) }),
    el('span.mono.faint', { style: 'font-size:11.5px', text: stamp(entry.updatedAtMs) }),
    el('span', { style: 'display:flex; gap:4px; justify-content:flex-end' },
      el('a.icon-btn', {
        title: '下载 zip',
        href: entryUrl(kb.id, entry.path),
        onClick: (e) => e.stopPropagation(),
      }, icon(ICON.download, 13)),
      el('button.icon-btn', {
        title: '删除',
        onClick: (e) => { e.stopPropagation(); deleteEntry(kb, entry); },
      }, icon(ICON.trash, 13))));
  return row;
}

function entryUrl(kbId, path) {
  const [category, ...rest] = path.split('/');
  return `/admin/api/kbs/${encodeURIComponent(kbId)}/entries/${encodeURIComponent(category)}/${encodeURIComponent(rest.join('/'))}`;
}

function deleteEntry(kb, entry) {
  confirmDanger({
    title: '删除这个条目？',
    body: el('span', null,
      el('span.mono', { text: entry.path }),
      ' 会从服务器上永久删除。本地副本不受影响 —— 但下一次「从远端拉取」会把它在本地也镜像掉。'),
    onConfirm: async () => {
      await api(entryUrl(kb.id, entry.path).replace('/admin/api', ''), { method: 'DELETE' });
      toast('已删除 ' + entry.path);
      route();
    },
  });
}

function emptyKb(kb) {
  return el('div.panel', { style: 'margin-top:16px' },
    el('div.empty', null,
      el('b', null, '这个库还是空的'),
      el('p', null, '它已经可以被绑定。在 app 里把项目绑定到 ',
        el('span.mono', { text: kb.id }),
        '，第一次推送后条目会出现在这里。服务端不解析条目内容，这里只会展示路径、hash、体积和时间。'),
      el('div', { style: 'display:inline-flex; gap:10px; align-items:center; font-size:11.5px' },
        el('span.mono.faint', { text: 'digest ' + (kb.digest || '').slice(0, 12) }),
        el('span.faint', null, '空库指纹（空串 sha256）'))));
}

function entryDrawer(kb, entry) {
  const wrap = el('div.drawer-wrap');
  const close = () => { dismiss(wrap); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  document.addEventListener('keydown', onKey);

  const [category, ...rest] = entry.path.split('/');
  const name = rest.join('/');
  const base = location.origin;
  const curl = `# 下载\ncurl -H "Authorization: Bearer $TOKEN" \\\n  -o "${name}.zip" \\\n  "${base}/v1/kbs/${kb.id}/entries/${category}/${name}"\n\n# 替换（带并发保护）\ncurl -X PUT \\\n  -H "Authorization: Bearer $TOKEN" \\\n  -H "X-Entry-Hash: <新 hash>" \\\n  -H 'If-Match: "${entry.hash}"' \\\n  --data-binary @"${name}.zip" \\\n  "${base}/v1/kbs/${kb.id}/entries/${category}/${name}"`;

  wrap.appendChild(el('aside.drawer', null,
    el('div.drawer-head', null,
      el('div.path', null,
        el('div', { text: category + '/' }),
        el('b', { text: name })),
      el('button.icon-btn', { onClick: close }, icon(ICON.close, 16))),
    el('div.drawer-body', null,
      el('span.tag', { text: category }),
      el('dl.kv-list', { style: 'margin-top:16px' },
        el('dt', null, 'hash'),
        el('dd', null, el('span.mono', { style: 'word-break:break-all', text: entry.hash }), copyable(entry.hash, 'hash')),
        el('dt', null, '体积'),
        el('dd', null, el('span.mono', { text: entry.size.toLocaleString() + ' B' }), ' （', bytes(entry.size), '）'),
        el('dt', null, '更新时间'),
        el('dd', null, el('span.mono', { text: stamp(entry.updatedAtMs, true) }),
          el('span.faint', { style: 'margin-left:6px; font-size:11px' }, '(updatedAtMs)')),
        el('dt', null, '写入设备'),
        el('dd', null, kb.lastDevice || '未上报',
          el('span.faint', { style: 'margin-left:6px; font-size:11px' }, '(X-Source-Device)'))),
      el('p.note', { style: 'margin-top:16px' },
        '这个 hash 是客户端算出来的。服务端只把它当不透明令牌存储和比对，从不自己计算，也不解析 zip 里的内容。'),
      el('div.btn-row', { style: 'margin-top:18px' },
        el('a.btn.btn-primary', { href: entryUrl(kb.id, entry.path), style: 'text-decoration:none' }, '下载 zip'),
        el('button.btn.btn-danger', { text: '删除', onClick: () => { close(); deleteEntry(kb, entry); } })),
      el('div', { style: 'margin-top:20px; font-size:10.5px; letter-spacing:.12em; color:var(--muted); margin-bottom:8px' }, 'CURL'),
      codeBlock(curl),
      el('p.note', { style: 'margin-top:8px' },
        'If-Match 不符 → 412 precondition_failed，响应里带上当前实际的 currentHash。'))));

  document.body.appendChild(wrap);
}

// ── 07-6 Token ─────────────────────────────────────────────────────────────

async function renderTokens(body) {
  const data = await api('/tokens');
  S.refreshedAt = clockNow();
  clear(body);

  const head = pageHead('Token',
    el('span.tag', { text: '同步 API 凭据' }),
    el('span.grow'),
    !data.fromEnv && el('button.btn.btn-primary', { text: '+ 新建 token', onClick: () => createTokenModal() }));
  body.parentNode.insertBefore(head, body);

  if (data.fromEnv) {
    body.appendChild(el('div.hint-line', { style: 'margin-bottom:14px' },
      el('b', null, '这份列表由环境变量 AIW_KB_TOKENS 提供，是只读的。'),
      ' 配置文件里的 [[tokens]] 当前没有生效，在这里也改不了。去掉那个环境变量并重启，才能在后台管理它们。'));
  }

  const grid = 'grid-template-columns:minmax(0,1fr) 140px 110px minmax(0,1.2fr) 150px';
  const table = el('div.table');
  table.appendChild(el('div.th', { style: grid },
    el('span', null, '名称 / 用途'), el('span', null, '值'), el('span', null, '创建时间'),
    el('span', null, '最后使用'), el('span')));

  if (!data.tokens.length) {
    table.appendChild(el('div.empty', null,
      el('b', null, '一个 token 都没有'),
      el('p', null, '没有 token，app 就连不上这台服务器。新建一个，然后把它填进 设置 → 知识库同步。')));
  }

  for (const token of data.tokens) {
    const valueSlot = el('span.mono.faint', { style: 'cursor:pointer', text: token.prefix + '…' });
    valueSlot.addEventListener('click', async () => {
      if (valueSlot.dataset.shown) return;
      try {
        const full = await api(`/tokens/${encodeURIComponent(token.id)}/reveal`);
        clear(valueSlot);
        valueSlot.dataset.shown = '1';
        valueSlot.style.cursor = 'auto';
        append(valueSlot, [el('span', { style: 'word-break:break-all', text: full.value }), copyable(full.value, 'token')]);
      } catch (e) { reportError(e); }
    });
    valueSlot.title = '点击显示全文';

    table.appendChild(el('div.tr', { style: grid },
      el('span', null,
        el('span', { text: token.name }),
        token.fromEnv ? el('span.tag', { style: 'margin-left:6px' }, '环境变量') : null),
      valueSlot,
      el('span.mono.faint', { style: 'font-size:11.5px', text: token.createdAtMs ? stamp(token.createdAtMs) : '—' }),
      el('span', { style: 'font-size:11.5px' },
        token.lastUsedAtMs
          ? el('span', null, ago(token.lastUsedAtMs),
              token.lastUsedDevice ? el('span.faint', { text: ' · ' + token.lastUsedDevice }) : null)
          : el('span.faint', null, '从未（或重启前）')),
      el('span', { style: 'display:flex; gap:6px; justify-content:flex-end' },
        token.fromEnv ? el('span.faint', { style: 'font-size:11.5px' }, '不可编辑') : [
          el('button.btn', { text: '改名', onClick: () => renameTokenModal(token) }),
          el('button.btn.btn-danger', { text: '吊销', onClick: () => revokeTokenModal(token) }),
        ])));
  }

  body.appendChild(el('div.panel', { style: 'padding:6px 22px 14px' }, table));

  body.appendChild(el('div.grid-2', { style: 'margin-top:16px' },
    el('div.panel', null,
      el('h3', null, '轮换一个 token（不中断任何机器）'),
      rotationStep('1 · 新建', '生成新 token，旧的先留着，新旧并存。'),
      rotationStep('2 · 逐台换', '在每台机器的 app 设置里换成新 token。'),
      rotationStep('3 · 核对', '看上面的「最后使用」，确认旧 token 不再被用到。'),
      rotationStep('4 · 吊销旧的', '吊销后仍用旧 token 的机器会立刻开始报 401。')),
    el('div.panel', null,
      el('h3', null, '为什么这里能看到全文？'),
      el('p.note', null,
        'token 是明文存在配置文件 ', el('span.mono', { text: data.configPath }),
        ' 里的——它必须能和客户端递过来的值逐字节比对，而这台服务器通常就在你自己的网络里。',
        '保护它的是文件权限，不是加密：Linux 上应当是 ', el('span.mono', null, '600'), '（维护页的健康自检会检查这一条）。'),
      el('p.note', { style: 'margin-top:10px' },
        '所以列表默认只显示前缀，点一下才展开——这是为了让这一页可以被截图，不是因为服务端也不知道。'),
      el('p.note', { style: 'margin-top:10px' },
        '改动立即生效，', el('b', null, '不需要重启'), '：token 是每个请求现读的。'))));
}

function rotationStep(title, text) {
  return el('div', { style: 'padding:9px 0; border-bottom:1px solid var(--border-soft)' },
    el('div', { style: 'font:600 12px var(--sans); color:var(--accent)', text: title }),
    el('div.note', { style: 'margin-top:3px', text: text }));
}

function createTokenModal() {
  modal((close) => {
    const name = el('input', { type: 'text', placeholder: '阳台的 iPad' });
    const create = el('button.btn.btn-primary', {
      text: '生成',
      onClick: async () => {
        create.disabled = true;
        try {
          const made = await api('/tokens', { method: 'POST', body: { name: name.value.trim() } });
          close();
          showNewToken(made);
        } catch (e) { create.disabled = false; reportError(e); }
      },
    });
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') create.click(); });
    return el('div', null,
      el('h3', null, '新建 token'),
      el('p', null, '起一个能认出机器的名字。「最后使用」那一列会按名字告诉你哪台还在用它。'),
      el('div.field', null, el('label', null, '名称 / 用途'), name),
      el('div.foot', null,
        el('button.btn', { text: '取消', onClick: close }),
        create));
  });
}

function showNewToken(made) {
  modal((close) => el('div', null,
    el('div', { style: 'display:flex; align-items:center; gap:9px; margin-bottom:12px; color:var(--ok)' },
      icon(ICON.ok, 16),
      el('b', { style: 'font:600 15px var(--serif); color:var(--ink)', text: `「${made.name}」已创建` })),
    el('div', {
      style: 'background:var(--code-bg); color:var(--code-ink); padding:16px; font:500 14px var(--mono); word-break:break-all',
      text: made.value,
    }),
    el('div.btn-row', { style: 'margin-top:12px' },
      el('button.btn.btn-primary', {
        text: '复制',
        onClick: async () => {
          try { await navigator.clipboard.writeText(made.value); toast('token 已复制'); }
          catch { toast('浏览器不让复制，请手动选中', true); }
        },
      })),
    el('p', { style: 'margin-top:16px' },
      '现在就把它粘进那台设备的 app 设置里。列表里默认只显示前缀，但它是明文存在配置文件里的，',
      el('b', null, '以后随时可以回来点开看'), '——丢了不用重发。'),
    el('div.foot', null, el('button.btn', { text: '完成', onClick: () => { close(); route(); } })))
  );
}

function renameTokenModal(token) {
  modal((close) => {
    const name = el('input', { type: 'text', value: token.name });
    return el('div', null,
      el('h3', null, '改名'),
      el('div.field', null, el('label', null, '名称 / 用途'), name),
      el('div.foot', null,
        el('button.btn', { text: '取消', onClick: close }),
        el('button.btn.btn-primary', {
          text: '保存',
          onClick: async () => {
            try {
              await api(`/tokens/${encodeURIComponent(token.id)}`, { method: 'PATCH', body: { name: name.value.trim() } });
              close(); toast('已改名'); route();
            } catch (e) { reportError(e); }
          },
        })));
  });
}

function revokeTokenModal(token) {
  confirmDanger({
    title: `吊销「${token.name}」？`,
    body: el('span', null,
      '使用该 token 的机器会', el('b', null, '立刻'),
      '开始收到 401，同步会中断，直到你在那台机器上换成新 token。已经推上来的数据不受影响。',
      token.lastUsedAtMs
        ? el('span', null, el('br'), el('br'), el('b', null, '最后使用：'), ago(token.lastUsedAtMs),
            token.lastUsedDevice ? ' · ' + token.lastUsedDevice : '', '——它看起来还在被使用。')
        : null),
    confirmLabel: '吊销 token',
    onConfirm: async () => {
      await api(`/tokens/${encodeURIComponent(token.id)}`, { method: 'DELETE' });
      toast('已吊销');
      route();
    },
  });
}

// ── 07-7 活动日志 ──────────────────────────────────────────────────────────

const ACTIVITY_FILTER = { kb: '', device: '', action: '', hours: 24, failures: false };

async function renderActivity(body) {
  const kbs = await api('/kbs');
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(ACTIVITY_FILTER)) {
    if (value !== '' && value !== false) query.set(key, String(value));
  }
  const data = await api('/activity?' + query.toString());
  S.refreshedAt = clockNow();
  clear(body);

  const head = pageHead('活动日志',
    el('span.tag', { text: 'audit.log' }),
    ...refreshButton(() => route()));
  body.parentNode.insertBefore(head, body);

  // 图表：单色赭石，最高的一根深一档。不用第二种颜色 —— 这里没有第二个维度。
  const peak = Math.max(1, ...data.histogram);
  const chart = el('div.panel', null,
    el('h3', null, '写入次数', el('span.grow'),
      el('span.faint', { style: 'font-weight:400; font-size:11px' }, '仅统计 创建 / 替换 / 删除')),
    el('div.hist', null, data.histogram.map((count) =>
      el('i' + (count === peak && count > 0 ? '.peak' : ''), {
        style: `height:${Math.max(2, Math.round(count / peak * 60))}px`,
        title: `${count} 次`,
      }))),
    el('div.hist-axis', null,
      el('span', { text: stamp(data.sinceMs) }),
      el('span', { text: '→' }),
      el('span', null, '现在')));
  body.appendChild(chart);

  const select = (value, options, onChange) => {
    const node = el('select.compact');
    for (const [key, label] of options) {
      node.appendChild(el('option', { value: key, text: label, selected: key === String(value) }));
    }
    node.addEventListener('change', () => { onChange(node.value); route(); });
    return node;
  };

  const failures = el('input', { type: 'checkbox', checked: ACTIVITY_FILTER.failures });
  failures.addEventListener('change', () => { ACTIVITY_FILTER.failures = failures.checked; route(); });

  body.appendChild(el('div', { style: 'display:flex; gap:10px; align-items:center; margin-top:16px; flex-wrap:wrap' },
    select(ACTIVITY_FILTER.kb, [['', '全部知识库'], ...kbs.kbs.map((kb) => [kb.id, kb.name])],
      (v) => { ACTIVITY_FILTER.kb = v; }),
    select(ACTIVITY_FILTER.device, [['', '全部设备'], ...data.devices.map((d) => [d, d])],
      (v) => { ACTIVITY_FILTER.device = v; }),
    select(ACTIVITY_FILTER.action, [['', '全部动作'], ...Object.entries(ACTIONS).map(([k, v]) => [k, v[0]])],
      (v) => { ACTIVITY_FILTER.action = v; }),
    select(ACTIVITY_FILTER.hours, [['24', '最近 24 小时'], ['168', '最近 7 天'], ['720', '最近 30 天']],
      (v) => { ACTIVITY_FILTER.hours = Number(v); }),
    el('label.checkbox', null, failures, '只看失败（4xx / 5xx）'),
    el('span.grow'),
    el('span.faint', { style: 'font-size:11.5px', text: `${data.events.length} 条 · 时间倒序` })));

  const grid = 'grid-template-columns:132px 74px minmax(0,120px) minmax(0,1fr) 120px 78px 52px';
  const table = el('div.table');
  table.appendChild(el('div.th', { style: grid },
    el('span', null, '时间'), el('span', null, '动作'), el('span', null, '知识库'),
    el('span', null, '条目路径'), el('span', null, '设备'), el('span', null, 'TOKEN'),
    el('span.right', null, '结果')));

  if (!data.events.length) {
    table.appendChild(el('div.empty', null,
      el('b', null, '这段时间里没有任何活动'),
      el('p', null, '日志记录在 ', el('span.mono', null, '<data>/audit.log'),
        ' 里，服务重启不会丢；但它是这个功能上线之后才开始记的。')));
  }

  let lastDetail = null;
  for (const event of data.events) {
    const [label, tone] = ACTIONS[event.action] || [event.action, 'muted'];
    const bad = event.status >= 400;
    table.appendChild(el('div.tr', { style: grid },
      el('span.mono.faint', { style: 'font-size:11.5px', text: stamp(event.atMs, true) }),
      el('span', { style: 'display:flex; align-items:center; gap:6px' },
        el('span.dot' + (tone === 'bad' ? '.err' : tone === 'ok' ? '.ok' : ''), { style: 'border-radius:0; width:6px; height:6px' }),
        el('span', { text: label })),
      el('span.mono', { style: 'font-size:11.5px; overflow:hidden; text-overflow:ellipsis', text: event.kb || '—' }),
      el('span', { style: 'overflow:hidden; text-overflow:ellipsis; white-space:nowrap', text: event.path || '—' }),
      el('span.faint', { style: 'font-size:11.5px; overflow:hidden; text-overflow:ellipsis', text: event.device || '未知设备' }),
      el('span.mono.faint', { style: 'font-size:11px', text: event.token ? event.token + '…' : '无 token' }),
      el('span.right', null, el('span.status' + (bad ? '.bad' : ''), { text: String(event.status) }))));

    // 412 这一行要自己解释自己：它是并发保护在正常工作，不是故障。
    if (event.status === 412) {
      table.appendChild(el('div.explain', null,
        el('b', null, 'precondition_failed：'),
        '这台机器带的 If-Match 已经过期——另一台机器在它确认之后写入了同一个条目。',
        el('b', null, '这是并发保护在正常工作，不是故障。'),
        ' app 会重新拉取 manifest 后重试；响应里附带了当前实际的 currentHash。'));
    } else if (event.detail && bad && event.detail !== lastDetail) {
      // 连续相同的说明只出现一次：一串被同一个失效 token 打出来的 401，
      // 逐行重复同一句话会把真正不一样的那一行淹掉。
      table.appendChild(el('div.explain', { text: event.detail }));
    }
    lastDetail = bad ? event.detail : null;
  }

  body.appendChild(el('div.panel', { style: 'margin-top:12px; padding:6px 22px 14px' }, table));
  body.appendChild(el('p.note', { style: 'margin-top:10px' },
    '设备 = 客户端自报的 X-Source-Device · token 按前缀关联 · 事件持久化在 ',
    el('span.mono', null, '<data>/audit.log'), '，超过 8 MB 自动轮转。'));
}

// ── 07-7 配置备份 ──────────────────────────────────────────────────────────
//
// app 推上来的应用配置（供应商 / 模型 / Prompt / 偏好）。这一页只读和删除：
// 带 API Key 的备份是在作者的机器上加密的，密码这台服务器从来没见过、也没有任何
// 路径能拿到，所以运维在这里能做的只有「看它占了多少地方」和「删掉不要的」。
// 故意不提供下载——整机备份已经覆盖了 configs/，不需要第二个随手的出口。

/**
 * 版本的展示元数据 = 客户端信封头部的 base64url。
 *
 * 服务端从不解析它（那正是信封格式能自己往前走、不用重新部署服务器的原因），
 * 所以解码在这里做——并且必须当成不可信输入：它是另一台机器上传的字符串，坏了
 * 就当没有，绝不能让整页塌掉。
 */
function slotMeta(raw) {
  if (!raw) return null;
  try {
    let b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const binary = atob(b64);
    const buf = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
    const parsed = JSON.parse(new TextDecoder().decode(buf));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch { return null; }
}

/** 元数据里的一个字段，限长、去掉控制字符——它会被放进 DOM 文本节点。 */
function metaText(value, max = 40) {
  if (typeof value !== 'string' || !value) return null;
  const cleaned = [...value].filter((c) => c >= ' ').slice(0, max).join('').trim();
  return cleaned || null;
}

async function renderConfigs(body) {
  const data = await api('/configs');
  S.refreshedAt = clockNow();
  clear(body);

  const totalBytes = data.slots.reduce((sum, s) => sum + (s.bytes || 0), 0);
  const head = pageHead('配置备份',
    el('span.tag', { text: `${data.slots.length} 档 · ${bytes(totalBytes)}` }),
    ...refreshButton(() => route()));
  body.parentNode.insertBefore(head, body);

  if (!data.slots.length) {
    body.appendChild(el('div.empty', null,
      el('b', null, '还没有任何配置备份'),
      el('div.steps', null,
        el('div.step', null, el('i', null, '1'), '在 Simple AI Writer 里打开 设置 → 同步与备份，连上这台服务器'),
        el('div.step', null, el('i', null, '2'), '在「应用配置」里新建一个备份档，把这台机器的配置推上来'),
        el('div.step', null, el('i', null, '3'), '换一台设备连上同一个服务器，就能把它拉下去')),
      el('p', null, '带 API Key 的备份必须设密码，加密在作者的机器上完成。'
        + '这台服务器存的是一段它读不懂的字节——密码它没有，也没有任何办法找回。')));
    return;
  }

  for (const slot of data.slots) body.appendChild(slotPanel(slot));

  body.appendChild(el('p.note', { style: 'margin-top:14px' },
    '这一页不提供下载：整机备份（维护与备份 → 下载 data.tar.gz）已经覆盖了 configs/，'
    + '而配置备份是作者的凭据材料，不该有第二个随手的出口。'));
}

function slotPanel(slot) {
  const current = slot.versions[0];
  const meta = current ? slotMeta(current.meta) : null;
  const encrypted = meta ? meta.encrypted !== false : null;

  const panel = el('div.panel', null,
    el('h3', null,
      el('span', { text: slot.name }),
      el('span.id', { style: 'margin-left:8px', text: slot.id }),
      el('span.grow'),
      el('span.faint', {
        style: 'font-weight:400; font-size:11px',
        text: `${slot.versions.length} 个版本 · ${bytes(slot.bytes)}`,
      })),
    el('div.meta', { style: 'margin-top:2px' },
      el('span', null, '建于 ', el('span.mono', { text: stamp(slot.createdAtMs) })),
      current
        ? el('span', null, '最后推送 ', el('span.mono', { text: stamp(current.atMs) }))
        : el('span.faint', null, '还没有推送过'),
      meta && metaText(meta.device)
        ? el('span', { text: '来自 ' + metaText(meta.device) })
        : el('span.faint', null, '设备未上报'),
      meta && metaText(meta.appVersion)
        ? el('span', { text: 'v' + metaText(meta.appVersion, 16) })
        : null,
      encrypted === null
        ? null
        : encrypted
          ? el('span', { style: 'color:var(--ok)', text: '已加密' })
          // 不加密的备份不含 Key（客户端拒绝那个组合），但它仍然装着这台机器的
          // 供应商地址和全部 Prompt，值得在运维面前标出来。
          : el('span', { style: 'color:var(--muted)', text: '未加密（不含 Key）' })));

  const grid = 'grid-template-columns:150px 84px minmax(0,1fr) 96px';
  const table = el('div.table', { style: 'margin-top:14px' },
    el('div.th', { style: grid },
      el('span', null, '时间'), el('span', null, '大小'),
      el('span', null, '设备 / 内容'), el('span.right', null, '操作')));

  for (const version of slot.versions) {
    const vmeta = slotMeta(version.meta);
    const counts = vmeta && vmeta.counts && typeof vmeta.counts === 'object' ? vmeta.counts : null;
    // counts 是客户端自报的，加密之后没有人能核对——所以它只出现在这种纯展示的
    // 位置，永远不参与任何判断。
    const summary = [
      metaText(vmeta && vmeta.device),
      counts ? `${Number(counts.providers) || 0} 供应商 · ${Number(counts.models) || 0} 模型` : null,
      vmeta && vmeta.hasKeys ? '含 API Key' : null,
    ].filter(Boolean).join(' · ');

    table.appendChild(el('div.tr', { style: grid },
      el('span.mono', { style: 'font-size:11.5px', text: stamp(version.atMs, true) }),
      el('span.mono.faint', { style: 'font-size:11.5px', text: bytes(version.size) }),
      el('span', {
        style: 'overflow:hidden; text-overflow:ellipsis; white-space:nowrap',
        text: summary || '—',
      }),
      el('span.right', null,
        slot.versions.length > 1
          ? el('button.btn', { text: '删除', onClick: () => deleteVersionModal(slot, version) })
          : el('span.faint', { style: 'font-size:11px', text: '仅此一版' }))));
  }
  panel.appendChild(table);

  panel.appendChild(el('div.btn-row', { style: 'margin-top:14px' },
    el('button.btn', { text: '重命名', onClick: () => renameSlotModal(slot) }),
    el('button.btn.btn-danger', { text: '删除整个备份档', onClick: () => deleteSlotModal(slot) })));
  return panel;
}

function deleteVersionModal(slot, version) {
  confirmDanger({
    title: '删除这一个版本？',
    body: el('span', null,
      el('b', { text: slot.name }), ' 在 ',
      el('span.mono', { text: stamp(version.atMs, true) }), ' 推上来的那一版会被永久删除。',
      '其他版本不受影响——但这台服务器上没有第二份，删掉就没了。'),
    confirmLabel: '删除这一版',
    onConfirm: async () => {
      await api(`/configs/${encodeURIComponent(slot.id)}/versions/${version.atMs}`, { method: 'DELETE' });
      toast('已删除该版本');
      route();
    },
  });
}

function renameSlotModal(slot) {
  modal((close) => {
    const name = el('input', { type: 'text', value: slot.name });
    return el('div', null,
      el('h3', null, '重命名备份档'),
      el('p', null, '只改显示名。', el('b', null, 'id 不能改'),
        '——它是每台设备记住的地址，改掉等于让已经在用这个档的机器再也找不到它。'),
      el('div.field', null, el('label', null, '显示名'), name),
      el('div.field', null, el('label', null, 'ID（不可改）'),
        el('div.mono.faint', { text: slot.id })),
      el('div.foot', null,
        el('button.btn', { text: '取消', onClick: close }),
        el('button.btn.btn-primary', {
          text: '保存',
          onClick: async () => {
            try {
              await api('/configs/' + encodeURIComponent(slot.id), {
                method: 'PATCH', body: { name: name.value },
              });
              close();
              toast('已改名');
              route();
            } catch (e) { reportError(e); }
          },
        })));
  });
}

function deleteSlotModal(slot) {
  confirmDanger({
    title: `删除「${slot.name}」？`,
    body: el('span', null,
      '这个备份档的全部 ', el('b', { text: String(slot.versions.length) }), ' 个版本（',
      el('b', { text: bytes(slot.bytes) }), '）会被永久删除，', el('b', null, '没有回收站'),
      '。每台机器上的本地配置不受影响——但还在用这个档的设备下次拉取会失败，需要重新推一份。'),
    typeToConfirm: slot.id,
    confirmLabel: '永久删除',
    onConfirm: async () => {
      await api('/configs/' + encodeURIComponent(slot.id), { method: 'DELETE' });
      toast(`已删除「${slot.name}」`);
      route();
    },
  });
}

// ── 07-8 维护与备份 ────────────────────────────────────────────────────────

async function renderMaintenance(body) {
  const data = await api('/maintenance');
  S.refreshedAt = clockNow();
  clear(body);

  const head = pageHead('维护与备份', ...refreshButton(() => route()));
  body.parentNode.insertBefore(head, body);

  const disk = data.disk;
  const used = disk.totalBytes - disk.availableBytes;
  const usedPercent = disk.totalBytes ? Math.round(used / disk.totalBytes * 100) : 0;
  const low = disk.totalBytes && disk.availableBytes * 10 < disk.totalBytes;
  const biggest = Math.max(1, ...disk.byKb.map((k) => k.bytes));

  const diskPanel = el('div.panel', null,
    el('h3', null, '磁盘'),
    el('div', { style: 'display:flex; align-items:center; gap:6px; margin-bottom:12px' },
      el('span.mono.faint', { style: 'font-size:11.5px; word-break:break-all', text: disk.path }),
      copyable(disk.path, '路径')),
    el('div.bar' + (low ? '.err' : ''), null, el('i', { style: `width:${usedPercent}%` })),
    el('div', { style: 'display:flex; justify-content:space-between; margin-top:8px; font-size:11.5px' },
      el('span', null, '已用 ', el('b', { text: bytes(used) })),
      el('span', { class: low ? 'right' : 'right' }, '剩余 ',
        el('b', { style: low ? 'color:var(--err)' : '', text: `${bytes(disk.availableBytes)}（${100 - usedPercent}%）` }))),
    el('div', { style: 'margin-top:18px; font-size:10.5px; letter-spacing:.12em; color:var(--muted)' }, '按库占用'),
    disk.byKb.length
      ? disk.byKb.map((kb) => el('div', { style: 'display:flex; align-items:center; gap:10px; margin-top:9px; font-size:11.5px' },
          el('span', { style: 'flex:none; width:130px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap', text: kb.name }),
          el('div.bar', { style: 'flex:1' }, el('i', { style: `width:${Math.round(kb.bytes / biggest * 100)}%` })),
          el('span.mono.faint', { style: 'flex:none; width:70px; text-align:right', text: bytes(kb.bytes) })))
      : el('p.note', { style: 'margin-top:8px' }, '还没有任何知识库。'),
    disk.configBytes
      ? el('div', { style: 'display:flex; align-items:center; gap:10px; margin-top:9px; font-size:11.5px' },
          el('span.faint', { style: 'flex:none; width:130px', text: '配置备份' }),
          el('div.bar', { style: 'flex:1' }, el('i', { style: `width:${Math.round(disk.configBytes / Math.max(biggest, disk.configBytes) * 100)}%` })),
          el('span.mono.faint', { style: 'flex:none; width:70px; text-align:right', text: bytes(disk.configBytes) }))
      : null,
    el('p.note', { style: 'margin-top:14px' },
      '「已用 / 剩余」是整个分区的，不只是这个服务的数据——写满的是分区，不是目录。'));

  const backupPanel = el('div.panel', null,
    el('h3', null, '备份'),
    el('p.note', null,
      '把整个数据目录打成 tar.gz 下载。', el('b', null, '不需要停机'),
      '：每个条目都是靠 rename 提交的，所以归档里不可能出现半个文件。'),
    el('p.note', { style: 'margin-top:8px' },
      '备份期间也不加锁——一个正在被推送的知识库可能被拍到"一半旧一半新"的状态。为一次几分钟的归档阻塞全部同步，是更差的交易。'),
    el('div.btn-row', { style: 'margin-top:14px' },
      el('a.btn.btn-primary', { href: '/admin/api/backup.tar.gz', style: 'text-decoration:none' },
        `下载 data.tar.gz（约 ${bytes(disk.dataBytes)} 未压缩）`)),
    el('div', { style: 'margin-top:16px; font-size:10.5px; letter-spacing:.12em; color:var(--muted); margin-bottom:8px' },
      '命令行版本（原样可复制）'),
    codeBlock(`tar -czf aiw-kb-$(date +%F).tar.gz -C "${disk.path}" .`));

  const strayBytes = data.strays.reduce((sum, s) => sum + s.size, 0);
  const tmpPanel = el('div.panel', null,
    el('h3', null, 'tmp/ 残留',
      el('span.grow'),
      el('span.faint', { style: 'font-weight:400; font-size:11px', text: `${data.strays.length} 个 · ${bytes(strayBytes)}` })),
    data.strays.length
      ? [
          el('p.note', null, '中断上传留下的暂存。',
            el('b', null, '可随时清空，不含任何已提交的数据'),
            '——一个暂存文件只会被提交它的那次 rename 读到，还留在那里就说明写它的进程已经没了。'),
          el('div.code', { style: 'margin-top:12px; max-height:150px; overflow:auto' },
            data.strays.map((s) => s.rel).join('\n')),
          el('button.btn', {
            style: 'margin-top:12px',
            text: '清空全部 tmp/',
            onClick: async (e) => {
              e.target.disabled = true;
              try {
                const result = await api('/maintenance/clear-tmp', { method: 'POST' });
                toast(`已清空 tmp/，回收 ${bytes(result.bytes)}`);
                route();
              } catch (err) { reportError(err); e.target.disabled = false; }
            },
          }),
        ]
      : el('p.note', null, '干净的。没有中断的上传留下暂存文件。'));

  const dupBytes = data.duplicates.reduce((sum, d) => sum + d.losers.reduce((s, l) => s + l.size, 0), 0);
  const dupCount = data.duplicates.reduce((sum, d) => sum + d.losers.length, 0);
  const dupPanel = el('div.panel', null,
    el('h3', null, '重复 zip',
      el('span.grow'),
      el('span.faint', { style: 'font-weight:400; font-size:11px', text: `${data.duplicates.length} 个条目` })),
    data.duplicates.length
      ? [
          el('p.note', null, '同一个条目存在两个 ', el('span.mono', null, '.zip'),
            '（替换后旧文件删除失败的残留）。服务端按 mtime 取新的，下次写入该条目时会自清——手动清理只是提前回收空间。'),
          el('div', { style: 'margin-top:12px; max-height:220px; overflow:auto' },
            data.duplicates.slice(0, 40).map((dup) => el('div', { style: 'margin-bottom:12px' },
              el('div.mono', { style: 'font-size:11.5px', text: `${dup.kb} / ${dup.path}` }),
              el('div.mono.faint', { style: 'font-size:11px; margin-top:3px' },
                '├ ', dup.keeper.fileName, ' · ', bytes(dup.keeper.size), ' · ',
                el('b', { style: 'color:var(--ok)' }, stamp(dup.keeper.updatedAtMs) + ' ← 生效')),
              dup.losers.map((loser) => el('div.mono.faint', { style: 'font-size:11px' },
                '└ ', loser.fileName, ' · ', bytes(loser.size), ' · ', stamp(loser.updatedAtMs)))))),
          el('button.btn', {
            style: 'margin-top:6px',
            text: `清理 ${dupCount} 个旧文件（回收 ${bytes(dupBytes)}）`,
            onClick: async (e) => {
              e.target.disabled = true;
              try {
                const result = await api('/maintenance/dedupe', { method: 'POST' });
                toast(`已清理 ${result.files} 个文件，回收 ${bytes(result.bytes)}`);
                route();
              } catch (err) { reportError(err); e.target.disabled = false; }
            },
          }),
        ]
      : el('p.note', null, '没有重复。每个条目都只有一个负载文件。'));

  const checksPanel = el('div.panel', null,
    el('h3', null, '健康自检',
      el('span.faint', { style: 'font-weight:400; font-size:11px' }, '对应 DEPLOY.md §9 上线清单'),
      el('span.grow'),
      el('button.btn', { text: '重新检查', onClick: () => loadChecks(checksPanel) })));
  loadChecks(checksPanel);

  body.appendChild(el('div.grid-2', null, diskPanel, backupPanel));
  body.appendChild(el('div.grid-2', { style: 'margin-top:16px' }, tmpPanel, dupPanel));
  body.appendChild(el('div', { style: 'margin-top:16px' }, checksPanel));
}

async function loadChecks(panel) {
  const slot = panel.querySelector('.check-list') || el('div.check-list');
  if (!slot.parentNode) panel.appendChild(slot);
  clear(slot);
  slot.appendChild(el('div.skeleton', { style: 'height:40px' }));
  try {
    const data = await api('/checks');
    clear(slot);
    for (const check of data.checks) {
      const tone = { pass: 'ok', warn: 'warn', fail: 'err', unknown: '' }[check.state] || '';
      slot.appendChild(el('div.check-row', null,
        el('span.dot' + (tone ? '.' + tone : ''), { style: 'margin-top:5px' }),
        el('div.body', null,
          el('span', { text: check.label }),
          check.detail && el('p', { text: check.detail }),
          check.fix && el('div', { style: 'margin-top:8px' }, codeBlock(check.fix))),
        el('span.state', {
          text: { pass: '通过', warn: '注意', fail: '不通过', unknown: '未知' }[check.state] || check.state,
          style: check.state === 'fail' ? 'color:var(--err)' : check.state === 'warn' ? 'color:var(--warn)' : '',
        })));
    }
  } catch (e) {
    clear(slot);
    slot.appendChild(el('p.note', { text: '自检没跑起来：' + (e.message || e) }));
  }
}

// ── 07-9 配置 ──────────────────────────────────────────────────────────────

async function renderConfig(body) {
  const data = await api('/config');
  S.refreshedAt = clockNow();
  clear(body);

  const head = pageHead('配置',
    el('span.tag', { text: 'aiw-kb.toml' }),
    el('span.grow'),
    el('button.btn', { text: '查看原始 TOML', onClick: () => rawTomlModal(data.file) }));
  body.parentNode.insertBefore(head, body);

  const origin = {
    'cli': '来自 --config',
    'env': '来自 AIW_KB_CONFIG',
    'next-to-exe': '可执行文件同目录',
    'system-default': '系统默认位置',
  }[data.file.origin] || data.file.origin;

  body.appendChild(el('div.strip', null,
    el('div.kv', { style: 'min-width:0' },
      el('label', null, '配置文件'),
      el('div', null, el('span', { style: 'word-break:break-all', text: data.file.path }), copyable(data.file.path, '路径'))),
    el('div.sep'),
    el('div.kv', null, el('label', null, '来源'), el('div', { text: origin })),
    el('div.sep'),
    el('div.kv', null, el('label', null, '可写'),
      el('div', null, data.file.writable
        ? el('span', { style: 'color:var(--ok)' }, '是')
        : el('span', { style: 'color:var(--err)' }, '否——这里保存不了')))));

  if (data.file.error) {
    body.appendChild(el('div.notice.error', { style: 'margin-top:14px' },
      el('b', null, '配置文件解析失败，服务正在用默认值运行'),
      el('p', { text: data.file.error })));
  }

  // 待保存的改动。收在这里而不是每改一格就写一次盘：一次保存是一个用户动作，
  // 写一半再失败，会把文件留在没人要求过的状态。
  const pending = new Map();
  const saveBar = el('div', { class: 'hidden' });

  const drawSaveBar = () => {
    clear(saveBar);
    if (!pending.size) { saveBar.className = 'hidden'; return; }
    saveBar.className = 'save-bar';
    const restartKeys = [...pending.keys()]
      .map((key) => data.rows.find((r) => r.key === key))
      .filter((row) => row && row.needsRestart)
      .map((row) => row.label);
    append(saveBar, [
      el('b', { style: 'font-size:12.5px', text: `${pending.size} 项待保存` }),
      restartKeys.length
        ? el('span.faint', { style: 'font-size:11.5px', text: '其中需要重启才生效：' + restartKeys.join('、') })
        : null,
      el('span.grow'),
      el('button.btn', { text: '放弃', onClick: () => route() }),
      el('button.btn.btn-primary', {
        text: '保存到配置文件',
        disabled: !data.file.writable,
        onClick: () => saveConfig(pending, body),
      }),
    ]);
  };

  const panel = el('div.panel', { style: 'margin-top:16px' });
  for (const row of data.rows) {
    panel.appendChild(configRow(row, pending, drawSaveBar));
  }

  body.appendChild(panel);
  body.appendChild(saveBar);
  body.appendChild(el('p.note', { style: 'margin-top:14px' }, data.restartHint));
}

function configRow(row, pending, onChange) {
  const locked = row.source === 'env';
  const node = el('div.conf-row' + (locked ? '.locked' : ''));

  let control;
  if (row.kind === 'bool') {
    const toggle = el('button.toggle' + (row.value ? '.on' : ''), { disabled: locked }, el('i'));
    toggle.addEventListener('click', () => {
      if (locked) return;
      const next = !toggle.classList.contains('on');
      toggle.classList.toggle('on', next);
      pending.set(row.key, next);
      onChange();
    });
    control = toggle;
  } else if (row.kind === 'password') {
    const input = el('input', { type: 'password', value: row.value || '', disabled: locked, autocomplete: 'new-password' });
    input.addEventListener('input', () => { pending.set(row.key, input.value); onChange(); });
    control = el('div.with-suffix', null, input,
      el('button', {
        type: 'button', title: '显示',
        onClick: () => { input.type = input.type === 'password' ? 'text' : 'password'; },
      }, icon(ICON.eye, 15)));
  } else {
    const input = el('input', {
      type: row.kind === 'number' ? 'number' : 'text',
      value: row.value === null || row.value === undefined ? '' : String(row.value),
      disabled: locked,
    });
    input.addEventListener('input', () => {
      pending.set(row.key, row.kind === 'number' ? Number(input.value) : input.value);
      onChange();
    });
    control = input;
  }

  append(node, [
    el('div.key', null,
      el('b', { text: row.label }),
      row.key,
      el('div.help', { text: row.help }),
      el('div.default', { text: '默认 ' + JSON.stringify(row.default) })),
    el('div.value', null,
      control,
      locked
        ? el('div.help', { style: 'color:var(--accent)' },
            '被环境变量 ', el('span.mono', { text: row.envVar }),
            ' 覆盖，配置文件里的值当前', el('b', null, '没有生效'), '。要在这里改，先去掉那个环境变量并重启。')
        : null,
      row.needsRestart && !locked
        ? el('div.help', null, '改这一项需要', el('b', null, '重启服务'), '才生效。')
        : null),
    el('div', { style: 'display:flex; justify-content:flex-end' },
      el('span.src.' + row.source, null,
        row.source === 'env' ? icon(ICON.token, 11) : null,
        { default: '默认', file: '配置文件', env: '环境变量覆盖' }[row.source] || row.source)),
  ]);
  return node;
}

async function saveConfig(pending, body) {
  try {
    const result = await api('/config', { method: 'PUT', body: { updates: Object.fromEntries(pending) } });
    toast(`已写入配置文件（${result.changed} 项）`);
    if (result.reloadError) toast('重新加载失败：' + result.reloadError, true);
    pending.clear();
    await route();
    if (result.needsRestart.length) {
      const banner = el('div.notice', { style: 'margin-bottom:14px' },
        el('b', { text: `已保存，其中 ${result.needsRestart.length} 项需要重启服务才生效：${result.needsRestart.join('、')}` }),
        el('p', null, '「重启服务」只是让这个进程干净地退出——只有在 systemd / Docker 等会自动把它拉起来的方式下才有用。裸跑的话，退出就是退出。'),
        el('button.btn', { text: '重启服务', onClick: restartServer }));
      const target = document.querySelector('.page-body');
      if (target) target.insertBefore(banner, target.firstChild);
    }
  } catch (e) { reportError(e); }
}

async function restartServer() {
  try {
    await api('/restart', { method: 'POST' });
  } catch { /* 连接会在重启时断掉，这是预期 */ }
  setOffline(true);
  toast('已请求重启，正在等待服务回来…');
}

function rawTomlModal(file) {
  modal((close) => el('div', null,
    el('h3', null, '原始 TOML'),
    el('p', null, '只读。后台保存时走 ', el('span.mono', null, 'toml_edit'),
      '，你手写的注释和排版都会原样保留。'),
    el('div', { style: 'max-height:52vh; overflow:auto' }, codeBlock(file.text || '（文件是空的）')),
    el('div.foot', null, el('button.btn', { text: '关闭', onClick: close }))), true);
}

// ── 启动 ───────────────────────────────────────────────────────────────────

const RENDERERS = {
  overview: renderOverview,
  kbs: (body) => (S.param ? renderKbDetail(body) : renderKbs(body)),
  tokens: renderTokens,
  activity: renderActivity,
  configs: renderConfigs,
  maintenance: renderMaintenance,
  config: renderConfig,
};

async function boot() {
  try {
    const me = await api('/session', { noAuthRedirect: true });
    S.anonymous = !!me.anonymous;
    // 匿名模式下服务端认为谁都算已登录，但这里仍然停在警告卡上，直到操作者
    // 自己点过一次 —— 见 anonymousCard()。
    S.auth = me.anonymous ? S.anonymousAck : !!me.authenticated;
    S.adminConfigured = me.adminConfigured !== false;
    S.username = me.username || (me.anonymous ? '匿名' : S.username);
    S.expiresAtMs = me.expiresAtMs || 0;
  } catch {
    S.auth = false;
  }
}

(async function start() {
  try {
    const saved = localStorage.getItem('aiw-kb-theme');
    if (saved) document.documentElement.dataset.theme = saved;
  } catch { /* 无痕模式没有 localStorage */ }

  window.addEventListener('hashchange', route);
  await boot();
  route();
})();
