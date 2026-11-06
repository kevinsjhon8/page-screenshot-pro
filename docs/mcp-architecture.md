# MCP 访问 — 架构文档

> 状态：v1 设计定稿（2026-11-01）。实现见 `docs/mcp-implementation.md`。
> 参考：`updatefiles/mcp-design.md`（v1.1）与 `updatefiles/mcp-deep-dive.md`。
> 那两份文档是**参考**不是标准：本文已按本仓库当前状态（v0.1.4）逐条核对，
> 与参考不一致处以本文为准，差异在 §10 列出。

---

## 1. 目标与非目标

### 1.1 目标

让 AI 客户端（Claude Desktop / Cursor / Claude Code）通过 MCP 协议调用本扩展截图，
图片**留在本机**，不经过任何服务器。

- 七个工具：`psp_status`、`capture_visible`、`capture_full_page`、`capture_element`、
  `ocr_capture`、`history_list`、`history_get`、`export_pdf`。
- 走现有的截图管线（`doVisible` / `doFullPage` / 元素裁剪 / 拼接），
  因此配额、`file://` 权限、无限滚动展开、懒加载预取、拼接修正**全部照常生效**。
- MCP 是 Pro 功能，门禁在扩展侧（bridge 是用户机器上的代码，可被改）。

### 1.2 非目标（v1 明确不做）

| 不做 | 理由 |
|---|---|
| `capture_url`（截任意 URL） | 需要 `tabs.create` + 后台标签页权限路径，属于 v2 |
| `capture_region`（选区） | 需要人工拖拽，MCP 无人交互 |
| `execute_script` 类工具 | **永久红线**。CWS 远程代码政策（RHC），见 §8 |
| 任意 `tabId` 截图 | v1 只截**当前活动标签页**，避免 AI 遍历用户所有标签页 |
| 图片上传 / 云 OCR | 产品承诺「本地处理」，任何上传都违背它 |
| 多 AI 客户端同时连接 | v1 只支持一个 bridge 实例，见 §6.4 |

---

## 2. 三层拓扑

```
┌──────────────────┐   stdio (JSON-RPC)   ┌───────────────────────────┐
│  AI 客户端        │◄────────────────────►│  bridge                    │
│  Claude Desktop   │                      │  `npx -y page-screenshot-mcp`│
│  Cursor           │                      │  Node ≥ 20                 │
│  Claude Code      │                      │  ┌──────────────────────┐  │
└──────────────────┘                      │  │ McpServer (stdio)    │  │
                                           │  │ + WebSocketServer    │  │
                                           │  └──────────┬───────────┘  │
                                           └─────────────┼──────────────┘
                                                         │ ws://127.0.0.1:39127
                                                         │ （39127–39137 扫描）
                                           ┌─────────────▼──────────────┐
                                           │ 扩展 offscreen document     │
                                           │ entrypoints/offscreen/      │
                                           │   mcp-bridge.ts             │
                                           └─────────────┬──────────────┘
                                                         │ chrome.runtime.sendMessage
                                           ┌─────────────▼──────────────┐
                                           │ background.ts（service worker）│
                                           │   mcp-request → mcpCaptureTool│
                                           │   → finishShot({openEditor:false})│
                                           └─────────────┬──────────────┘
                                                         │ psp-* / os-*
                                    ┌────────────────────┼────────────────────┐
                                    ▼                    ▼                    ▼
                             content.ts            offscreen（Canvas）    IndexedDB
                             （页面状态）           （拼接 / 裁剪）        （原图）
```

### 2.1 为什么 WebSocket 服务端在 bridge，不在扩展

浏览器**不能监听端口**。扩展只能作为 WS 客户端去连。所以：

- bridge（Node 进程）`WebSocketServer` 监听 `127.0.0.1:39127`。
- 扩展的 offscreen 文档作为客户端连过去。
- 连接是**扩展主动发起**的，因此扩展必须有重连逻辑（指数退避 1s→30s，静默），
  否则「先开 AI 客户端还是先开浏览器」就成了使用顺序问题。

### 2.2 为什么在 offscreen，不在 service worker

| 约束 | SW | offscreen |
|---|---|---|
| 生命周期 | 30s 空闲回收 | 文档级，`BLOBS` reason 不自动回收 |
| 长连接 | 会被回收打断 | 保持 |
| DOM / Canvas | 无 | 有（`runOCR`、`createImageBitmap` 都要求） |

