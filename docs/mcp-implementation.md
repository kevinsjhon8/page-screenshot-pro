# MCP 访问 — 实现文档

> 架构 `docs/mcp-architecture.md`，设计 `docs/mcp-design.md`。
> 本文是**逐步落地清单**：每一步都能独立跑 `npm run check` 并保持绿。

---

## 0. 顺序总览

| 阶段 | 内容 | 可独立验收 |
|---|---|---|
| A | 纯逻辑模块 + 单测 | `npm test` |
| B | `finishShot` 可选参数 + 四个 `do*` 透传 | `npm run check` |
| C | `psp-element-rect`（content 侧） | `npm run check` |
| D | background 的 `mcpCaptureTool` + `mcp-request` | `npm run check` |
| E | offscreen 的 WS 客户端 | 手动 |
| F | `mcp-server/` bridge | `npm test`（在 `mcp-server/`） |
| G | Pro 门禁四处落点 | `npm run check` |
| H | 设置页卡片 + i18n | `npm run check` |
| I | validate 新检查 + e2e + 文档 | `npm run check` |
| J | 版本号 + CHANGELOG | `npm run check` |

**A–D 不改任何现有行为**（B 只加默认参数，C 只加消息分支，D 只加新 case）。
E–F 是全新文件。G 开始才动可见面。

---

## A. 纯逻辑模块

### A1. `utils/mcp-protocol.ts`（新增，DOM-free）

```ts
/** 协议版本。扩展与 bridge 双方比对，不等则拒绝连接并提示升级。 */
export const MCP_PROTOCOL_VERSION = 1;

export const MCP_PORT_BASE = 39127;
export const MCP_PORT_COUNT = 11;          // 39127–39137

/** WS 二进制分块大小（字节）。见架构 §4.2 的 10 MB 缓冲约束。 */
export const MCP_CHUNK_BYTES = 4 * 1024 * 1024;
/** MCP 单条消息的软上限：超过就降采样重试，而不是发出去让 transport 关连接。 */
export const MCP_MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

export const MCP_DEFAULT_MAX_WIDTH = 2048;
export const MCP_MIN_MAX_WIDTH = 320;
export const MCP_MAX_MAX_WIDTH = 4096;

/** 工具名（bridge 与扩展共用，改一处两边一起变）。 */
export const MCP_TOOLS = {
  STATUS: 'psp_status',
  VISIBLE: 'capture_visible',
  FULL_PAGE: 'capture_full_page',
  ELEMENT: 'capture_element',
  OCR: 'ocr_capture',
  HISTORY_LIST: 'history_list',
  HISTORY_GET: 'history_get',
  EXPORT_PDF: 'export_pdf',
} as const;
export type McpToolName = (typeof MCP_TOOLS)[keyof typeof MCP_TOOLS];

/** 唯一不需要 Pro 的工具。 */
export const MCP_FREE_TOOLS: readonly McpToolName[] = [MCP_TOOLS.STATUS];

export const MCP_ERROR = {
  PRO_REQUIRED: 'pro_required',
  NOT_CONNECTED: 'extension_not_connected',
  BUSY: 'busy',
  TAB_NOT_FOUND: 'tab_not_found',
  NEEDS_USER_GESTURE: 'needs_user_gesture',
  CAPTURE_FAILED: 'capture_failed',
  PAGE_NOT_SCRIPTABLE: 'page_not_scriptable',
  INVALID_PARAMS: 'invalid_params',
  INTERNAL: 'internal',
} as const;
export type McpErrorCode = (typeof MCP_ERROR)[keyof typeof MCP_ERROR];

/** 纯函数：把总字节数切成块数。0 字节也算 1 块（空图不该出现，但别返回 0）。 */
export function chunkCount(totalBytes: number, chunkBytes = MCP_CHUNK_BYTES): number;

/** 纯函数：把 maxWidth 夹到合法区间。非数字回默认值。 */
export function clampMaxWidth(v: unknown): number;
```

**为什么集中在这里**：工具名与错误码在 bridge 与扩展两侧各写一遍，是本仓库
最熟悉的「写一边、读另一边」形状。bridge 通过相对路径 `../utils/mcp-protocol.ts`
导入（它有自己的 tsconfig 与构建，用 `tsc` 直接编译两个文件即可，不引扩展的构建链）。

### A2. `utils/mcp-token.ts`（新增，DOM-free）

```ts
export const MCP_STATE_KEY = 'psp_mcp_v1';
export const MCP_LOG_KEY = 'psp_mcp_log_v1';

export interface McpState {
  enabled: boolean;
  token: string;
  createdAt: number;
  lastConnectedAt?: number;
}

export interface McpKV {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

/** 32 位十六进制。注入 random，测试不依赖真 crypto。 */
export function newToken(random?: (n: number) => Uint8Array): string;

/** 常量时间比较。长度不等直接 false（token 定长 32，泄露长度无意义）。 */
export function timingSafeEqual(a: string, b: string): boolean;

export function normalizeMcpState(raw: unknown): McpState | null;
export async function readMcpState(kv: McpKV): Promise<McpState | null>;
export async function writeMcpState(kv: McpKV, s: McpState): Promise<void>;
```

`normalizeMcpState` 逐字段校验，不是 `{...default, ...raw}`——理由与
`normalizeSettings` 完全一样：脏数据不能让 `enabled: 'yes'` 变成真。

### A3. `utils/mcp-log.ts`（新增，DOM-free）

```ts
export const MCP_LOG_MAX = 50;

export interface McpLogEntry {
  ts: number;
  tool: string;
  ok: boolean;
  code?: string;
  ms: number;
  bytes?: number;
}

export function appendLog(list: McpLogEntry[], e: McpLogEntry, max = MCP_LOG_MAX): McpLogEntry[];
export async function readLog(kv: McpKV): Promise<McpLogEntry[]>;
export async function writeLog(kv: McpKV, list: McpLogEntry[]): Promise<void>;
```

`appendLog` 返回新数组（不原地改），最新在前。**不记参数**：`selector` 可能含
敏感信息。

### A4. 单测

`tests/mcp-token.test.ts`：
- `newToken()` 长度 32、只含 `[0-9a-f]`、两次调用不同
- `timingSafeEqual` 相同 / 长度不等 / 只差一位
- `normalizeMcpState` 对 `null`、`{}`、`{enabled:'yes'}`、token 非 32 hex 的处理
- 读写往返（mock `McpKV`）

`tests/mcp-protocol.test.ts`：
- `MCP_TOOLS` 的键集合与 `MCP_FREE_TOOLS` 的包含关系
- `chunkCount(0) === 1`、`chunkCount(4MiB) === 1`、`chunkCount(4MiB+1) === 2`
- `clampMaxWidth` 对 `undefined` / `0` / `-5` / `99999` / `'800'`

`tests/mcp-log.test.ts`：
- 超过 50 条时最旧的被丢弃，长度恒为 50
- 最新在最前
- 返回的是新数组，入参未被修改

---

## B. `finishShot` 可选参数（向后兼容）

### B1. 签名

`entrypoints/background.ts`：

```ts
async function finishShot(
  stitched: StitchedResult,
  kind: string,
  tab?: Browser.tabs.Tab,
  settings?: Settings | null,
  opts?: { openEditor?: boolean; copyToClipboard?: boolean },
)
```

函数体内：

```ts
const openEditor =
  opts && typeof opts.openEditor === 'boolean'
    ? opts.openEditor
    : !(settings && settings.annotateAfterCapture === false);

const wantCopy =
  opts && typeof opts.copyToClipboard === 'boolean'
    ? opts.copyToClipboard
    : !!(settings && settings.copyToClipboard);

let clipNote = '';
if (wantCopy) { clipNote = await copyShotToClipboard(stitched.dataUrl, tab); }
```

其余（`idbPutShot` / `addHistory` / `await consumeCapture` / 返回值）**一个字不改**。

**不变量**：`await consumeCapture(...)` 必须仍在 `finishShot` 体内——
`tools/validate.mjs` 检查 8 钉着它。MCP 路径复用 `finishShot`，所以配额、
历史、IDB 全部照旧，不需要第二处记账。

### B2. 四个 `do*` 透传

```ts
async function doVisible(tab: Browser.tabs.Tab, opts?: ShotOpts) { … finishShot(…, settings, opts) }
async function doFullPage(tab: Browser.tabs.Tab, opts?: ShotOpts) { … }
async function doRegion(tab: Browser.tabs.Tab, opts?: ShotOpts) { … }
async function doElement(tab: Browser.tabs.Tab, opts?: ShotOpts) { … }
```

`type ShotOpts = { openEditor?: boolean; copyToClipboard?: boolean }`。

**默认值全是 `undefined`**，现有四处调用点（`handleMessage` 里的
`withCaptureLock(async () => doVisible(await activeTab()))`）不需要改。
行为与现在逐字节一致——这一点用 `npm test` + `npm run validate` 确认。

---

## C. `psp-element-rect`（content 侧）

### C1. 消息分支

`entrypoints/content.ts` 的监听器里，紧邻 `psp-pick-element` 加：

```ts
if (m.type === 'psp-element-rect') return elementRect(String(m.selector || ''));
```

实现放在 `pickElement` 旁边：

