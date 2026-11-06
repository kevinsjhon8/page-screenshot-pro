# MCP 访问 — 设计文档

> 架构见 `docs/mcp-architecture.md`，落地步骤见 `docs/mcp-implementation.md`。
> 参考 `updatefiles/mcp-design.md` v1.1，差异已在架构文档 §10 列出。

---

## 1. 用户旅程

### 1.1 首次使用（Pro 用户）

```
设置页 ──► 「AI / MCP 访问」卡片
              │
              ├─ 状态：未启用
              ├─ [启用 MCP 访问]  ← 点击
              │      ├ 生成 token（32 hex）
              │      ├ 写 storage.local['psp_mcp_v1']
              │      ├ 通知 offscreen 开始连接
              │      └ 卡片展开：配置 JSON + 复制按钮
              │
              └─ 用户把 JSON 贴进 Claude Desktop 的 config
                     │
                     └─ 重启 Claude Desktop → 工具出现
```

**关键决策：不自动写 AI 客户端的配置文件。** 各客户端路径不同（macOS / Windows /
Linux、Claude Desktop / Cursor / Claude Code），自动写等于猜，猜错就是静默改坏
用户的配置。只提供**可复制的 JSON**，由用户自己粘。

### 1.2 配置 JSON 的形态

Claude Desktop（`claude_desktop_config.json`）：

```json
{
  "mcpServers": {
    "page-screenshot": {
      "command": "npx",
      "args": ["-y", "page-screenshot-mcp"],
      "env": { "PSP_MCP_TOKEN": "<32 hex>" }
    }
  }
}
```

卡片里给的是**内层**那段（`"page-screenshot": {...}`），并在下面注明
「粘贴到 `mcpServers` 里」。给整段外层的话，用户如果已有别的 server 就会
覆盖掉。

### 1.3 日常使用

```
AI：「帮我截个图看看这个页面」
  → capture_visible
  → 扩展抓取 → 图片经 WS 回到 bridge → 作为 MCP image content 返回
  → AI 看到图
```

用户在浏览器里**不需要做任何事**——除了 activeTab 授权可能已失效（§2.3）。

---

## 2. 设置页卡片

### 2.1 状态机

卡片有四种状态，每种只显示一种：

| 状态 | 触发 | 显示 |
|---|---|---|
| `pro_required` | `license.pro === false` | 标题 + 「Pro 功能」徽章 + 一句说明 + 「升级 Pro」按钮（跳到订阅详情） |
| `off` | Pro 且未启用 | 标题 + 开关（未勾）+ 说明 + 关闭状态的配置区（隐藏） |
| `on_disconnected` | Pro 且启用，offscreen 未连上 | 开关（已勾）+ 配置 JSON + 「未连接」灰点 + 排查提示 |
| `on_connected` | Pro 且启用，WS 已连 | 开关（已勾）+ 配置 JSON + 「已连接」绿点 + token 重置按钮 |

「未连接」是**正常状态**，不是错误：bridge 只在 AI 客户端启动时才跑，
用户不开 AI 客户端时它就是未连接的。文案不能写成「连接失败」。

### 2.2 卡片结构

```html
<section class="card mcp-card" id="mcp-card">
  <h2 class="mcp-title">
    <span data-i18n="optionsMcpTitle">AI / MCP access</span>
    <span class="pro-tag" id="mcp-pro" data-i18n="optionsMcpPro">Pro</span>
    <span class="conn-dot" id="mcp-dot" aria-hidden="true"></span>
    <span class="conn-text" id="mcp-state"></span>
  </h2>

  <label class="check" for="mcp-enabled">
    <input type="checkbox" id="mcp-enabled">
    <span data-i18n="optionsMcpToggle">Enable MCP access</span>
  </label>

  <p class="hint" data-i18n="optionsMcpBody">…</p>

  <div class="mcp-config hidden" id="mcp-config">
    <p class="hint" data-i18n="optionsMcpConfigHint">Paste this into the mcpServers block of your AI client's config file:</p>
    <pre class="mcp-json" id="mcp-json"></pre>
    <div class="mcp-actions">
      <button id="btn-mcp-copy" data-i18n="optionsMcpCopy">Copy config</button>
      <button id="btn-mcp-reset" class="quiet" data-i18n="optionsMcpReset">Reset token</button>
    </div>
    <div class="mcp-steps">
      <p class="mcp-steps-title" data-i18n="optionsMcpStepsTitle">How to use it</p>
      <ol class="mcp-step-list">
        <li><span data-i18n="optionsMcpStep1">Paste the JSON above into … Node 20 or newer is required.</span></li>
        <li><span data-i18n="optionsMcpStep2">Restart the client. The dot at the top turns green once the bridge connects.</span></li>
        <li><span data-i18n="optionsMcpStep3">Ask it to call psp_status first: that tool is free and reports what is wrong.</span></li>
      </ol>
      <a class="mcp-guide" id="mcp-guide" href="https://screenshotpro.agentsblockchains.com/faq/#mcp"
         target="_blank" rel="noopener" data-i18n="optionsMcpGuide">Full setup guide</a>
    </div>
    <p class="hint warn" id="mcp-msg"></p>
  </div>

  <p class="hint" id="mcp-hint"></p>
</section>
```