MV3 SW 回收会直接杀死 WS，而 MCP 的典型形态是「AI 客户端挂着，用户偶尔问一句」，
中间可能空闲几分钟。SW 撑不住。

**Chrome 116+ 的 SW WebSocket 会重置空闲计时器**（`mcp-deep-dive.md` U3 记录），
但那只是缓解：SW 仍可能因内存压力被回收，且**每次 SW 重启都要重新握手**。
v1 不用这条路。

### 2.3 复用现有的 offscreen 文档

Chrome 同一时刻**只允许一个 offscreen document**。现有的
`createOffscreenDoc()`（`background.ts:308`）已经在用 `offscreen.html` + `reasons:['BLOBS']`，
MCP 的 WS 客户端就放在**同一个文档**里，不新建。

`entrypoints/offscreen/main.ts` 现在是：

```ts
await ensureFallbackMessages(async () => {...});
setupCanvasBackend();
```

加一行：

```ts
setupMcpBridge();   // 必须在 ensureFallbackMessages 之后
```

**没有单例争用**：Canvas 后端监听 `os-*`，MCP 监听 `mcp-*`，两者消息前缀不重叠。

---

## 3. 为什么零新增 manifest 权限、不动 CSP

这是本设计的**硬约束**（`updatefiles/mcp-deep-dive.md` U1，双重证据）：

1. **官方文档**：MV3 的 `content_security_policy.extension_pages` 默认策略只限制
   `script-src` / `object-src`，**不限制 `connect-src`**。扩展页面的 `fetch` / `WebSocket`
   到本机地址不受 CSP 阻拦。
2. **实测**：headless Chromium 里从 offscreen 文档连 `ws://127.0.0.1:…` 成功；
   对同一地址 `fetch` 失败。两者走不同规则，WS 不受 host 权限约束。

因此 `wxt.config.ts` 一个字都不改。这条必须守住，否则就成了
「用 Pro 名义扩大权限」——卡片上写着 Pro，权限却涨了一行，商店页面上看得见。

**注意**：如果将来有人为了别的功能加了 `connect-src`，本设计会失效。
`tools/validate.mjs` 会在实现阶段加一条检查（见实现文档 §5），
确保 `extension_pages` 里不出现 `connect-src`。

---

## 4. 消息协议

### 4.1 第一层：MCP（AI 客户端 ↔ bridge）

由 `@modelcontextprotocol/server` 2.4.0 处理，我们只提供工具实现。
**stdout 只跑协议，所有日志走 stderr**（U7）。

### 4.2 第二层：WebSocket（bridge ↔ 扩展）

JSON 文本帧，统一信封：

```ts
// 扩展 → bridge：请求结果
{ type: 'result', id: string, ok: true, result: unknown }
{ type: 'result', id: string, ok: false, error: { code: string, message: string } }

// 扩展 → bridge：进度（可选）
{ type: 'progress', id: string, phase: string, percent: number }

// bridge → 扩展：请求
{ type: 'request', id: string, tool: string, params: unknown }

// 扩展 → bridge：认证（连接后第一帧，且只发一次）
{ type: 'auth', token: string, protocolVersion: number }

// bridge → 扩展：认证结果
{ type: 'auth-ok', protocolVersion: number }
{ type: 'auth-fail', reason: string }   // 随后 close(4001)
```

**图片走二进制帧**，前置一个元数据文本帧：

```
→ { type: 'image', id, mime: 'image/jpeg', w, h, bytes, chunkIndex, chunkCount }
→ <binary frame: 该块字节>
```

bridge 按 `id` 组装。`chunkIndex` 从 0 开始，`chunkCount` 是该图总块数。
WS 保证帧顺序，所以「元数据帧 → 紧随的二进制帧」配对可靠。

**为什么分块**：`StdioServerTransport` 的 `maxBufferSize` 默认 **10 MB**，
单条 MCP 消息超过它，transport 会报错并关闭整条连接。一张长截图 base64 后很容易
超过，所以：
- 扩展侧 `maxWidth` 默认 **2048**，输出 **JPEG q85**（不是 PNG）；
- 仍然分块传输，块大小 **4 MiB**；
- bridge 侧组装后若总 base64 仍超 8 MB，返回 `capture_failed` 并提示调小 `maxWidth`。

