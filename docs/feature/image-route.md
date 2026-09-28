# 出图接口：声明值与有效路线

> 状态：`planned`（2026-09-28）。起因是 [`dashscope-native-plan.md`](../api/dashscope-native-plan.md) §3 的一条边界；
> 各出图接口的报文见 [`image-generation-plan.md`](image-generation-plan.md)。

## 1. 问题的形状

图片模型的「出图接口」（`ImageCaps.route`，`ImageRoute`）有两个值：

- **声明值**——作者在抽屉里选的那一项，可空（空 =「自动」）。
- **有效路线**——请求真正打到的接口：声明了就是声明值，没声明就按模型**当前线路**的协议族推。

在这次之前，只有出图客户端（`resolveImageRoute`）算有效路线；抽屉的异步开关、保存时是否留下 `asyncTask`、
改图能力与尺寸的预填，都直接读声明值（`form.capsRoute === "dashscope"`）。两边各答一个问题，只要推导规则
不产生 `dashscope`，它们碰巧一致——所以 DashScope 原生线路一出现，就两头都不对：

1. 规则不变：图片模型切到原生线路、出图接口留「自动」，客户端推出 `images-api`，打 `/api/v1/images/generations` → 404。
2. 只改规则（整体 review 第 1 轮）：客户端推出 `dashscope`，但抽屉仍只认声明值——从「DashScope 原生」改回
   「自动」，异步开关消失、保存时 `asyncTask` 被清掉，wan 文生图此后每次失败（第 2 轮发现，已撤回）。

两次都是同一件事：**「有效路线」没有唯一的主人**，每个读者各自推一遍。修规则或修某个读者，都只是把分歧挪个地方。

## 2. 决定

**有效路线只由一个函数给出：`effectiveImageRoute(standard, caps)`（`src/lib/ai/imageRoute.ts`）。**
凡是问「这个模型的图会打到哪个接口」、或问挂在那个答案上的事（异步任务、改图缺省、尺寸写法的预填），
都经过它；没有第二份推导。

```ts
effectiveImageRoute(standard, { route })  // 声明了 → 声明值；没声明 → DERIVED[familyOf(standard)]
effectiveAsyncTask(standard, caps)        // 有效路线是 dashscope 且声明了 asyncTask
routeConventions(route)                   // 某条接口上「所有模型都会」的事：dashscope / ark 改图，dashscope 的 宽*高 尺寸
```

- **推导表是 `Record<ProtocolFamily, DerivedImageRoute>`**：`openai` / `responses` / `anthropic` → `images-api`，
  `gemini` → `gemini`，`dashscope` → `dashscope`。用 `Record` 而不是 `familyOf(...) === "gemini" ? … : …`，
  是为了下一个协议族不写一格就不编译——第五族正是从三元表达式的 else 分支里漏过去的。
- **`DerivedImageRoute` 只含 `images-api` / `gemini` / `dashscope`。** `chat` / `comfyui` / `ark` 永远不会被推出来，
  所以对它们「声明值 ≡ 有效路线」由类型保证；`caps.route === "comfyui"` 这种只认声明的写法因此仍然成立，
  不必为了它把渠道一路传到 `imageStore` / `imageTools` 里去。三个可推导的值则**不许**拿声明值直接比——
  `imageRoute.test.ts` 扫源码守着这一条。
- **`standard` 是模型当前线路的标准**（`providerFor(model)` / 抽屉里的 `routeProvider(channel, route)`）。
  抽屉保存时把自己的 `route` 写成 `activeRoute`，所以抽屉问的和客户端问的是同一个 `standard`。

### 谁写、谁读

| 状态 | 谁写 | 存在哪 |
|---|---|---|
| 声明值 `caps.route` | 抽屉的出图接口下拉；选 wan2.7 / Seedream 方言时填空白 | 模型行 `caps` |
| `caps.asyncTask` | 抽屉的异步开关；**有效路线**是 `dashscope` 时才留，否则保存时清掉 | 模型行 `caps` |
| 有效路线 | 不存。每次由 `effectiveImageRoute` 从声明值 + 当前线路算出 | —— |