**三步速览与「完整说明」的分工（2026-11-01）**：卡片只放三步
（贴 JSON → 重启客户端 → 先调 `psp_status`），因为用户此刻正拿着那段 JSON；
装配细节、八件工具各要什么、`needs_user_gesture` 为什么不是缺陷，都在官网 FAQ
的 `#mcp` 那一组（八个语言都有）。链接的地址由 `utils/site-links.ts` 的
`mcpGuideUrl()` 给，在 `renderMcpCard()` 里按 `resolveLocale()` 重算——两条语言
路径（下拉框的 change 与文件末尾的 `lang.load()`）都会重画这张卡片，否则切完
语言链接还停在旧语言。它是原生 `<a target="_blank" rel="noopener">`，**没有**
点击监听：开新标签页是浏览器行为，不需要 `tabs` 权限，也就没有失败面要报告。

三条从占位卡片继承下来的约束，**实现时必须继续成立**：

1. **`data-i18n` 只能挂在内层 `<span>` 上**。`localizeDocument()` 用
   `textContent = …`，挂在 `<h2>` 上会把 Pro 徽章和连接点整个抹掉。
   占位卡片已经踩过一次（注释写在 `options.html:111`）。
2. **不进 `storage.sync`**。MCP 状态是每台机器一个 token，漫游到别的机器
   等于两台机器抢同一个 token。存 `storage.local['psp_mcp_v1']`。
3. **不新增 manifest 权限**。卡上写 Pro，权限数组一个字不改。

### 2.3 `needs_user_gesture` 的说明位置

不在设置页常驻，只在**工具调用失败时**由 bridge 返回的 message 里说。
设置页的 `#mcp-hint` 常驻一句更短的：

> 浏览器要求截图前有过一次点击。如果 AI 报告权限错误，点一下扩展图标再让它重试。

这句话是 MCP 体验里最容易被当成 bug 的一处，必须在用户**配置的时候**就看到，
而不是等第一次失败。

### 2.4 token 重置

点「重置 token」→ 二次确认（一个 `confirm()` 太糙，用现有的 `.modal` 样式）
→ 覆盖 `storage.local` → 断开 WS → 配置区刷新成新 JSON → 提示
「旧配置已失效，请更新 AI 客户端的设置」。

**不能**做成「点一下就重置」：用户手滑一次就要重新配一遍。

---

## 3. 工具定义

### 3.1 `psp_status`（唯一免费工具）

```ts
{
  name: 'psp_status',
  description: 'Check whether Page Screenshot Pro is installed, connected and licensed. Use this first when a screenshot tool fails.',
  inputSchema: {},
  // 返回 JSON 文本
}
```

返回：

```json
{
  "connected": true,
  "pro": true,
  "version": "0.1.5",
  "activeTab": { "title": "…", "url": "https://…" },
  "mcpEnabled": true,
  "toolsAvailable": ["capture_visible", "…"]
}
```

**为什么免费**：它是诊断工具。非 Pro 用户调它得到 `pro:false` 与
「哪些工具需要 Pro」，这是升级路径的一部分，不是功能泄露。

### 3.2 截图类