```ts
/**
 * 按 CSS 选择器取元素矩形（CSS 像素，与 pickElement 的返回形状一致）。
 *
 * 与 psp-pick-element 的区别：那个等用户点，这个立刻返回。
 * 失败返回 { cancelled: true, reason }，**不抛**——跨进程抛异常会丢原因。
 */
function elementRect(selector: string): Rect | { cancelled: true; reason: string } {
  if (!selector) return { cancelled: true, reason: 'empty' };
  let el: Element | null = null;
  try { el = document.querySelector(selector); }
  catch { return { cancelled: true, reason: 'bad-selector' }; }
  if (!el) return { cancelled: true, reason: 'not-found' };
  el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return { cancelled: true, reason: 'zero-size' };
  return { x: r.x, y: r.y, w: r.width, h: r.height };
}
```

`behavior: 'instant'` 是必须的：默认 `'auto'` 会跟随 `scroll-behavior: smooth`
的页面做动画滚动，`getBoundingClientRect()` 会读到动画中间的位置。

**局限（写进 MANUAL-TEST）**：元素大于视口时只能截到视口内那一部分，
`doCrop` 会把越界部分裁掉。v1 不拼接元素。

### C2. 单测

`tests/content.test.ts` 加一组「元素矩形」：命中 / 无匹配 / 非法选择器 /
零尺寸 / `scrollIntoView` 被调用一次。DOM stub 需要 `scrollIntoView`——
`tests/helpers/dom-stub.ts` 里补一个空实现（**不要**在 `content.ts` 里加
`typeof el.scrollIntoView === 'function'` 守卫，那正是 CLAUDE.md 禁止的
「用守卫让测试通过」）。

---

## D. background：`mcpCaptureTool`

### D1. 命名与两个静态检查的关系

函数**不能**叫 `doMcpCapture`——初稿这么写，实现时改了。理由：`tools/validate.mjs`
的两条静态检查都以 `do[A-Z]` 为抓取流程的判据，而这个是**分发器**不是流程：

- 检查 8 要求每个 `do*` 自己调 `requireQuota()`。照做的话这里和它调用的
  `doVisible`/`doFullPage` 会各判一次（今天无害，但"额度判两次"是个说不清的
  不变量）。
- 检查 9 要求每个 `do*` 的**调用点**被 `withCaptureLock()` 包住。照做的话锁在
  外面、`withCaptureLock` 不可重入，内层的三个分支会立刻被判 busy——功能直接坏掉。

两条同时满足只能二选一，而任何一版都会让"锁在哪里"变得含糊。所以它叫
`mcpCaptureTool`，真正的不变量交给它内部的三个 `do*` 调用点：那三个才是抓取
流程，检查 8/9 照样逐个盯着它们。

### D2. 实现

```ts
async function mcpCaptureTool(tool: string, params: Record<string, unknown>) {
  // 闸门只读地判一次：MCP 截图同样消耗免费额度，且要在拿锁之前就把
  // 「额度用完」告诉 AI（而不是让它等 300s 再报 busy）。
  await requireQuota();
  await requireFeature(FEATURE.MCP);

  // busy 单独判一次，而不是让 withCaptureLock 抛它的本地化文案：那条文案
  // 是给人看的（八种语言各一句），toMcpError 没法靠正则认出来；AI 需要的
  // 恰恰是稳定的 busy 机器码。两处判据之间有 TOCTOU 窗口，但真正阻止并发的
  // 还是 withCaptureLock，这里只负责把错误说得准。
  if (captureLock.isBusy()) throw mcpError(MCP_ERROR.BUSY, t('mcpBusy'));

  const tab = await activeTab();

  switch (tool) {
    case MCP_TOOLS.VISIBLE:
      return withCaptureLock(async () => doVisible(tab, MCP_SHOT_OPTS));
    case MCP_TOOLS.FULL_PAGE:
      return withCaptureLock(async () =>
        doFullPage(tab, { ...MCP_SHOT_OPTS, expandInfiniteScroll: /* params 里是 boolean 就透传，否则 undefined */ }));
    case MCP_TOOLS.ELEMENT: {
      const selector = String(params.selector || '');
      // 见 §K-1：`!selector` 对纯空白为假，会一路走到 querySelector 抛错。
      if (!selector.trim()) throw mcpError(MCP_ERROR.INVALID_PARAMS, t('mcpSelectorRequired'));
      return withCaptureLock(async () => doElementBySelector(tab, selector, MCP_SHOT_OPTS));
    }
    default:
      throw mcpError(MCP_ERROR.INVALID_PARAMS, t('mcpUnknownTool'));
  }
}

const MCP_SHOT_OPTS: ShotOpts = { openEditor: false, copyToClipboard: false };
```

**`expandInfiniteScroll` 是 `ShotOpts` 的第三个字段，也是唯一一个"多做一步"
而不是"别做"的字段。** 设计文档 §3.2 把它放进 `capture_full_page` 的 schema，
理由是同一页在"等无限滚动加载"与"不等"之间时长能差 18s（最多 40 轮 × 450ms），
AI 自己最清楚这一页要不要等。**默认仍然是用户的设置**：`ShotOpts` 里它是
`boolean | undefined`，`doFullPage` 按

```ts
opts?.expandInfiniteScroll !== undefined
  ? opts.expandInfiniteScroll
  : settings ? settings.expandInfiniteScroll : true
```

取，所以用户自己点截图（`opts` 是 `undefined`）时走的仍是
`settings.expandInfiniteScroll`，与改动前逐字节一致。`preloadLazyContent`
故意不做对应参数：它没有用户可见的失败模式，多一个参数只会让 schema 和文档
各多一处要同步的地方。

`doElementBySelector` 与 `doElement` 同构，只是把 `psp-pick-element` 换成
`psp-element-rect`：

```ts
async function doElementBySelector(tab: Browser.tabs.Tab, selector: string, opts?: ShotOpts) {
  checkTab(tab);
  await requireFeature(FEATURE.CAPTURE_ELEMENT);   // 元素截图本身也是 Pro
  await requireQuota();
  const fa = await ensureFileAccess(tab);
  if (!fa.ok) { /* 同 doElement */ }
  await ensureContent(tab.id!, tab.url || '');
  const rect = await sendTab<Rect | { cancelled: true; reason: string }>(
    tab.id!, { type: 'psp-element-rect', selector },
  );
  if (!rect || ('cancelled' in rect && rect.cancelled)) {
    throw mcpError(MCP_ERROR.INVALID_PARAMS, t('mcpElementNotFound'));
  }
  const settings = await captureSettings();
  const dataUrl = await captureOne(tab);
  const plan = await sendTab<PagePlan>(tab.id!, { type: 'psp-plan' });
  const dpr = (plan && plan.dpr) || 1;
  const resp = await stitchRequest<{ dataUrl: string; w: number; h: number }>({
    type: 'os-crop', dataUrl, rect, dpr,
  });
  return finishShot({ dataUrl: resp.dataUrl, w: resp.w, h: resp.h, warnings: [] },
    'element', tab, settings, opts);
}
```

**注意**：`doElementBySelector` 以 `do` 开头，所以它同样被检查 8/9 覆盖，
必须自己调 `requireQuota()`、调用点必须有 `withCaptureLock(`。已经满足。

### D3. `mcpError`

```ts
function mcpError(code: McpErrorCode, message: string) {
  const e = new Error(message) as Error & { mcpCode?: string };
  e.mcpCode = code;
  return e;
}
```

监听器的失败分支要把它带回 offscreen：

```ts
sendResponse({
  ok: false,
  error: String(err?.message || e),
  needFileAccess: !!(err && err.needFileAccess),
  paywall: !!(err && err.paywall),
  mcpCode: (err as { mcpCode?: string })?.mcpCode,
});
```

**只加字段，不改现有字段**——现有四个调用方（popup / editor / options /
feedback）读的是前四个。

### D4. `mcp-request` case 与监听器让路

`handleMessage` 的 switch 加：

```ts
case 'mcp-request':
  return mcpCaptureTool(String(msg.tool || ''), (msg.params || {}) as Record<string, unknown>);
```

监听器顶部加一条让路，紧邻 `os-*` 那条：

```ts
// 名单里的 mcp-* 是 offscreen 发给 background 的（必须处理）；
// 其余（mcp-ping / mcp-state / mcp-reload）是页面 ↔ offscreen 的
// （设置页问连接状态、offscreen 广播状态变化）。后者必须让路，否则
// background 的 {ignored:true} 会先到，盖掉 offscreen 的真正回复。
if (m.type.indexOf('mcp-') === 0 && !isMcpBgRequest(m.type)) {
  return false;
}
```

初稿只豁免了 `mcp-request`，`mcp-status` 是 D5 加进来之后才需要的——漏掉它的
表现是设置页永远显示"未连接"：background 抢答了一个空响应，offscreen 的真实
状态被 `sendMessage` 丢掉。这正是 `popup-copy-image` 那条注释记的同一个坑。
**而"两个例外"这个写法本身也没撑过验收**：5 条消息之后例外变成五个、两个方向
各写一次，于是改成了 `MCP_BG_REQUESTS` 名单（见 §E4 与 §K-2）。

### D5. 状态查询

`mcp-status` 由 offscreen 发给 background：

```ts
case 'mcp-status': {
  const lic = await getLicense(storage);
  const tab = await activeTab().catch(() => null);
  return {
    pro: lic.pro,
    plan: planOf(lic),
    activeTab: tab ? { title: tab.title, url: tab.url } : null,
    tools: Object.values(MCP_TOOLS),
  };
}
```

