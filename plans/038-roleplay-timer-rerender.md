# 038 — 扮演界面的生成计时从 10Hz 全量重渲降到 1Hz

- **Status**: DONE（门禁已过，目检待作者）
- **Commit**: 43b52e9
- **Severity**: MEDIUM
- **Category**: 5 性能
- **Estimated scope**: 1 个 TSX 文件，约 3 行

## Problem

`src/components/roleplay/RoleplayChat.tsx:465-471` —— 当前代码：

```tsx
  // 生成中的计时，设计稿在名标旁边显示「生成中 · 4.2s」。
  useEffect(() => {
    if (!isRunning) { setSeconds(0); return; }
    const started = Date.now();
    const id = window.setInterval(() => setSeconds((Date.now() - started) / 1000), 100);
    return () => window.clearInterval(id);
  }, [isRunning]);
```

`seconds` 在整个文件里**只有一个消费者**：

```tsx
/* src/components/roleplay/RoleplayChat.tsx:985 — 当前 */
                  {t("roleplay.generating", { s: seconds.toFixed(1), defaultValue: `生成中 · ${seconds.toFixed(1)}s` })}
```

于是每 100ms 一次 `setSeconds` → **整个 1523 行的组件重新渲染**。该文件里
`React.memo` 的出现次数是 **0**（`grep -c "React.memo\|memo(" ` → 0），
所以整条对话记录（transcript）跟着一起重渲——**而同一时刻这条 transcript
正在被流式追加**。也就是说，最花哨的那一帧恰好是负担最重的那一帧。

仓库里其它每一个计时器都是 1000ms 且只显示整秒：
`src/components/ai/AgentChat.tsx:457-460`、`src/components/ai/WriterStrip.tsx:41`、
`src/components/lore/ai/LoreRunProgress.tsx:28`。**这一个是异类。**

（同类但更轻的一处：`src/components/roleplay/SceneTransition.tsx:67` 也是 100ms，
但那是个小模态，不在本方案范围内。）

## Target

计时降到 1Hz、显示整秒，与仓库其余计时器一致：

```tsx
/* target — src/components/roleplay/RoleplayChat.tsx:465-471 */
  // 生成中的计时。1000ms 而不是 100ms：seconds 只有一个消费者（:985 的名标），
  // 但本组件 1500+ 行且无 memo，每次 setSeconds 都会连整条 transcript 一起重渲——
  // 而那正是流式追加正在进行的时刻。整秒与 AgentChat.tsx:457 / WriterStrip.tsx:41 /
  // LoreRunProgress.tsx:28 三处计时器一致。
  useEffect(() => {
    if (!isRunning) { setSeconds(0); return; }
    const started = Date.now();
    const id = window.setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(id);
  }, [isRunning]);
```

```tsx
/* target — src/components/roleplay/RoleplayChat.tsx:985 */
                  {t("roleplay.generating", { s: seconds, defaultValue: `生成中 · ${seconds}s` })}
```

## Repo conventions to follow

范本（**照抄它的节拍**）：

```tsx
/* src/components/ai/AgentChat.tsx:457-460 — 已有，正确 */
```
—— 1000ms 间隔、整秒显示。`WriterStrip.tsx:41` 与 `LoreRunProgress.tsx:28` 同理。

## Steps

1. `src/components/roleplay/RoleplayChat.tsx:469` —— 间隔 `100` → `1000`，
   回调改为 `setSeconds(Math.floor((Date.now() - started) / 1000))`。
2. 同文件 `:465-466` —— 换成 Target 里的注释（说明为什么是 1000 而不是 100）。
3. 同文件 `:985` —— `seconds.toFixed(1)` → `seconds`，
   `defaultValue` 里的 `${seconds.toFixed(1)}s` → `${seconds}s`。
4. **检查 i18n**：`grep -rn "roleplay.generating" src/i18n/locales/` —— 若
   en / zh-CN 的译文串里带着小数点相关措辞（如「秒」前有小数），一并调整；
   插值参数名 `s` 不变。若译文只是 `生成中 · {{s}}s` 则无需改动。

## Boundaries

- **不要**顺手给 `RoleplayChat` 加 `React.memo` 或拆分子组件。那是一次真正的
  重构，风险与收益都远超本方案；本方案只把**不必要的触发频率**降下来。
- **不要**改 `src/components/roleplay/SceneTransition.tsx:67`——同类但轻得多，
  未立案。
- **不要**改 `isRunning` 的来源或 `roleplayStore` 的任何状态。
- **不要**把计时改成 `requestAnimationFrame`——需要的是**更少**的更新，不是更平滑的更新。
- 若代码与摘录对不上（自 43b52e9 起漂移），**停下并报告**。

## Verification

- **机械**：
  - `pnpm exec tsc --noEmit` 无诊断；`pnpm test` 全绿；`pnpm build` 成功。
  - `grep -n "toFixed(1)" src/components/roleplay/RoleplayChat.tsx` —— 与 `seconds`
    相关的那处应已消失。
- **目检**（`pnpm tauri dev`，需开启「互动式角色扮演」Beta 开关并配好模型）：
  - 发起一次角色回复，观察名标旁的「生成中 · Ns」：数字应**每秒跳一次整数**，
    不再跳小数。
  - React DevTools → Profiler，勾选 "Highlight updates when components render"，
    在生成期间观察：改动前整条 transcript 每 100ms 闪一次高亮；改动后应降到每秒一次。
    **这是本方案唯一能量化的判据。**
  - 生成结束后计时归零、不再更新（`isRunning` 为假时清理仍然生效）。
  - 连续发起两次生成，确认第二次的计时从 0 重新开始（`started` 随 effect 重建）。
- **Done when**：计时以整秒推进，Profiler 中生成期间的重渲频率从 10Hz 降到 1Hz。