```ts
capture_visible({ format?: 'jpeg'|'png', maxWidth?: number })
capture_full_page({ format?, maxWidth?, expandInfiniteScroll?: boolean })
capture_element({ selector: string, format?, maxWidth? })
```

共同返回：

```ts
{
  content: [
    { type: 'image', data: '<base64>', mimeType: 'image/jpeg' },
    { type: 'text', text: 'Captured 1440×900 (visible area). Saved to history as <id>.' }
  ]
}
```

- `format` 默认 `jpeg`（体积），`png` 可选。
- `maxWidth` 默认 **2048**，上限 4096，下限 320。缩放在 offscreen 用 Canvas 做。
- `selector` 用 `querySelector`；匹配多个取第一个；找不到 → `invalid_params`
  并提示「用 DevTools 确认选择器」。

**`capture_full_page` 的超时**：MCP 层默认 120s，全页给 **300s**。
`MAX_SEGMENTS` 40 行 × 每行可能多列的页面上，300s 是够的余量。

### 3.3 `ocr_capture`

```ts
ocr_capture({ selector?: string })   // 省略则截可见区
```

返回文本：`{ content: [{ type: 'text', text: '<识别文字>' }] }`。

走的是编辑器同一个 `runOCR`，所以分带、重叠、行归属的行为完全一致。

### 3.4 `history_list` / `history_get`

```ts
history_list({ limit?: number })    // 默认 20，上限 30（HISTORY_MAX）
history_get({ id: string, format?, maxWidth? })
```

`history_list` 返回文本表格（id / kind / 尺寸 / 时间），**不返回图片**——
一次返回 20 张图会撑爆上下文。

### 3.5 `export_pdf`

```ts
export_pdf({ id: string })
```

返回 `resource`：`application/pdf`，base64。

---

## 4. Pro 门禁的完整落点

`can(license, FEATURE.MCP)` 是唯一判据。但**加一个 feature key 需要改四处**，
少一处就是静默失效（本仓库的 `expired` 死字段形状）：

### 4.1 `utils/entitlements.ts`

```ts
export const FEATURE = {
  …
  OCR: 'ocr',
  MCP: 'mcp',          // ← 新增
} as const;

export const PRO_FEATURES = [
  ...FREE_FEATURES,
  FEATURE.CAPTURE_ELEMENT,
  FEATURE.FORMAT_PDF,
  FEATURE.MERGE_PDF,
  FEATURE.OCR,
  FEATURE.MCP,         // ← 新增
];
```

`FREE_FEATURES` **不动**。MCP 是纯 Pro 功能，没有免费额度。

### 4.2 `tools/validate.mjs` 的 `PRO_FEATURE_CALLSITES`

```js
MCP: {
  file: 'entrypoints/background.ts',
  symbol: 'requireFeature(FEATURE.MCP)',
  why: 'MCP 通道的全部工具（psp_status 除外）',
},
```

检查 21 是**双向**的：加了 key 不登记会红，登记了 key 删了也会红。

### 4.3 `tests/feature-copy.test.ts`

```ts
const PRO_ONLY = ['capture.element', 'format.pdf', 'merge_pdf', 'ocr', 'mcp'];

const PRO_MARK = {
  …
  mcp: {
    en: 'mcp', zh_CN: 'mcp', zh_TW: 'mcp', ja: 'mcp',
    ko: 'mcp', es: 'mcp', fr: 'mcp', de: 'mcp',
  },
};
```

**为什么全是 `mcp`**：这个表是「文案里必须出现哪个词」的判据。MCP 在八种语言里
都是 `MCP`（技术缩写不翻译），所以八行一样。这是**手写表**，不是从
`messages.json` 读的——从同一份资源读的期望值永远绿（`subChangeTo` 的教训）。

### 4.4 三句文案 × 8 语言

`welcomePricingBody`、`subCancelStep1`、`subCancelStep1NoDate` 三句里都枚举了
Pro 的内容，必须加上 MCP。以 `en` 为例：

- `welcomePricingBody`：
  「…Pro adds PDF export, PDF merging, OCR, **MCP access** and element capture,
  with unlimited captures.」