**没有 `connected` 字段**：初稿这里写了 `connected: true`，实现时删了——能走到
这个 case 只说明 background 活着，与 WS 通不通无关（offscreen 是发问方，它自己
才知道 WS 状态）。那个字段留在返回值里的话，`psp_status` 的实现会顺手用它，
于是"扩展连上了"永远为真，而真相是 AI 客户端那边根本没连。`psp_status` 的
`connected` 由 offscreen 自己填（能走到这里就说明 offscreen 活着、WS 通着），
`version` 取自 `browser.runtime.getManifest().version`，`mcpEnabled` 取自
offscreen 自己读到的状态。

---

## E. offscreen 的 WS 客户端

### E1. `entrypoints/offscreen/mcp-bridge.ts`（新增）

```ts
export function setupMcpBridge(): void;
export function shutdownMcpBridge(): void;   // 供 future 的「关闭开关」用
```

内部结构：

```
state: { ws | null, connected, connecting, attempts, state: McpState | null }

start():
  state = await sendBg({type:'mcp-state-get'})   // ← 不是 storage.local，见 §K-2
  if (!state?.enabled) return
  connect()

connect():
  for port in 39127..39137:
    ws = new WebSocket(`ws://127.0.0.1:${port}`)
    await open-with-timeout(400ms)
    if opened: break
  if none: scheduleRetry()
  ws.onopen  → send {type:'auth', token, protocolVersion}
  ws.onmessage → dispatch
  ws.onclose → connected=false; broadcast state; scheduleRetry()

scheduleRetry():
  attempts++; delay = Math.min(30_000, 1000 * 2 ** (attempts - 1))
  setTimeout(connect, delay)     // 静默，不 log 到 console.error
```

`attempts` 在成功连上后清零。

### E2. 请求分发

```ts
async function handleRequest(msg: { id, tool, params }) {
  const t0 = Date.now();
  try {
    switch (msg.tool) {
      case MCP_TOOLS.STATUS:      return send(await statusResult());
      case MCP_TOOLS.HISTORY_LIST:return send(await historyListResult(msg.params));
      case MCP_TOOLS.HISTORY_GET: return sendImage(await getShotBytes(msg.params));
      case MCP_TOOLS.OCR:         return send(await ocrResult(msg.params));
      case MCP_TOOLS.EXPORT_PDF:  return sendPdf(await pdfResult(msg.params));
      default:                    return sendImage(await captureResult(msg.tool, msg.params));
    }
  } catch (e) {
    send({ type: 'result', id: msg.id, ok: false, error: toMcpError(e) });
  } finally {
    void logCall(msg.tool, ok, code, Date.now() - t0, bytes);
  }
}
```

`captureResult`：

```ts
const r = await browser.runtime.sendMessage({ type: 'mcp-request', tool, params });
if (!r || !r.ok) throw Object.assign(new Error(r?.error || 'capture failed'),
  { mcpCode: r?.mcpCode });
const shot = await idbGetShot(r.result.id);      // utils/idb.ts
const img = await encodeJpeg(shot.dataUrl, clampMaxWidth(params.maxWidth));
return { id: r.result.id, w: img.w, h: img.h, bytes: img.bytes, warnings: r.result.warnings };
```

`encodeJpeg` 用 `createImageBitmap` + `<canvas>`（offscreen 有 DOM），
按 `maxWidth` 缩放后 `toBlob('image/jpeg', 0.85)` → `arrayBuffer()`。

### E3. 分块发送

```ts
async function sendImage(id: string, img: { bytes: Uint8Array; mime: string; w: number; h: number }) {
  const n = chunkCount(img.bytes.length);
  for (let i = 0; i < n; i++) {
    const part = img.bytes.subarray(i * MCP_CHUNK_BYTES, (i + 1) * MCP_CHUNK_BYTES);
    ws.send(JSON.stringify({ type: 'image', id, mime: img.mime, w: img.w, h: img.h,
                             bytes: img.bytes.length, chunkIndex: i, chunkCount: n }));
    ws.send(part);          // 二进制帧，紧随其后
  }
}
```

`ws.send(part)` 传 `Uint8Array` 会发二进制帧（浏览器 WebSocket API 的行为）。

### E4. `mcp-ping` / `mcp-state` / `mcp-status` / `mcp-reload`

四个消息，分工是"谁问谁答"决定的（`runtime.sendMessage` 会广播到所有扩展上下文，
background 若也应一声，先到的那个 response 会盖掉 offscreen 的真正回复——与
`popup-copy-image` 那条注释记的是同一个坑）：

| 消息 | 发送方 → 接收方 | 用途 |
|---|---|---|
| `mcp-ping` | 设置页 → offscreen | 连接状态（connected / enabled / attempts / token） |
| `mcp-state` | offscreen → 所有页面 | 状态变化的广播 |
| `mcp-status` | offscreen → background | Pro / plan / activeTab / 工具表 |
| `mcp-reload` | 设置页 → offscreen | 开关或 token 变了，重读状态并重连 |
| `mcp-state-get` | offscreen → background | 读 `psp_mcp_v1`（**offscreen 没有 storage**，见 §K-2） |
| `mcp-touch` | offscreen → background | 写 `lastConnectedAt` |
| `mcp-log-add` | offscreen → background | 追加一条工具调用日志 |

后三条是 2026-11-01 验收时才加的，因为它们本该在 offscreen 里直接做——而那个
上下文根本没有 `storage`。**初版那行 `const kv = browser.storage.local` 写在
模块顶层，直接把 Canvas 后端拖下水**（§K-2）。

background 的监听器让路规则因此是**名单制**，而名单只有一份：

```ts
/* utils/mcp-messages.ts */
export const MCP_BG_REQUESTS = ['mcp-request', 'mcp-status',
  'mcp-state-get', 'mcp-touch', 'mcp-log-add'];
export function isMcpBgRequest(type: unknown): boolean { … }

/* background.ts */
if (m.type.indexOf('mcp-') === 0 && !isMcpBgRequest(m.type)) return false;
/* offscreen：同一条谓词，同一个意思——"这是我发出去的，我得让路" */
if (isMcpBgRequest(m.type)) return false;
```

**不要退回到写成字面量的 `m.type !== 'mcp-request' && m.type !== 'mcp-status'`。**
两侧的规则是互补的，各写一份时加一个新消息漏改任一边都是静默的：background
漏改会抢答（offscreen 的真回复被 `sendMessage` 丢掉，设置页永远「未连接」），
offscreen 漏改会让它自己的请求无人应答（走到 `sendBg` 的超时，表现为工具调用
卡住）。所以名单进了 `utils/mcp-messages.ts`，一个 DOM-free、不 import
`browser` 的小模块——`background.ts` 直接 import 它，检查 3 的图遍历会走到。

`mcp-ping` 的回复里**带 token**：设置页要把那行 JSON 显示给用户复制。它是
`storage.local` 里同一个值，设置页本来就能直接读；走消息只是让"谁能读"集中在
一处，不是一条新的暴露面。

`mcp-state` 的广播必须 `.catch(() => {})`——没有任何接收者时 `sendMessage` 会
reject（`Could not establish connection`），与本仓库其它广播的写法一致。

### E5. `entrypoints/offscreen/main.ts`

```ts
await ensureFallbackMessages(…);
setupCanvasBackend();
setupMcpBridge();          // ← 新增，必须在 ensureFallbackMessages 之后
```

顺序理由：`mcp-bridge` 里的错误文案走 `t()`，而 offscreen 没有
`chrome.i18n`，必须等兜底表就位。与 `setupCanvasBackend()` 同一条规则
（`tools/validate.mjs` 检查 16 已经盯着前一个调用，检查 23 盯着这一个）。

### E6. 载体必须**提前**存在——三份文档都没覆盖的时间线缺口

这是实现阶段才暴露出来的：**offscreen 文档原本是按需创建的**，只有
`ensureStitchBackend()` 在拼接时才建。而 MCP 的 WS 长连接活在 offscreen 里，
「用户开了 MCP，AI 一上来就能连」要求这个文档**从 SW 一启动就在**，而不是等到
用户截了第一张图。没有这一段的话，功能完全正确、测试全绿、用户却每次都要先
手动截一张图 MCP 才连得上。

`background.ts` 里加两半，都在 SW 启动路径上：

```ts
async function ensureMcpBridgeHost(): Promise<void> {
  const offscreen = getOffscreenApi();
  if (!offscreen) return;                       // 没有 offscreen 就也没有载体
  const state = await readMcpState(storage).catch(() => null);
  if (!state) return;                           // 开关关着 → 零开销
  const has = await offscreen.hasDocument().catch(() => false);
  if (has) return;
  try {
    await createOffscreenDoc();
    await waitForReady(() => browser.runtime.sendMessage({ type: 'os-ping' }), { tries: 20, delayMs: 150 });
  } catch { /* 建不起来就是连不上，不影响截图 */ }
}