`asyncTask` 的清除规则没变，只是判断从「声明值是 dashscope」换成「有效路线是 dashscope」：换了线路或换了出图接口，
只要图还打 DashScope 原生，开关就还在、值就还留着；图不再打那里，开关收起、保存时清掉，免得一个看不见的旧值
在别的接口上起作用。客户端那一侧同样只经 `effectiveAsyncTask` 读它，即使库里残留一个旧值也碰不到别的接口。

### 旧读者 → 新读者

| 读者 | 以前 | 现在 |
|---|---|---|
| 出图客户端 `generateImage` | `resolveImageRoute(standard, conn.route)`，派发时读 `conn.asyncTask` | `effectiveImageRoute` + `effectiveAsyncTask`；`resolveImageRoute` 删除 |
| 生图弹窗「chat 线路没有张数 / 尺寸」 | `resolveImageRoute(...) === "chat"` | `effectiveImageRoute(...) === "chat"` |
| 抽屉：异步开关是否出现 | `form.capsRoute === "dashscope"` | `showsAsyncToggle(standard, draft)` → 有效路线 |
| 抽屉：保存时留不留 `asyncTask` | `form.capsRoute === "dashscope" && capsAsync` | `imageCapsToSave` → `effectiveAsyncTask` |
| 抽屉：保存时留不留 `maxRefs` | 声明值相同 | 有效路线相同（保存前的线路 vs 现在的线路） |
| 抽屉：改图 / 尺寸预填 | 选中 dashscope / ark 时 | 有效路线**变成** dashscope / ark 时——下拉改了，或模型的线路切了 |
| 新图片模型的改图缺省 `defaultImageCaps` | 只看 `standard` | 先看有效路线的 `routeConventions`，再看 `standard` |
| 「将发送」里的 `route` | 只在声明时列出 | 恒列有效路线——「自动」到底是哪个接口，在这一行看得到 |

抽屉的出图字段收进 `src/components/settings/panes/imageCapsDraft.ts`（`ImageCapsDraft` / `imageCapsToSave` /
`showsAsyncToggle` / `routeSeed`）：组件只管状态，判断是纯函数。这样「抽屉和客户端是否一致」能直接拿两边的
真函数去测，而不是在测试里再抄一遍抽屉的逻辑。

## 3. 为什么不是别的形状

- **只改推导规则**（第 1 轮）：见 §1，抽屉仍然只认声明值。
- **把有效路线写进库里**（保存时把「自动」解析成具体值存下）：模型的线路可以在抽屉之外变（渠道删掉一条线路，
  `activeFamily` 回落到主线路），存下来的值就会过期；而且「自动」这个选择本身会消失，作者再也回不到「跟着线路走」。
- **让读者各自调 `effectiveImageRoute`，但不抽出抽屉的纯函数**：推导是唯一的了，可「开关出现」「保存留值」
  「预填」三个判断还是散在一个 2000 行的组件里，测试只能照抄。抽出来之后，属性测试喂的是组件真正调用的函数。

## 4. 测试

- `src/lib/ai/__tests__/imageRoute.test.ts`：推导表逐族；`effectiveAsyncTask` 只在 dashscope 上为真；
  源码守卫——`caps.route` / `capsRoute` / `conn.route` 不许直接和 `images-api` / `gemini` / `dashscope` 比。
- `src/components/settings/panes/__tests__/imageRouteAgreement.test.ts`：属性测试。随机的
  （协议族，声明值，asyncTask）以及随机的编辑序列（改下拉、拨开关、切线路、保存再打开），每次保存后用真的
  `generateImage`（`fetch` 打桩）看请求打到哪个 URL、带不带 `X-DashScope-Async`，断言与抽屉此刻显示的有效路线
  和异步开关一致；并单独钉住第 2 轮的回归：原生线路上「DashScope 原生 + 异步 → 改回自动 → 保存」之后仍走异步任务。