- `subCancelStep1`：
  「After canceling, Pro turns off on $DATE$: element capture, PDF export,
  PDF merging, **MCP access** and OCR all stop working.」
- `subCancelStep1NoDate`：同上，「at the end of this billing period」。

zh_CN 对应：
- 「…Pro 增加 PDF 导出、合并 PDF、OCR、**MCP 访问**与元素截图，并且不限次数。」
- 「取消后 Pro 会在 $DATE$ 关闭：元素截图、PDF 导出、合并 PDF、**MCP 访问**和
  OCR 都会随之失效。」

另外 `utils/subscription-ui.ts` 的 zh_CN `FALLBACK` 字典里也有这两句，
**必须同步改**——它是 `subTranslator` 的兜底，单测会读它。

---

## 5. token 与存储

### 5.1 存储形态

`storage.local['psp_mcp_v1']`：

```ts
interface McpState {
  enabled: boolean;
  token: string;        // 32 hex，首次启用时生成
  createdAt: number;
  lastConnectedAt?: number;
}
```

**不放 `storage.sync`**：token 是「本机授权」，漫游会让两台机器抢同一个 token，
且 `storage.sync` 有 8KB 单键限制与配额，虽然够用但没有理由冒这个险。

### 5.2 生成

```ts
crypto.getRandomValues(new Uint8Array(16))  // → 32 hex
```

`crypto` 在扩展页面与 SW 里都有（`window.crypto` / `self.crypto`）。
**不用** `Math.random()`——它不是密码学安全的。

### 5.3 比较

常量时间：

```ts
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
```

长度不等直接返回 `false` 会泄露长度，但 token 长度是固定的 32，泄露它没有意义。

### 5.4 生命周期

| 事件 | 动作 |
|---|---|
| 用户启用 | 无 token 则生成 → 写盘 → 通知 offscreen 连接 |
| 用户停用 | 通知 offscreen 断开 → `enabled: false`（**保留 token**） |
| 用户重置 token | 生成新 token → 断开 → 重连（旧连接用旧 token，必须断） |
| 扩展重载 | offscreen 重建 → 读 token → 重连 |
| 授权失效（`pro:false`） | 不断开（用户可能刚过期），但每次工具调用都判 `can()` |

---

## 6. 调用日志

`storage.local['psp_mcp_log_v1']`，环形缓冲 50 条：

```ts
interface McpLogEntry {
  ts: number;
  tool: string;
  ok: boolean;
  code?: string;       // 失败时的错误码
  ms: number;          // 耗时
  bytes?: number;      // 图片字节数
}
```

**只记元数据，不记图片、不记参数内容**（`selector` 可能包含敏感信息）。
设置页显示最近 10 条，折叠展开看全部 50 条。

为什么要它：MCP 失败时用户只能看到 AI 客户端里的一句错误，
没有本地日志就无法判断是「没连上」还是「没授权」还是「页面截不了」。

---

## 7. 未连接状态的文案

「未连接」有三种原因，文案必须分开，否则用户排查方向全错：

| 原因 | 判据 | 文案 |
|---|---|---|
| 还没开 AI 客户端 | 从未连上过 | 「尚未连接。在 AI 客户端里启动配置好的 server 后会自动连接。」 |
| 连上过，现在断了 | `lastConnectedAt` 存在 | 「上次连接：<时间>。AI 客户端退出后断开是正常的。」 |
| 连不上 | 重连失败 5 次以上 | 「连不上。确认 AI 客户端已重启，且配置里的 token 与上方一致。」 |

第三种要单独说，因为最常见的原因是用户改了 token 却没更新配置。

---

## 8. i18n 键清单

新增键（8 语言全要）：