async function syncMcpHost(): Promise<void> {
  const state = await readMcpState(storage).catch(() => null);
  if (state) await ensureMcpBridgeHost();
  try { await browser.runtime.sendMessage({ type: 'mcp-reload' }); } catch { /* 无接收者 */ }
}
```

四条要点：

- **代价为零。** 只有 `readMcpState()` 非 null（用户真的打开了开关）才建文档。
  没开 MCP 的用户走的仍是原来那条路径。
- **只 ping `os-ping`，不等 WS 连上。** 模块脚本跑完 = `setupMcpBridge()` 也跑完
  了；bridge 可能压根没启动，那是正常状态（AI 客户端还没开）。
- **失败静默。** 极老的 Chromium 没有 `chrome.offscreen`，建不起来只是 MCP 连不上，
  AI 侧收到 `extension_not_connected`。不能让它影响截图，所以整段包在 try/catch 里。
- **与 `ensureStitchBackend()` 不冲突。** 那边判的是 `hasDocument()`，文档已存在就
  直接返回；Chrome 本身也只允许一个（"Only a single offscreen document may be
  created."）。先建、后拼接只是省掉一次创建。

**关闭开关时不销毁文档**：那个 offscreen 同时也是 Canvas 后端，截完图还有可能
在用；关掉它会让下一次拼接重建一次。`mcp-bridge` 收到 `mcp-reload` 后自己会
teardown + 停止重连，效果已经达成。

**为什么还要 `storage.onChanged`**：设置页已经会发 `mcp-reload`，但**那条消息在
offscreen 还不存在时会石沉大海**（`runtime.sendMessage` 没有接收者就 reject），
而打开开关恰恰是最需要"立刻建文档"的一刻。storage 事件是持久的，两条都留着：
消息负责"立刻"，监听负责"无论如何"。

**这个监听器在 `background.ts` 里，不在 offscreen 里——两边都写过一版，只有前者
能跑。** offscreen 文档没有 `browser.storage`，那个 `.onChanged.addListener(...)`
在 `setupMcpBridge()` 里会抛 `TypeError`（§K-2）。现在 `background.ts` 的监听器
读 `psp_mcp_v1` 的变化 → `syncMcpHost()`：有配置就建文档、再发一条 `mcp-reload`；
没配置就只发消息让 offscreen 自己 teardown 并停止重连。

**过滤条件必须是 `enabled`/`token` 两个字段，不能是"整个对象变了"**：
`psp_mcp_v1` 里还有 `lastConnectedAt`，而它正是 offscreen 认证成功时写进去的
——把它也当成"开关变了"就是 同步 → 通知 → 同步 的自激环（本仓库
`licenseFingerprint` 那条注释记过一模一样的坑）。

---

## F. `mcp-server/`（bridge，独立 npm 项目）

### F1. 目录

```
mcp-server/
  package.json
  tsconfig.json
  vitest.config.ts
  src/
    index.ts       入口：解析 env → 启 WS → serveStdio
    ws.ts          WebSocketServer + 认证 + 请求/响应配对
    tools.ts       八个工具的 MCP schema 与实现
    chunk.ts       图片分块重组（纯函数，可单测）
    errors.ts      错误码 → MCP isError 的映射（纯函数）
  tests/
    chunk.test.ts
    errors.test.ts
    tools.test.ts