### 4.3 第三层：扩展内部（offscreen ↔ background）

复用现有的 `chrome.runtime.sendMessage` + `{ok, result|error}` 信封：

```ts
// offscreen → background
{ type: 'mcp-request', tool: string, params: unknown }

// background → offscreen（由 sendResponse 带回）
{ ok: true, result: { id?, w?, h?, warnings?, text?, bytes? } }
{ ok: false, error: string, mcpCode?: string }
```

`mcpCode` 是给 MCP 用的错误码（见 §5），`error` 是给人看的中文/本地化文案。
**两个都要**：bridge 需要 code 决定 MCP 层的 `isError` 与提示，用户需要人话。

#### 4.3.1 存储代理：offscreen 一律不碰 `browser.storage`

**这一条是 2026-11-01 用一次真机 e2e 换来的，不是设计洁癖。** offscreen 文档里的
`chrome` 全局被 Chrome 裁过——实测 `Object.keys(chrome)` 只有
`['csi','loadTimes','runtime']`，`i18n` 与 `storage` 都没有（`runtime` 有）。
`@wxt-dev/browser` 的解析器因为 `browser.runtime.id` 为真而选中这个被裁的对象，
所以**类型上** `browser.storage.local` 存在，**运行时**它是
`undefined.local` → `TypeError`。

关键在于抛出时机：写成模块顶层的 `const kv = browser.storage.local`，这个
`TypeError` 发生在**求值阶段**，也就是那个模块的任何一个函数都还不存在的时候；
而 `entrypoints/offscreen/main.ts` 里 `setupCanvasBackend()` 排在
`setupMcpBridge()` **前面**，于是"没开过 MCP 的人"也一起失去了拼接能力。用户跑
`node scripts/settings-e2e.mjs` 看到的第一行红就是它：
「os-ping 无响应：offscreen 文档未注册监听（Canvas 后端不可用）」——一句和 MCP
毫无关系的话。`npm run check` 当时**全绿**，因为 offscreen 的 import 图没有单测，
而 `tools/validate.mjs` 检查 3 只从 `background.ts` 出发（那里 storage 是合法的）。

所以三条消息补进来，全部是薄包装，语义留在有单测的纯模块里：

| 消息 | 作用 | 语义所在 |
|---|---|---|
| `mcp-state-get` | 读 `storage.local['psp_mcp_v1']` | `utils/mcp-token.ts` `readMcpState` |
| `mcp-touch` | 记一次成功认证时间（写 `lastConnectedAt`） | 同上，`writeMcpState` |
| `mcp-log-add` | 追加一条工具调用日志 | `utils/mcp-log.ts` `pushLog` |

这份名单只有一份：`utils/mcp-messages.ts` 的 `MCP_BG_REQUESTS` + `isMcpBgRequest()`。
两侧的规则是**互补**而不是各抄一份——background 只处理名单里的、其余 `mcp-*`
让路；offscreen 只让路名单里的、其余（`mcp-ping` / `mcp-reload` / `mcp-state`）
才是它该答的。抄两份时加一个新消息漏改任一边都是静默的。

`tools/validate.mjs` 检查 25 从两个 Canvas 入口走 import 图，任何可达模块出现
`browser.storage` / `chrome.storage` 就红（变异验证过两个方向：入口文件、以及
深层的 `utils/i18n.ts`）。**它必须是图而不是"扫 `entrypoints/offscreen/`"**：
可达模块分布在 `utils/` 里，而同目录的 `mcp-token.ts` / `settings.ts` 本来就该
碰 storage——它们在 background 那一侧。

最后一个后果，写在这里免得下一个人去加回来：offscreen **无法**订阅
`storage.onChanged`。状态变更靠两条覆盖，都不需要它碰存储——设置页改完直接发
`mcp-reload`；background 自己的 `storage.onChanged` 触发 `syncMcpHost()`，
状态变了就重建/关闭 offscreen 文档，而重建本身就是一次干净的 `reload()`。

### 4.4 前缀约定

现有两类前缀：`psp-*`（content ↔ background）、`os-*`（canvas 后端）。