| 键 | en |
|---|---|
| `optionsMcpTitle` | AI / MCP access |
| `optionsMcpPro` | Pro |
| `optionsMcpToggle` | Enable MCP access |
| `optionsMcpBody` | Let AI tools such as Claude Desktop, Cursor or Claude Code take screenshots through this extension. Everything runs on your own machine and nothing is uploaded. |
| `optionsMcpConfigHint` | Paste this into the `mcpServers` block of your AI client's config file: |
| `optionsMcpCopy` | Copy config |
| `optionsMcpCopied` | Copied |
| `optionsMcpCopyFailed` | Couldn't copy. Select the text and copy it manually. |
| `optionsMcpReset` | Reset token |
| `optionsMcpResetConfirm` | The old config stops working immediately. Continue? |
| `optionsMcpResetKeep` | Keep current token |
| `optionsMcpResetProceed` | Reset anyway |
| `optionsMcpResetDone` | Token reset. Paste the new config into your AI client. |
| `optionsMcpHint` | Browsers require a click before a screenshot. If the AI reports a permission error, click the extension icon and ask it to retry. |
| `optionsMcpStateOff` | Not connected |
| `optionsMcpStateOn` | Connected |
| `optionsMcpStateNever` | Not connected yet. It connects automatically once your AI client starts. |
| `optionsMcpStateLost` | Last connected $TIME$. It disconnects when the AI client exits, which is normal. |
| `optionsMcpStateFail` | Cannot connect. Make sure the AI client was restarted and its token matches the one above. |
| `optionsMcpProNote` | MCP access is a Pro feature. |
| `optionsMcpUpgrade` | Upgrade to Pro |
| `optionsMcpLogTitle` | Recent calls |

`optionsMcpSoon` **删除**（登记进 `validate-i18n.mjs` 的 `RETIRED_KEYS`）。
`optionsMcpBody` 改写（去掉「and it is not available yet」）。

MCP 层错误文案（走 `t()`，在 background / offscreen 里取）：

| 键 | en |
|---|---|
| `mcpProRequired` | MCP access requires Pro. Open the extension settings to upgrade. |
| `mcpBusy` | A screenshot is already in progress. Try again in a moment. |
| `mcpElementNotFound` | No element matches that selector. Check it in DevTools and try again. |
| `mcpSelectorRequired` | capture_element needs a CSS selector, for example "#main .title". |
| `mcpImageTooLarge` | The image is too large. Try a smaller maxWidth. |
| `mcpUnknownTool` | Unknown tool. Ask for the tool list again; the extension may be a different version. |

**只有这六个**。设计初稿还列了 `mcpNotConnected` / `mcpNeedsGesture` /
`mcpTabNotCapturable` / `mcpTimeout`，实现时发现它们一个消费点都没有——这四种
情况扩展侧根本没有机会回话：连不上时没有通道，超时由桥接进程计时，用户手势和
"这个页面截不了"的说明由 `mcp-server/src/errors.ts` 的 `HINTS` 表给出（那是
AI 客户端真正读到的文本，且要按 `code` 决定"下一步该做什么"，本来就该在
bridge 侧）。四个键已从八份资源里删除并登记进 `RETIRED_KEYS`。

**`mcpSelectorRequired` 的可达面比这张表看起来窄，实测过（2026-11-01）**：
`capture_element` 的 inputSchema 声明了 `required: ['selector']` +
`minLength: 1`，所以**缺省**和**空串**都由 MCP SDK 的 ajv 校验先答
（`data must have required property 'selector'` /
`data/selector must NOT have fewer than 1 characters`），这两句是 SDK 的英文
原文，不是这六句里的任何一句，也不走 `t()`——它们由 AI 客户端直接看到。
扩展侧那句 `mcpSelectorRequired` 只有**纯空白选择器**能触发（空白满足
`minLength`，而 `querySelector('   ')` 会抛 SyntaxError）。这不是缺陷，是
schema 分层的必然结果；写在这里是为了让维护者别把它当成"用户看得到的正常
路径"，也解释了 `background.ts` 那个判断为什么用 `trim()` 而不是 `!selector`。

`history_get` / `export_pdf` 缺 `id` / id 不存在时用的是既有键
`editorMissingShotId` / `bgShotExpired`，不复用上面任何一条——那两条讲的是
CSS 选择器，跟截图 id 没关系（offscreen 侧曾经抄错，见实现文档 §K 的缺陷记录）。

---

## 9. 与现有功能的边界

| 现有行为 | MCP 是否影响 |
|---|---|
| 快捷键截图 | 否 |
| 右键「截取该元素」 | 否（MCP 走新消息，不动 `psp-pick-element`） |
| 弹窗截图 | 否 |
| 配额计数 | 是——MCP 截图**同样计数**，且走 `finishShot` 的同一处记账 |
| 历史记录 | 是——MCP 截图**进历史**，用户能在弹窗里看到 AI 截了什么 |
| 编辑器 | 否——MCP 不打开编辑器 |
| 下载 | 否——MCP 不下载文件，图片走 WS |
| 剪贴板 | 否——MCP 不写剪贴板 |