```

### F2. `package.json`

```json
{
  "name": "page-screenshot-mcp",
  "version": "0.1.1",
  "description": "MCP bridge for Page Screenshot Pro — lets an AI client … (≥60 字符)",
  "type": "module",
  "bin": { "page-screenshot-mcp": "dist/mcp-server/src/index.js" },
  "engines": { "node": ">=20" },
  "files": ["dist", "README.md", "LICENSE"],
  "keywords": ["mcp", "model-context-protocol", "screenshot", "…"],
  "homepage": "https://screenshotpro.agentsblockchains.com/",
  "author": "Page Screenshot Pro <support@…>",
  "license": "MIT",
  "repository": { "type": "git", "url": "git+https://…", "directory": "mcp-server" },
  "bugs": { "url": "https://screenshotpro.agentsblockchains.com/support/", "email": "support@…" },
  "dependencies": {
    "@modelcontextprotocol/server": "2.4.0",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/node": "^22",
    "@types/ws": "^8",
    "typescript": "^5.6",
    "vitest": "^3"
  },
  "overrides": { "rollup": "4.64.3" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "check": "tsc -p tsconfig.test.json && vitest run"
  }
}
```

**0.1.0 发布出去之后才知道的两件事，现在都由 `tests/bin.test.ts` 钉着：**

1. **`bin` 指向的文件首行必须是 shebang。** npm 在 Unix 上只给
   `node_modules/.bin/` 建符号链接、**不补 shebang**，而 `tsc` 也不会凭空造一行。
   没有它，`npx -y page-screenshot-mcp`（设置页生成的 JSON 正是这么写的）会让
   shell 拿第一行注释去执行：
   `1: /bin: Permission denied` / `2: node_modules: not found` /
   `Syntax error: word unexpected (expecting ")")`。**而 `node dist/.../index.js`
   一切正常**——所以"进程能起来"根本不是这一层的断言，必须**直接执行 bin**。
2. **`files` 里要显式带 `README.md` 和 `LICENSE`。** 只写 `["dist"]` 时 npm
   仍会**自动**带上这两个文件，但那是 npm 的默认行为、不是契约；而缺了它们的
   包在 registry 页面上是一片空白（一行描述 + "no readme"），发布、安装、运行
   三步全绿，只有打开网页的人看得见。现在显式列出来，`tests/bin.test.ts` 断言
   两个文件真的存在、且 `description` / `keywords` / `homepage` / `repository`
   都在且不是占位符。

**`serverInfo.version` 手动跟着走。** `serveStdio` 的 factory 里那个
`{ name: 'page-screenshot', version: '0.1.1' }` 是 MCP 客户端 `initialize` 之后
能看到的东西，与 `package.json` 的版本是两份字面量，没有任何检查把它们绑在一起
——改了包版本忘了这里，客户端会一直报旧版本号。

**`@modelcontextprotocol/server` 必须精确 `2.4.0`**，不写 `^`：它的
`McpServer` / `serveStdio` 是 2.x 的 API，3.x 可能改名。同时**不要**用
维护线上的 `@modelcontextprotocol/sdk` 1.x。

三处与初稿不同，每一处都是实测撞出来的：

- **`bin` 是 `dist/mcp-server/src/index.js`，不是 `dist/index.js`。**
  `tsconfig.json` 的 `rootDir` 是 `".."`（下一段解释为什么），所以 tsc 在
  `dist/` 下保留 `mcp-server/src/` 与 `utils/` 的相对布局。写成
  `dist/index.js` 的话 `npx page-screenshot-mcp` 会报 `Cannot find module`，
  而 `npm run build` 是全绿的——发布出去才炸。
- **`rootDir: ".."` + `include` 里带 `../utils/mcp-protocol.ts`。** 工具名与
  错误码只有一份（`utils/mcp-protocol.ts`），bridge 直接编译它，不复制。
  复制就是本仓库最熟的「写一边、读另一边」形状：改了一边，另一边静默地不认。
  代价是 `rootDir` 必须上提一级，`bin` 也跟着改（上一段）。`utils/mcp-token.ts`
  同理（`timingSafeEqual` 两边必须是同一份实现，否则"常量时间"只在一侧成立）。
- **`overrides.rollup = "4.64.3"`。** rollup 4.65+ 的 `linux-x64-gnu` 原生
  二进制在这台无 AVX2 的 Celeron N5095A 上直接 `Illegal instruction
  (core dumped)`——`vitest` 起不来，报错只有一句 core dumped，不指向任何
  东西。根项目锁在 4.64.3 且能跑，这里跟齐。rollup 只经 vite→vitest 进来，
  不参与 `tsc` 构建、不进 `dist/`、不影响发布产物。

**两个 tsconfig**：`tsconfig.json` 只含 `src/**` + 协议常量（要 emit 进
`dist`）；`tsconfig.test.json` 继承它、`noEmit: true`、额外收 `tests/**`。
分成两个是因为 `npm run check` 要同时做两件事——构建的类型检查（`src` 会被
编译）和测试的类型检查（`tests` 不该进 `dist`）。合成一个的话，要么测试被
编译进发布包，要么测试里的类型错误完全没人查（vitest 只转译，不检查类型）。

### F3. `src/index.ts`

```ts
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { McpServer } from '@modelcontextprotocol/server';
import { startBridge } from './ws.js';
import { registerTools } from './tools.js';

const token = process.env.PSP_MCP_TOKEN;
if (!token || token.length !== 32) {
  process.stderr.write('page-screenshot-mcp: PSP_MCP_TOKEN missing or malformed\n');
  process.exit(1);
}

const bridge = await startBridge(token);   // 端口全部占用时这里 exit(1)

serveStdio(() => {
  const server = new McpServer({ name: 'page-screenshot', version: '0.1.1' },
                               { capabilities: { tools: {} } });
  registerTools(server, bridge);
  return server;
});
```

三条纪律：

1. **stdout 只跑协议**。`console.log` 一律不用，全部 `process.stderr.write`。
   一行 `console.log` 就能让 MCP 客户端解析失败。
2. **端口失败要快**：全部端口 `EADDRINUSE` 时写 `stderr` 后 `process.exit(1)`，
   不静默重试。**`exit(1)` 在 `index.ts` 里，不在 `startBridge` 里**：
   `startBridge` 抛 `BridgeError`，由入口收口成一次干净的退出。库函数直接
   结束进程的话，"端口全被占"这条分支任何单测都覆盖不到——而它恰恰最容易在
   用户机器上发生（另一个 AI 客户端已经开着）。
3. **不要在 factory 外建 McpServer**：`serveStdio` 的 factory 每次连接调用一次，
   把实例建在外面会让第二个连接复用第一个的注册表。

还有两条实现时补上的：

- **token 同时校验长度与字符集**（`MCP_TOKEN_LEN` 个 `[0-9a-f]`）。只校验
  长度会让一个明显写错的 token 一路走到认证失败，而用户看到的是一句
  「扩展未连接」，排查方向完全错。
- **`SIGINT`/`SIGTERM` 显式关 bridge 再 `exit(0)`。** 客户端断开后进程本该
  自己退出，但 WS 服务端还在监听，Node 会一直活着——端口不释放，下次启动
  撞上自己上一次（39127–39137 共 11 个，撞几次就没了）。

### F4. `src/ws.ts`

```ts
export type BridgeResult =
  | { kind: 'json'; value: unknown }
  | { kind: 'image'; bytes: Buffer; mime: string; w: number; h: number; note: string };

export interface Bridge {
  call(tool: string, params: unknown, timeoutMs: number): Promise<BridgeResult>;
  isConnected(): boolean;
  close(): Promise<void>;
}

export async function startBridge(token: string, opts?: StartBridgeOptions): Promise<Bridge>;
```

**`BridgeResult` 是带标签的联合，不是初稿里的 `Promise<unknown>`。** 图片与
JSON 是两种完全不同的东西（几 MB 二进制 vs 几百字节对象），`unknown` 会让
`tools.ts` 每一处都写类型守卫去猜，猜错的表现是"把 Buffer 当成对象取字段"
——一个 `undefined` 静默流到用户面前。`kind` 让 `tools.ts` 的分支是穷尽的。

**`startBridge` 多一个 `StartBridgeOptions`**（`portBase` / `portCount`），
只为让测试避开真实占用，生产调用点不传。

要点：

- 端口从 `MCP_PORT_BASE` 起试 `MCP_PORT_COUNT` 个，第一个成功即返回。
- `new WebSocketServer({ port, host: '127.0.0.1' })` —— **必须 `host`**，
  默认绑 `0.0.0.0` 会把端口暴露到局域网。
- `verifyClient` / `connection` 里查 `req.headers.origin`：存在且不以
  `chrome-extension://` 开头 → `ws.close(4003)`。
- 认证：第一条消息必须是 `{type:'auth', token}`。`timingSafeEqual` 比较，
  不等 → `close(4001)`。认证前收到任何 `request` → `close(4001)`。
- `call()` 生成 `id`（`crypto.randomUUID()`），登记 pending，`ws.send`，
  超时 reject（默认 120s，全页 300s）。
- 收到 `result` / `image` 帧按 `id` 归位；`image` 帧后紧跟的二进制帧按
  `chunkIndex` 填入该 id 的 `Buffer[]`，齐了就 resolve 成 `{bytes, mime, w, h}`。
- `ws.on('close')` → 所有 pending 立刻以 `extension_not_connected` reject
  （**不重放**：截图有副作用）。

### F5. `src/tools.ts`

用 `registerTool` 的 **StandardSchemaWithJSON** 重载（首选），而不是
`ZodRawShape`（那个已 `@deprecated`，内部只是 `z.object()` 包一层）：

```ts
const FORMAT_ONLY_SCHEMA = fromJsonSchema<{ format?: string; maxWidth?: number }>({
  type: 'object',
  properties: SHOT_PROPS,
  additionalProperties: false,
});

server.registerTool(MCP_TOOLS.VISIBLE, {
  title: 'Capture visible area',
  description: '…',
  inputSchema: FORMAT_ONLY_SCHEMA,
  annotations: { readOnlyHint: false, openWorldHint: false },
}, (args) => guard(() => shotResult(MCP_TOOLS.VISIBLE, args)));
```

**初稿写的 `inputSchema: { type: 'object', … }` 编译不过，必须用
`fromJsonSchema()` 包一层。** 裸 JSON Schema 对象满足的是**已废弃**的
`ZodRawShape` 重载（`registerTool` 在 `@modelcontextprotocol/server` 2.4.0 的
声明文件里有两个重载：一个收 `StandardSchemaWithJSON`，一个收
`ZodRawShape`）。把裸对象传进去时 tsc 会挑到后者并在类型层面报错——或者更
糟，挑中了却在运行期被当成 Zod shape 解析。`fromJsonSchema` 从包根导出，
把 draft 2020-12 的 JSON Schema 包成前者。

`imageContent` 把 `{bytes, mime, w, h}` 转成 MCP content：

```ts
{ content: [
    { type: 'image', data: bytes.toString('base64'), mimeType: mime },
    { type: 'text', text: `Captured ${w}×${h}. Saved to history.` },
  ] }
```

**`application/pdf` 走 `resource` 块，不走 `image` 块。** 扩展侧的
`sendBytes` 对 PDF 发的也是 `type:'image'` 元数据帧（它只关心分块），所以
这个分支必须**按 mime 判**，不能按工具名判——按工具名判的话，将来再加一个
"导出某种二进制"的工具就会重犯一次。塞进 image 块客户端会按图片解码，得到
乱码或一次解码失败。

**base64 长度在这里再拦一次**（`MCP_MAX_MESSAGE_BYTES`）。`StdioServerTransport`
的 `maxBufferSize` 默认 10 MB，超了它会**关掉整条连接**——用户看到的是
"所有工具都坏了"，不是"这张图太大"。扩展侧已经按同一个常量拦过一次，这里
是第二道：两端各拦一次，任何一侧的常量改动都不会让另一侧静默失守。

错误处理：`call()` 抛出的错误带 `code`，转成

```ts
{ isError: true, content: [{ type: 'text', text: `<code>: <message>\nHint: <该怎么办>` }] }
```

**不要**把错误吞成空 content——AI 需要 `code` 才能给用户正确建议
（尤其 `needs_user_gesture`）。`errors.ts` 里有一张 `HINTS` 表，给七个"需要
用户做点什么"的码各配一句可执行的建议（`internal` / `capture_failed` 没有：
前者是 bug，后者已经在 message 里说了原因）。

### F6. 单测

`chunk.test.ts`（12 例）：分块重组——顺序到达、**乱序到达**、缺块、
总长度对不上、孤立二进制帧、同一 id 元数据不自洽、`reset()` 清 `awaiting`、
重复 `chunkIndex` 覆盖、不能重复交付。重点是后四条：它们各自失败的样子都是
"AI 看到一张坏图"，没有断言一个都发现不了。

`errors.test.ts`（13 例）：已知码原样透传、未知码落到 `internal`、
七个带 Hint 的码逐个点名（漏一个不会报错，只是那类失败对 AI 变成一句没有
出路的描述）、`toBridgeError` 对 `null` / 字符串 / 无 code 的 Error 都有文案。

`tools.test.ts`（23 例）：mock `Bridge`，断言**实际发出去的 `tool` 字符串**
等于 `MCP_TOOLS.*`（不是等于字面量——两边共用常量只保证"常量改了会一起
改"，不保证调用点用的是常量）、八个工具的超时（整页 300s，其余 120s）、
参数原样转发、无参数时发 `{}` 而不是 `undefined`、图片 → `image` 块、
PDF → `resource` 块、超 8 MiB → `capture_failed` 且提示调小 `maxWidth`、
截图工具拿到 JSON 时**不编**"截图成功"、以及**八个工具都走同一个 guard**
（逐个点一遍——漏一个工具包 guard 不会报错，那一类错误会以 JSON-RPC 错误
的形式漏到客户端）。

---

## G. Pro 门禁（四处，少一处就静默）

### G1. `utils/entitlements.ts`

```ts
export const FEATURE = { …, OCR: 'ocr', MCP: 'mcp' } as const;
export const PRO_FEATURES = [ ...FREE_FEATURES, …, FEATURE.OCR, FEATURE.MCP ];
```

`FREE_FEATURES` 不动。

### G2. `tools/validate.mjs` 的 `PRO_FEATURE_CALLSITES`

```js
MCP: {
  file: 'entrypoints/background.ts',
  symbol: 'requireFeature(FEATURE.MCP)',
  why: 'MCP 通道的全部工具（psp_status 除外）',
},
```

检查 21 双向，加了不登记会红。

### G3. `tests/feature-copy.test.ts`

```ts
const PRO_ONLY = ['capture.element', 'format.pdf', 'merge_pdf', 'ocr', 'mcp'];
```

`PRO_MARK` 加 `mcp: { en:'mcp', zh_CN:'mcp', zh_TW:'mcp', ja:'mcp', ko:'mcp',
es:'mcp', fr:'mcp', de:'mcp' }`。

### G4. 三句文案 × 8 语言 + zh_CN FALLBACK

`welcomePricingBody`、`subCancelStep1`、`subCancelStep1NoDate` 三句在
`public/_locales/*/messages.json` 的八个文件里都要加 MCP 词，且
`utils/subscription-ui.ts` 的 `FALLBACK` 里那两句也要改（`subCancelStep1`
在 `FALLBACK` 第 102 行、`subCancelStep1NoDate` 在第 103 行）。

zh_CN 目标文案：

- `welcomePricingBody`：`整页截图、无限滚动、懒加载，以及编辑器里的全部编辑工具——马赛克、裁剪、矩形、文字——都免费，每天 20 次。Pro 增加 PDF 导出、合并 PDF、OCR、MCP 访问与元素截图，并且不限次数。`
- `subCancelStep1`：`取消后 Pro 会在 $DATE$ 关闭：元素截图、PDF 导出、合并 PDF、MCP 访问和 OCR 都会随之失效。`
- `subCancelStep1NoDate`：`取消后 Pro 会在这个计费周期结束时关闭：元素截图、PDF 导出、合并 PDF、MCP 访问和 OCR 都会随之失效。`

其余七种语言按同样语序插入「MCP access / MCP 存取 / MCP アクセス /
MCP 액세스 / acceso MCP / accès MCP / MCP-Zugriff」。

**这一步必须与 G1 同一个 commit**：单独改 G1 会让 `npm test` 立刻红，
单独改文案会绿但功能没落地。

---

## H. 设置页卡片

### H1. `entrypoints/options.html`

把 `#mcp-card`（第 113–123 行）替换为设计文档 §2.2 的结构。