新增 **`mcp-*`**（offscreen ↔ background）。在 `background.ts` 的监听器里，
`mcp-*` **不能**走 `psp-progress` / `os-*` 那几条 `return false`——它需要回包。
但同时 `mcp-request` 只由 offscreen 发送，content 和 popup 不会发，
所以不会有双重 `sendResponse`。

---

## 5. 错误码

| code | 何时 | 用户看到 |
|---|---|---|
| `pro_required` | 非 Pro 调用任一工具（`psp_status` 除外） | 升级提示 |
| `extension_not_connected` | WS 断开 / bridge 未启动 | 「扩展未连接」+ 排查步骤 |
| `busy` | 已有截图在跑（`withCaptureLock` 拒绝） | 「正在截图，请稍后」 |
| `tab_not_found` | 活动标签页是 `chrome://` 等不可截页面 | 说明原因 |
| `needs_user_gesture` | `activeTab` 授权已失效（页面导航过） | 让用户点一下扩展图标 |
| `capture_failed` | 抓取/拼接/编码失败 | 原始错误 + 建议 |
| `page_not_scriptable` | content script 注入失败 | 说明 |
| `invalid_params` | 参数校验失败 | 指出哪个字段 |
| `internal` | 其余 | 通用 |

`needs_user_gesture` 是本设计最重要的错误码，见 §7.1。

---

## 6. 数据流

### 6.1 `capture_visible`（最简路径）

```
bridge          offscreen            background
  │ request ──────►│
  │                │ mcp-request ─────►│
  │                │                  │ requireFeature(MCP)
  │                │                  │ withCaptureLock(mcpCaptureTool('visible'))
  │                │                  │   ├ requireQuota()
  │                │                  │   ├ captureOne(tab)
  │                │                  │   ├ os-crop {rect:null}
  │                │                  │   └ finishShot(..., {openEditor:false})
  │                │                  │       ├ idbPutShot
  │                │                  │       ├ addHistory
  │                │                  │       └ await consumeCapture
  │                │◄── {id, w, h} ───│
  │                │ idbGetShot(id)
  │                │ downscale → JPEG
  │◄── image ──────│
  │◄── result ─────│
```

**关键**：`finishShot` 是唯一的配额记账点（validate check 8 钉着），
MCP 路径必须走它，不能自己记账。

### 6.2 `ocr_capture`

同上到 `{id}` 为止，然后 **offscreen 自己**：

```
idbGetShot(id) → runOCR(dataUrl, onProgress) → {text, lines, degraded}
```

`utils/ocr.ts` 用了 `new Image()` / `document.createElement('canvas')`，
**不能在 background 里跑**（validate check 3 会红）。offscreen 是唯一正确的宿主。

### 6.3 `export_pdf`

`utils/pdf.ts` 的 `buildPdf` 是 DOM-free，background 也能跑。但为了统一，
在 offscreen 做：

```
idbGetShot(id) → JPEG 字节 → buildPdf([{data, w, h}]) → Uint8Array
→ base64 → WS
```

MCP 层返回 `resource`（`application/pdf`，base64）。

### 6.4 端口扫描与多实例

bridge 启动时从 **39127** 开始 `listen`，占用则试 39128…39137，全部失败则
stderr 报原因并 `exit(1)`（不静默重试）。

扩展侧按同样顺序连，每个端口超时 **400ms**，最坏 11 × 400ms = 4.4s。

**代价**：第二个 AI 客户端启动的 bridge 会落到 39128，而扩展只连第一个连上的。
v1 接受这个限制（文档写明），v2 可以用「bridge 写端口文件、扩展读」解决。

---

## 7. 授权边界（activeTab）

### 7.1 问题

`captureVisibleTab` 要求 `<all_urls>` 或 **activeTab 授权**。`activeTab` 是
**用户手势**授予的临时 host 权限，且**导航后失效**。

实测错误：`Either the '<all_urls>' or 'activeTab' permission is required.`

MCP 的调用来自 AI 客户端，**没有用户手势**。所以：

- 用户刚点过扩展图标 / 用过快捷键 → activeTab 有效 → 截图成功。
- 用户上次授权后导航到了别的页面 → activeTab 失效 → 截图失败。

### 7.2 三层缓解

1. **预检**：`mcpCaptureTool` 在抓取前先 `tabs.get(activeTab)` 并检查 URL 是否可截，
   失败立刻返回 `needs_user_gesture`，**不消耗配额**（闸门只读，见 §6.1）。