**「进历史」是刻意的**：AI 在用户机器上截图，用户必须能事后查看。
不进历史 = 一次看不见的截图。

**「不下载」也是刻意的**：MCP 的产物直接给 AI，落盘由用户自己决定。
自动下载会让 Downloads 里堆满 AI 的中间产物。

---

## 10. 版本与发布

- 0.1.4 → `0.1.5` → **`0.1.6`**（2026-11-05），五处同步：
  `package.json`、`wxt.config.ts`、`site/src/content/site.ts` 的
  `SOFTWARE_VERSION`、`site/package.json`、`CHANGELOG.md` 的 `## [0.1.6]`。
  0.1.6 只改商店素材与 OCR 体积，MCP 相关代码一行未动。
- bridge 独立版本。`0.1.0` 于 2026-11-01 发布到 npm，**同一小时发现它的
  `bin` 跑不起来**（缺 shebang，见 `docs/mcp-implementation.md` §F2），
  `0.1.1` 修复并重新发布。**用户配置里写的 `npx -y page-screenshot-mcp`
  取的是 `latest`**，所以只要 `latest` 是好的就行；`0.1.0` 留在 registry 上
  无法撤回（72 小时后不可 unpublish），也不需要——没有一个可用的下游会去装它。
- bridge 已发布 npm：`page-screenshot-mcp`（`latest` = `0.1.1`）。发布前确认过
  包名未被占用（`mcp-deep-dive.md` U6 记录当时空闲）。**发布顺序是硬约束**：
  设置页卡片生成的 JSON 写的是 `npx -y page-screenshot-mcp`，所以 npm 包必须
  **先于**扩展上架可用——反过来上线，用户第一天拿到的就是 npx 的 404。

### 10.1 「0.1.5 新增」角标：已按约定在 0.1.6 删除

2026-11-02 用户要求「要说明 MCP 是从 0.1.5 新加的」，落地形态是标题行里的
`#mcp-new`（`.new-tag`，浅绿底 `#dcfce7` / 深绿字 `#15803d`），文案
`optionsMcpNew`，八种语言里都带版号。它从设计上就是**临时**的，并且
**2026-11-05（0.1.6）已经按时删掉**：那个 span、`.new-tag` 规则、八份
`optionsMcpNew`、e2e 里那三条正向断言，全部清空；键登记进了
`tools/validate-i18n.mjs` 的 `RETIRED_KEYS`。

留下的两条经验，将来再加任何「新版功能」标记时照用：

1. **位置在标题之后、Pro 之前**。`scripts/settings-e2e.mjs` 第 ⑥ 步用
   `#mcp-card .mcp-title > span[data-i18n]` 取**第一个**匹配项当标题，带
   `data-i18n` 的装饰排到前面，那条断言就会拿角标文案去比 `optionsMcpTitle`
   而红——红的位置看着像标题没跟随语言。删除后标题重新成为第一个匹配项。
2. **颜色不能和 `.pro-tag` 相同**。徽章在用户眼里等于"要付钱"，新增角标等于
   "你可能还不知道"；同样用琥珀色等于把两件事说成一件，用户会把 MCP 读成
   刚上线的付费墙。当时 e2e 比的是**计算后的 backgroundColor**，不是样式表
   字面值。

★ **删除本身需要一条反向断言**，理由和当初要那三条正向断言一样：
拆掉一块标记不会让任何东西变红，"删了"和"忘了删"在别处完全不可区分。
所以 0.1.6 把 e2e 那三条换成了 `#mcp-new` **不存在**这一条；静态侧由
`RETIRED_KEYS` 双向兜（八份资源里都写回来也红）。这也是 §10.1 这条规则
能成立的原因——它要求"有人真的来删"，而这个检查就是那个人。
教训适用于所有会过期的标记：**过期行为的检查必须写成"它不在了"，
不能只删掉原来那条"它还在"。**