三条继承约束逐条对照：
- `data-i18n` 只在内层 `<span>`（`<h2>` 里有徽章、连接点、状态文字）；
- 不写进 `storage.sync`；
- 不新增 manifest 权限。

### H2. `entrypoints/options/main.ts`

**实现时把纯判定抽进了 `utils/mcp-ui.ts`，页面只负责画。** 这不是洁癖：
`entrypoints/options/main.ts` 没有单测，判定写进去就等于没人测——`utils/pay-ui.ts`
的注释里记过同一次实测（欢迎页那两条 `if (!info.serverMode || ...)` 删掉之后
`settings-e2e.mjs` 全绿）。所以下面这些**全部**是 `utils/mcp-ui.ts` 里的纯函数，
配 `tests/mcp-ui.test.ts`（17 例）：

| 导出 | 作用 | 为什么必须有单测 |
|---|---|---|
| `mcpCardState({pro, enabled, connected})` | 四种状态 | `pro:false` 必须先判——订阅过期前开过 MCP 的用户存储里还留着 `enabled:true`，按连接状态二分就会显示"已连接" |
| `mcpOfflineReason({attempts, lastConnectedAt})` | `never`/`lost`/`fail` | `fail` 必须压过 `lost`，否则改过 token 的用户看到的是「退出后断开是正常的」 |
| `MCP_OFFLINE_KEY` | 三个键名 | 三种原因各有一句，且必须互不相同 |
| `mcpConfigSnippet(token)` | 配置 JSON | 只给内层那段（给整段 `mcpServers` 会覆盖用户已有的 server） |
| `fmtClock(ms)` | 本地时间串 | `lastConnectedAt` 是 `Infinity` 时返回空串——判"连过"和格式化时间必须对同一个值成立 |

页面侧 `setupMcpCard()` 调 `void renderMcpCard()`，内部：

```ts
async function renderMcpCard() {
  const info = await send<{ pro: boolean }>({ type: 'can', feature: FEATURE.MCP });
  const pro = !!(info && info.ok && info.result);
  card.classList.toggle('pro-locked', !pro);
  // 非 Pro：开关 disabled + 显示升级按钮 + 隐藏配置区
  // Pro：读 mcp-ping，按 §2.1 的四种状态渲染
}
```

- `#mcp-enabled` 的 `change`：写 `storage.local['psp_mcp_v1']`（**直接写
  `browser.storage.local`，不走 `set-settings`**——它不是用户设置），
  然后 `runtime.sendMessage({type:'mcp-reload'})` 让 offscreen 重读状态。
- `#btn-mcp-copy`：`navigator.clipboard.writeText(json)`，成功 3 秒显示
  `optionsMcpCopied`，失败显示 `optionsMcpCopyFailed`。
- `#btn-mcp-reset`：复用 `.modal` 样式做二次确认（`#mcp-reset-modal`），
  确认后生成新 token、写盘、`mcp-reload`、重渲染。
- 监听 `runtime.onMessage` 的 `mcp-state` → 重渲染状态点。
- `renderMcpCard()` 用 `mcpSeq` 序列号丢弃过期结果：`can` / `readMcpState` /
  `mcp-ping` / `readLog` 是 `Promise.all` 并发，后发先至的重画会把新状态写回旧的。

**`mcp-reload` 必须加入 background 的让路名单**（它发给 offscreen）。

### H3. `entrypoints/options/style.css`

在 `.mcp-card` 附近加：

```css
.mcp-card.pro-locked .mcp-config { display: none; }
.conn-dot { width: 7px; height: 7px; border-radius: 50%; background: #94a3b8; }
.conn-dot.on { background: #16a34a; }
.mcp-json { background: #0f172a; color: #e2e8f0; font-size: 11px; line-height: 1.5;
  padding: 10px 12px; border-radius: 6px; overflow-x: auto; white-space: pre;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.mcp-actions { display: flex; gap: 8px; margin-top: 8px; }
```

`.soon-tag` 整条删除，改用 `.pro-tag`——与编辑器工具栏那份同色（琥珀
`#f59e0b`），因为用户已经认识那个颜色等于"要付钱"。两份样式表各有一份
`.pro-tag` 定义，跨页复用只能靠复制（`psp-guide` 也是这么处理的）。

### H4. i18n

按设计文档 §8 的 19 个 `optionsMcp*` 新键 + 6 个 `mcp*` 错误键，八种语言全写
（八份资源一律 366 → 384 → 380 键，见下）。

`optionsMcpSoon` 删除，并登记到 `tools/validate-i18n.mjs` 的 `RETIRED_KEYS`：

```js
optionsMcpSoon: 'MCP 已上线（2026-11-01），占位徽章不再需要',
```

**另外四个 `mcp*` 键一个消费点都没有，实现时连同资源一起删掉、一并登记。**
设计初稿列了 `mcpNotConnected` / `mcpNeedsGesture` / `mcpTabNotCapturable` /
`mcpTimeout`，而这四种情况扩展侧根本没机会回话：连不上时没有通道，超时由桥接
进程计时，用户手势和"这个页面截不了"的说明由 `mcp-server/src/errors.ts` 的
`HINTS` 表给出（那是 AI 客户端真正读到的文本，且要按 `code` 决定"下一步该做
什么"，本来就该在 bridge 侧）。留着它们就是 `expired` / `planLabel` 那个形状：
写一边、读另一边，`t()` 对没人用的键照样返回，删它与否任何检查都不动。

```js
mcpNotConnected: '文案改由 mcp-server/src/errors.ts 的 HINTS 提供（扩展侧无通道可回）',
mcpNeedsGesture: '文案改由 mcp-server/src/errors.ts 的 HINTS 提供',
mcpTabNotCapturable: '文案改由 mcp-server/src/errors.ts 的 HINTS 提供',
mcpTimeout: '超时由桥接进程计时并出文案，扩展侧不产生这条',
```

`optionsMcpBody` 的静态回退（`options.html` 里那段英文）必须与 `en` 资源
**逐字相等**——`validate-i18n` 直接比较两者。

### H5. e2e 步骤 12e-2b 重写

旧断言里的 `disabled === true` / `soon === optionsMcpSoon` 现在**是错的**，
必须整段替换。新断言（顺序即执行顺序）：

1. 卡片存在、在 `.actions` 之前、宽 ≥ 200 高 ≥ 40（保留）；
2. 标题跟随已选语言（保留）；
3. **免费用户**：`#mcp-enabled.disabled === true`，可见升级按钮，
   `#mcp-config` 的计算高度为 0；
4. **Pro 用户**（复用步骤 10 的 SW 内 `/api/license` stub，返回 lifetime）：
   `#mcp-enabled.disabled === false`；
5. 点开关 → 读 `chrome.storage.local['psp_mcp_v1']` 存在且
   `enabled === true`、`token` 匹配 `/^[0-9a-f]{32}$/`；
6. 同一次读 `chrome.storage.sync['psp_settings_v1']`，断言**没有** `mcp` 字段
   （保留旧断言的精神）；
7. 配置区可见，`#mcp-json` 文本包含该 token；
8. 点「重置 token」→ 确认 → token 变化且仍是 32 hex。

第 3 条与第 4 条方向相反，是这条测试有分辨力的地方：只测 Pro 分支会放过
「永远可点」，只测免费分支会放过「永远灰」。

### H6. `MANUAL-TEST.md` §6g 重写

改成：真实 AI 客户端（Claude Desktop）配置 → 工具列表出现 → 各工具调一遍 →
`needs_user_gesture` 的复现步骤（导航到新页面后立刻调用）。

### H7. `README.md` 第 134 行

从「下一版目标」改成「已支持」，并指向三份 `docs/mcp-*.md`。

---

## I. validate 新检查

在 `tools/validate.mjs` 末尾追加：

### 检查 22：零权限、零 CSP 扩张

⚠️ **本节的伪代码有一个已经踩过的坑，实现时改了。** 最初的写法
`(cfg.match(/permissions:\s*\[([\s\S]*?)\]/) || ['',''])[1]` 会按源码顺序命中
`wxt.config.ts` 第 40 行那个**真正的** `permissions: [...]`，于是往
`host_permissions` 里加 `<all_urls>` 检查看不见——而那恰恰是 MV3 里唯一能写出
通配 host 权限的位置（Chrome 不接受 `permissions` 里的 host 模式）。变异实测：
加了 `<all_urls>` 之后校验仍然全绿。修法是两个数组分开取，并且取
`permissions` 时用 `(?:^|[^\w])` 前缀防住 `host_permissions` 这个子串
（`_` 属于 `\w`）；另外 `host_permissions` 必须真的取到，取不到就报错——
否则扫的是空字符串，整条检查静默通过。