2. **明确文案**：`needs_user_gesture` 的 message 直接说
   「请在浏览器里点一下本扩展图标（或按 Alt+Shift+D）再重试」。
3. **可选的手势豁免**：设置页提供「允许 AI 在无需点击时截图」开关，
   打开时申请 `optional_host_permissions: ['<all_urls>']`（用户点击才弹权限框）。
   **默认关闭**，因为它在商店权限列表里是「读取和更改所有网站上的数据」。

v1 **不实现**第 3 层（避免权限面扩大），只在设置页用一行说明指向它。
这条在实现文档里登记为 Phase 3 可选项。

---

## 8. 安全模型

| 威胁 | 对策 |
|---|---|
| 任意网页连本机 WS | WS 只绑 `127.0.0.1`；且要求 token 认证 |
| 恶意页面伪装成扩展 | 扩展**主动连出**，不监听；bridge 不信任入站连接的身份，只信 token |
| 恶意页面通过 WS 反向攻击 | bridge 不执行任何扩展发来的代码；扩展也不接受任何代码字符串参数 |
| token 泄露 | 128-bit 随机；存 `storage.local`（不同步、不进备份）；设置页可一键重置，立即断开 |
| AI 客户端被诱导截图敏感页面 | v1 只截**当前活动标签页**，用户眼睛看得见 |
| 绕过 Pro 门禁 | 门禁在扩展侧（`can(license, FEATURE.MCP)`）；bridge 只转发。改 bridge 无用 |
| 远程代码 | **通道永远不接受代码/脚本字符串**。没有 `execute_script` 类工具，永久红线 |

### 8.1 Origin 检查

bridge 收到 WS 连接时，若 `Origin` 头存在且不是 `null` / `chrome-extension://…`，
直接 `close(4003)`。这挡住「用户浏览器里某个网页尝试连本机端口」的场景。
扩展的 WS 客户端发出的 `Origin` 是 `chrome-extension://<id>`，放行。

### 8.2 token 比较

常量时间比较（长度先比，再逐字节 XOR 累积），避免时序侧信道。
token 是 32 hex 字符，比较成本可忽略。

---

## 9. 隔离边界（实现必须遵守）

### 9.1 只新增、不改语义

| 文件 | 改动性质 |
|---|---|
| `utils/mcp-protocol.ts` | **新增**。协议常量、工具名、错误码。DOM-free |
| `utils/mcp-token.ts` | **新增**。token 生成/读写/比较。纯逻辑，可单测 |
| `utils/mcp-log.ts` | **新增**。最近 50 条调用日志。纯逻辑，可单测 |
| `entrypoints/offscreen/mcp-bridge.ts` | **新增**。WS 客户端 + 图片编码 |
| `mcp-server/` | **新增**。独立的 npm 项目 |
| `entrypoints/background.ts` | 加 `mcp-request` case、`mcpCaptureTool`、`finishShot` 加可选参数 |
| `entrypoints/offscreen/main.ts` | 加一行 `setupMcpBridge()` |
| `entrypoints/content.ts` | 加 `psp-element-rect` 消息分支 |
| `entrypoints/options.{html,main.ts,style.css}` | 占位卡片改成真卡片 |
| `utils/entitlements.ts` | 加 `FEATURE.MCP` + 进 `PRO_FEATURES` |
| `tools/validate.mjs` | 加 `PRO_FEATURE_CALLSITES.MCP` + 新检查 |
| `tests/feature-copy.test.ts` | `PRO_ONLY` / `PRO_MARK` 加 `mcp` |
| `public/_locales/*/messages.json` | 新增 MCP 相关键 |
| `utils/subscription-ui.ts` | zh_CN `FALLBACK` 加 MCP |
| `CHANGELOG.md` / `package.json` / `wxt.config.ts` / `site/src/content/site.ts` | 版本号 |

### 9.2 明确不动

- `wxt.config.ts` 的 `permissions` 与 `content_security_policy`——**一个字都不改**。
- `utils/settings.ts` 的 `Settings` 接口与 `psp_settings_v1` schema——MCP 状态单独存
  `storage.local['psp_mcp_v1']`，不进 `storage.sync`。