```js
const cfg = declLines(config || '');            // declLines，不是 stripComments（见检查 12 的注释）
const arrAfter = (name) => {
  const m = new RegExp('(?:^|[^\\w])' + name + '\\s*:\\s*\\[([\\s\\S]*?)\\]').exec(cfg);
  return m ? m[1] : '';
};
const perms = arrAfter('permissions');
const hosts = arrAfter('host_permissions');
for (const [where, body] of [['permissions', perms], ['host_permissions', hosts]]) {
  if (/<all_urls>|\*:\/\/\*|https?:\/\/\*/.test(body)) {
    errors.push(`wxt.config.ts 的 ${where} 里出现了通配 host 权限：MCP 的前提是零新增权限`);
  }
}
if (!hosts) errors.push('读不到 host_permissions 数组 —— 通配权限判定扫的是空串，等于没查');
const csp = /extension_pages\s*:\s*(.+)$/m.exec(cfg)?.[1] ?? '';
if (/connect-src/.test(csp)) {
  errors.push('extension_pages 的 CSP 里出现了 connect-src：本机 WebSocket 不需要它');
}
```

### 检查 23：MCP 调用点存在（entry 文件没有单测）

```js
// entrypoints/offscreen/main.ts 与 background.ts 都没有单测。
// 删掉 setupMcpBridge() 或 requireFeature(FEATURE.MCP) 之后，全部单测仍然绿。
const offscreenMain = stripComments(read('entrypoints/offscreen/main.ts'));
if (!/setupMcpBridge\s*\(/.test(offscreenMain)) {
  errors.push('offscreen/main.ts 没有调用 setupMcpBridge()：MCP 通道永远不会启动');
}
const bg = stripComments(read('entrypoints/background.ts'));
if (!/requireFeature\s*\(\s*FEATURE\.MCP\s*\)/.test(bg)) {
  errors.push('background.ts 没有 requireFeature(FEATURE.MCP)：MCP 对免费用户完全开放');
}
if (!/id\.indexOf\('mcp-'\)\s*===\s*0/.test(bg)) {
  errors.push('background.ts 的监听器没有给 mcp-ping / mcp-state / mcp-reload 让路：' +
    'background 的 {ignored:true} 会先到，盖掉 offscreen 的回复');
}
```

**必须 `stripComments()` 先**：本仓库被「检查被自己的注释骗过」坑过三次
（检查 5、15、16）。

### 检查 24：bridge 依赖版本钉死

```js
const pkg = JSON.parse(read('mcp-server/package.json'));
const dep = pkg.dependencies?.['@modelcontextprotocol/server'];
if (dep !== '2.4.0') {
  errors.push(`mcp-server/package.json 的 @modelcontextprotocol/server 必须是精确 "2.4.0"，` +
    `实际是 ${JSON.stringify(dep)}：2.x 的 serveStdio 是子路径导出，^ 升级到 3.x 会静默改 API`);
}
```

### 检查 25：Canvas 后端入口的 import 图不得碰 storage

完整原因见 §K-2（这是实测出来的隔离缺陷，不是预防）。核心两行：

```js
const STORAGE_RE = /\b(?:browser|chrome)\s*\.\s*storage\b/;
for (const entry of [offscreen/main.ts, stitch/main.ts])
  for (const file of collectWorkerModules(entry))       // 复用检查 3 的图遍历
    if (STORAGE_RE.test(stripComments(read(file)))) errors.push(`${file}:${line} …`);
```

三条实现要点，每条都有对应的错误做法：

- **复用 `collectWorkerModules(entry)`**（检查 3 已经写好的那个），不要新写一套
  正则遍历。它按 import 图走，相对路径与 `@/` 别名都解析。
- **扫描前 `stripComments()`**。本仓库被"检查被自己的注释骗过"坑过三次
  （检查 5、15、16），而解释这条缺陷的注释里必然会写出 `browser.storage`。
- **入口文件不存在必须报错，不能静默跳过**。锚点没了等于整条检查不存在，而
  `continue` 之后它看起来仍然是绿的。

变异验证两个方向都跑过：往 `mcp-bridge.ts` 追加一行 `browser.storage.local`
→ 红（报 `entrypoints/offscreen/mcp-bridge.ts:662`）；往**深层**的
`utils/i18n.ts` 追加一行 `chrome.storage.local` → 也红（而且同时被检查 3 判到，
因为它从 background 也可达）。第二条是这条检查"确实是图"的证据——只扫
`entrypoints/offscreen/` 的实现会漏掉它。

---

## J. 版本与 CHANGELOG

`PRO_FEATURES` 变了，按 CLAUDE.md 的规则**必须有 CHANGELOG 条目**。

四处版本同步 `0.1.4` → `0.1.5`：

| 文件 | 位置 |
|---|---|
| `package.json` | `"version"` |
| `wxt.config.ts` | `manifest.version` |
| `site/src/content/site.ts` | `SOFTWARE_VERSION` |
| `CHANGELOG.md` | 把 `## [未发布]` 改成 `## [0.1.5] — 2026-11-01` |

`CHANGELOG.md` 条目（用户向，不是开发日志）：

```md
## [0.1.5] — 2026-11-01

### 新增

- **AI / MCP 访问（Pro）**：Claude Desktop、Cursor、Claude Code 等支持 MCP 的
  AI 工具，现在可以通过本扩展截图。八个工具：查看连接状态、截可见区、截整页、
  按选择器截元素、OCR 识别、查看历史、取回历史图片、导出 PDF。
  所有图片都在你自己的机器上流转，不上传任何服务器。
  配置在设置页的「AI / MCP 访问」卡片里，复制一段 JSON 粘到 AI 客户端的配置中即可。
  免费用户可以使用 `psp_status` 检查连接状态，其余工具需要 Pro。
```

同时 `site/src/content/site.ts` 若把 Pro 功能列表写成文案（不在本文范围内，
实现时检查），要一并加 MCP。

---

## K. 验收清单

```bash
npm run check                    # typecheck + validate + 922 单测（2026-11-01 实测）
npm --prefix mcp-server run check # bridge 的 tsc + vitest（3 suites / 48 cases）
npm run build                    # 确认 .output/chrome-mv3/ 里没有新增权限
node scripts/settings-e2e.mjs ~/.local/bin/chrome-for-testing
```

**已跑过的（2026-11-01，本机）**：

| 命令 | 结果 |
|---|---|
| `npm run check` | 校验通过（0 警告）+ 36 suites / 922 cases 全绿 |
| `npm --prefix mcp-server run check` | 3 suites / 48 cases 全绿 |
| `npm run build` | 45.51 MB；`.output/chrome-mv3/manifest.json` 的 `permissions`（12 项）与 `host_permissions`（2 项）与加 MCP 之前逐字相同，CSP 里没有 `connect-src`，`version` 为 `0.1.5` |
| `npm --prefix mcp-server run build` | 产出 `dist/mcp-server/src/index.js`（`bin` 指的就是它） |

**没跑过的**：`node scripts/settings-e2e.mjs`。本机的 Chrome for Testing 必须带
`--no-sandbox` 才能起，而这个脚本不接受该参数，所以 e2e **只能由用户跑**。
它在 12e-2b 里新增的断言（免费用户的开关置灰、Pro 用户的复制/重置、重置弹窗
默认焦点在「保留」、`storage.sync` 里没有 mcp 字段）目前**一次都没有在真浏览器
里执行过**——这是本次交付唯一的未验证面，写在这里而不是假装绿了。

**手动**（本机没有免 `--no-sandbox` 的 Chrome，必须由用户跑，见
`MANUAL-TEST.md` §6g）：

1. 装扩展 → 设置页 → 启用 MCP → 复制 JSON
2. 粘进 `claude_desktop_config.json` → 重启 Claude Desktop
3. 让 AI 调 `psp_status` → 返回 `connected:true, pro:true`
4. 让 AI 调 `capture_visible` → 拿到图
5. 导航到新页面后立刻调 → 拿到 `needs_user_gesture` 与正确指引
6. 点扩展图标 → 重试 → 成功
7. 停用 Pro（临时改 license）→ 调 `capture_visible` → `pro_required`
8. 同时开两个 AI 客户端 → 第二个的工具报错（v1 已知限制）

### K-1. 验收期实测出的两个错误文案缺陷（已修）

这一段留在文档里，因为**两个都只有把桥接进程真跑起来才看得见**——`npm run check`
全绿，八份资源键集合相等，`validate` 也不动。

**① `capture_element` 那句 `mcpSelectorRequired` 的可达面比设计以为的窄。**
设计 §8 的表把它列成"用户会看到的正常路径"，MANUAL-TEST 6g-3 更写成"不给
`selector` → 文案里有 `#main .title` 这种示例"。实测（`tools/call` 四种坏参数）：

| 参数 | 实际文案 | 谁给的 |
|---|---|---|
| 完全没有 `selector` | `data must have required property 'selector'` | **SDK 的 ajv** |
| `selector: ''` | `data/selector must NOT have fewer than 1 characters` | **SDK 的 ajv** |
| `selector: 123` | `data/selector must be string` | **SDK 的 ajv** |
| `selector: '   '` | 扩展那句 `capture_element needs a CSS selector…` | 扩展 |