- 现有 `doVisible` / `doFullPage` / `doRegion` / `doElement` 的**行为**——
  只加一个可选参数，默认值与现在完全一致。
- `utils/ocr.ts` / `utils/pdf.ts` / `utils/stitch.ts`——一行不改。
- `entrypoints/content.ts` 现有的任何 `psp-*` 分支。

### 9.3 三个必须解决的技术障碍

1. **`finishShot` 总会打开编辑器**（除非 `annotateAfterCapture === false`）。
   MCP 不能开标签页。→ 加可选参数 `{openEditor?: boolean}`，默认 `undefined`
   表示沿用设置。
2. **`utils/ocr.ts` 不是 DOM-free**。→ OCR 在 offscreen 执行，background 只传 id。
3. **`capture_element` 不能复用 `psp-pick-element`**（那是交互式选择器）。
   → 新增 `psp-element-rect {selector}`，content 侧 `querySelector` +
   `scrollIntoView` + `getBoundingClientRect`。

---

## 10. 与参考文档的差异

| 参考文档说法 | 本文修正 | 原因 |
|---|---|---|
| `serveStdio` 从 `@modelcontextprotocol/server` 根导出 | 从 **`@modelcontextprotocol/server/stdio`** 子路径导出 | 读 `dist/stdio.d.mts` 第 115 行确认 |
| 图片以 8 MiB 二进制块传输 | 块 4 MiB，且**先下采样到 2048 宽 + JPEG q85** | `StdioServerTransport.maxBufferSize` 默认 10 MB |
| Pro 门禁只需三步 | **四步**：还要改 `tests/feature-copy.test.ts` 的 `PRO_ONLY`/`PRO_MARK` 与三句文案（8 语言），以及 `utils/subscription-ui.ts` 的 zh_CN `FALLBACK` | 参考文档没提这个测试，它会在 `npm test` 里红 |
| 设置页占位卡片「展开成区块一 + 区块二」 | 采纳，但 v1 **不做 popup 那行连接状态** | 控制范围，popup 改动风险高于收益 |
| 端口扫描 39127–39137 | 采纳，但明确 v1 只支持单 AI 客户端 | 多实例需要端口文件，v2 再说 |

---

## 11. 失败模式与降级

| 场景 | 行为 |
|---|---|
| bridge 未启动 | 扩展重连退避，静默；`psp_status` 报告 `connected:false` |
| WS 断开时请求在途 | 该请求返回 `extension_not_connected`，不重放（截图有副作用） |
| offscreen 被销毁 | background 下次需要时重建（`hasDocument()` 检查），WS 重新连 |
| 扩展被重载 | WS 断开，bridge 侧 `close`，AI 客户端看到工具报错，下次调用重连 |
| 用户关闭 MCP 开关 | background 通知 offscreen 断开，`storage.local` 保留 token（下次开启不用重新配对） |
| token 重置 | 立即断开 + 覆盖存储；旧配置的 AI 客户端下次调用得到 `auth-fail` |
| 图片过大 | 先下采样；仍超 8 MB base64 → `capture_failed` + 建议 `maxWidth: 1024` |
| 截图超时（300s） | `capture_failed`，不消耗配额（失败在 `finishShot` 之前） |

---

## 12. 组件职责表

| 组件 | 位置 | 职责 | 测试 |
|---|---|---|---|
| 协议常量 | `utils/mcp-protocol.ts` | 工具名、错误码、版本号 | 单测（纯） |
| token | `utils/mcp-token.ts` | 生成、读写、常量时间比较 | 单测（纯） |
| 日志 | `utils/mcp-log.ts` | 环形缓冲 50 条 | 单测（纯） |
| WS 客户端 | `entrypoints/offscreen/mcp-bridge.ts` | 连接、认证、请求分发、图片编码 | 无（DOM + WS） |
| 抓取入口 | `background.ts` `mcpCaptureTool` | 分发到 `do*`，配额与锁 | 无（worker） |
| 工具实现 | `mcp-server/src/tools.ts` | MCP 工具 schema 与转发 | 单测（纯） |
| WS 服务端 | `mcp-server/src/ws.ts` | 监听、认证、请求/响应配对 | 单测（mock ws） |
| 入口 | `mcp-server/src/index.ts` | `serveStdio` + 启动顺序 | 无（进程） |