前三种是 MCP SDK 按 inputSchema 在校验层的拒绝，英文原文、不走 `t()`、也不在
那六个键里。**真正能穿到扩展的只有纯空白**，而当时的判断是 `if (!selector)`——
`'   '` 是真值，所以它一路走到 content 的 `querySelector('   ')`，抛
SyntaxError 被归成 `bad-selector`，最后报「没有元素匹配这个选择器」，答非所问。
修法是把判断改成 `if (!selector.trim())`：不改变正常路径，只让它真的拦住
它要描述的那种输入。

**没有删 `mcpSelectorRequired`**：空白选择器是真实可达的，删掉它那句就会退化成
`mcpElementNotFound`（同样答非所问）。设计文档 §8 已补一段说明"哪几种参数
由 SDK 先答"，MANUAL-TEST 6g-3 也改成了三条分方向的预期。

**② `getShot()` 缺 id 时抄了选择器那句。** `entrypoints/offscreen/mcp-bridge.ts`
的 `getShot(id)` 在 `!id` 时抛的是 `t('mcpSelectorRequired')`——"capture_element
需要 CSS 选择器"。这跟 `history_get` / `export_pdf` 的截图 id 毫无关系，是
复制粘贴抄错的：两个函数都得判空、都调 `mcpErr`、都写在一屏之内。改成既有的
`editorMissingShotId`（「缺少截图 ID，请从插件弹窗重新截图」，八份资源都有），
既不多一个键，也不用新文案。

### K-2. 验收期实测出的隔离缺陷：offscreen 碰了 `browser.storage`（已修）

这一条比 K-1 严重得多，因为它**不是 MCP 功能坏了，是别人的功能坏了**——正好
撞在需求原话「注意不要影响现有功能，做好隔离」的反面。

用户自己跑 `node scripts/settings-e2e.mjs ~/.local/bin/chrome-for-testing`，
第一行红是：

```
❌ 设置链路端到端失败: os-ping 无响应：offscreen 文档未注册监听（Canvas 后端不可用）
```

`os-ping` 是 Canvas 后端的握手，和 MCP 无关。原因：`mcp-bridge.ts` 在模块顶层写了

```ts
const kv = browser.storage.local as unknown as McpKV;
```

offscreen 文档里的 `chrome` 全局被 Chrome 裁过（实测 `Object.keys(chrome)` 只有
`['csi','loadTimes','runtime']`，`i18n` 与 `storage` 都没有），所以这行是
`undefined.local` → `TypeError`，而且抛在**求值阶段**。`entrypoints/offscreen/main.ts`
的调用顺序是 `setupCanvasBackend()` → `setupMcpBridge()`，但模块求值失败意味着
那个 import 进来的文件整个没成立，`setupCanvasBackend()` 于是**一行都没跑到**：
没开 MCP 的人失去了拼接能力。

`npm run check` 当时全绿。三层都看不见它：`tsc` 认为类型对（`@wxt-dev/browser`
的解析器因为 `browser.runtime.id` 为真而选中被裁的对象）；`tools/validate.mjs`
检查 3 只从 `background.ts` 出发，而 background 有完整 storage；offscreen 的
import 图没有任何单测。

**修法：offscreen 一律不碰存储，读写都经 background 中转。**

| 位置 | 改动 |
|---|---|
| `utils/mcp-messages.ts`（新） | `MCP_BG_REQUESTS` + `isMcpBgRequest()`，两侧规则互补而非各抄一份 |
| `background.ts` | 新增 `mcp-state-get` / `mcp-touch` / `mcp-log-add` 三个薄包装；让路判断改成 `indexOf('mcp-') === 0 && !isMcpBgRequest(type)` |
| `mcp-bridge.ts` | 删掉模块顶层的 `kv`；`reload()` 改问 background；`onFrame` 的 "记连接时间" 与 `handleRequest` 的日志改成两条消息；**删掉 `storage.onChanged` 订阅**（那个上下文里根本装不上） |
| `tools/validate.mjs` | 新增检查 25：从两个 Canvas 入口走 import 图，任何可达模块出现 `browser.storage` / `chrome.storage` 就红 |

两个设计判断值得记下来：

- **`reload()` 读失败一律当成"没有配置"**，不保留上一次的状态。连不上
  background（SW 正在回收）时把旧状态继续当成有效，会让用户关掉的开关继续重连。
- **检查 25 必须是图，不能扫目录**。可达模块分布在 `utils/` 里，而同目录的
  `mcp-token.ts` / `mcp-log.ts` / `settings.ts` / `license.ts` 本来就该碰 storage
  ——它们在 background 那一侧。按目录排除会随下一次搬迁漂移，跟检查 3 用
  import 图而不是白名单是同一个理由。

**e2e 顺带暴露的第二个缺陷（更小，但在脚本里）：** 重置 token 那一步先在存储里
看到新值就 `break` 跳出轮询，而 `renderMcpCard()` 把新 token 写进 `#mcp-json`
发生在后，于是断言读到的是同一帧的旧 JSON，报「重置后界面上的配置 JSON 还是旧
token」。改成等**终态**（存储换了 **且** 界面也画出来了），与 12e 那个徽标
"探得太早"是同一个坑，注释已写在脚本里。

---

## L. 变异验证清单

每条都要真的改一次、确认红了、再改回来。

| 变异 | 应该红的 |
|---|---|
| `PRO_FEATURES` 去掉 `FEATURE.MCP` | `validate` 检查 21（登记了但键没了） |
| `PRO_FEATURE_CALLSITES` 去掉 `MCP` | `validate` 检查 21（键在但没登记） |
| 删 `mcpCaptureTool` 里的 `requireFeature(FEATURE.MCP)` | `validate` 检查 21 + 23 |
| 删 `mcpCaptureTool` 里的 `requireQuota()` | `validate` 检查 8 |
| 把 `withCaptureLock(async () => doVisible(...))` 改成直接调 | `validate` 检查 9 |
| `finishShot` 里 `await consumeCapture` 改成不 await | `validate` 检查 8 |
| 删 `offscreen/main.ts` 的 `setupMcpBridge()` | `validate` 检查 23 |
| 删监听器的 `mcp-` 让路 | `validate` 检查 23 |
| **`host_permissions` 加 `<all_urls>`** | `validate` 检查 22（⚠️ 修过，见下） |
| `permissions` 加 `<all_urls>` | `validate` 检查 22 |
| CSP 加 `connect-src` | `validate` 检查 22 |
| `mcp-server/package.json` 的依赖改成 `^2.4.0` | `validate` 检查 24 |
| `PRO_ONLY` 加 `'mcp'` 但某语言文案没加 MCP 词 | `tests/feature-copy.test.ts` |
| `FALLBACK` 里的 `subCancelStep1` 没改 | `tests/feature-copy.test.ts` 第 4 个 describe |
| `timingSafeEqual` 改成 `a === b` | `tests/mcp-token.test.ts`（长度不同的用例应仍通过，逐字节用例红） |
| `appendLog` 改成 `list.unshift(e); return list` | `tests/mcp-log.test.ts`（原地修改用例） |
| `chunkCount(0)` 改成返回 0 | `tests/mcp-protocol.test.ts`（两条一起红：0 与负数/NaN） |
| `getShot()` 里 `editorMissingShotId` 抄回 `mcpSelectorRequired` | `tests/mcp-messages.test.ts`（两条红：函数体 + 全文件） |
| `!selector.trim()` 改回 `!selector` | `tests/mcp-messages.test.ts`（trim 用例） |
| `newToken` 改成 `Math.random()` | `tests/mcp-token.test.ts`（正则用例） |
| e2e 12e-2b 第 3 条（免费用户开关灰）改成恒真 | 手动把卡片改成永远可点，e2e 应红 |

### 实测结果（2026-11-01，除 e2e 那两条外全部跑过）

上表前 13 条在本机用"改一次 → 跑 → 改回来"的脚本实测，**M4 一开始是绿的**，
这就是检查 22 的那个缺陷：`/permissions\s*:\s*\[/` 按源码顺序先命中真正的
`permissions` 数组，`host_permissions` 从来没被扫过。修完再跑变红。
其余 12 条一次命中。`chunkCount(0)` 那条实测会同时红两条（0 与负数/NaN 分组
放在同一个 describe 里），已在上表注明。

最后两行是 §K-1 那两个文案缺陷补的回归条目，`tests/mcp-messages.test.ts` 是
随修复一起加的（`background.ts` 与 `entrypoints/offscreen/` 都没有单测，
而键集合比较看不见"引用了一个语义对不上的键"）。两条都实测过：把 `getShot`
抄回 `mcpSelectorRequired`、把 `trim()` 去掉，各自红的是不同的用例。

---

## M. 已知限制（写进 README / MANUAL-TEST）

1. **v1 只支持一个 AI 客户端**：第二个 bridge 会落到 39128，扩展只连第一个。
2. **`needs_user_gesture` 无法根除**：浏览器要求截图前有用户手势，这是
   `activeTab` 的设计。缓解见架构 §7.2。
3. **元素截图不拼接**：元素大于视口时只截视口内那部分。
4. **`capture_url` 未实现**：v2 候选，需要后台标签页与额外权限评估。
5. **bridge 未发布 npm**：v1 用本地路径验证，发布前重新确认包名。
