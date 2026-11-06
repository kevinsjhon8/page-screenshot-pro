/* utils/mcp-protocol.ts —— MCP 通道的协议常量（DOM-free）
 *
 * 为什么单独一个文件：工具名与错误码在**两个 npm 项目**里各用一次——
 * 扩展侧（`background.ts` 的 `doMcpCapture` 按 tool 分发）与 bridge
 * （`mcp-server/` 的 `registerTool`）。两边各写一份就是这个仓库最熟的
 * 「写一边、读另一边」形状：改了一边，另一边静默地不认。
 *
 * 所以这里是唯一真相源：bridge 的 tsconfig 用 `rootDir: '..'` 把它一起编译
 * （见 `mcp-server/tsconfig.json`），不复制。
 *
 * **必须保持 DOM-free**：`tools/validate.mjs` 检查 3 会从 `background.ts`
 * 顺着 import 图走到这里，出现 `document`/`window`/`new Image()`/`navigator`
 * 就红。
 */

/**
 * 协议版本。握手时双方比对，不等就拒绝连接。
 *
 * 什么时候加：任何**不兼容**的信封/帧格式改动。加一个工具、加一个错误码
 * 都不算（双方都是"未知就报 invalid_params"），不算就别加——版本号一动，
 * 已经装好的旧 bridge 就连不上了。
 */
export const MCP_PROTOCOL_VERSION = 1;

/** bridge 监听端口的起点；扩展按同样顺序扫。 */
export const MCP_PORT_BASE = 39127;
/** 端口数量：39127–39137。11 个够开若干实例，又不会撞上常见服务。 */
export const MCP_PORT_COUNT = 11;

/**
 * WebSocket 二进制分块大小。
 *
 * 为什么要分块：`StdioServerTransport` 的 `maxBufferSize` 默认 **10 MB**，
 * 单条 MCP 消息超过它，transport 会 `emit('error')` 并**关闭整条连接**。
 * 一张长截图 base64 后轻松超过，所以图片先下采样 + JPEG，再分块过 WS。
 * 4 MiB 让单块 base64（≈5.6 MB）稳稳落在 10 MB 以内。
 */
export const MCP_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * 组装后 base64 的软上限。超过就报 `capture_failed` 并建议调小 maxWidth，
 * 而不是把消息发出去让 transport 关连接——那会连累同一连接上的后续请求。
 */
export const MCP_MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

/** 图片最大宽度：默认 2048，夹在 [320, 4096]。 */
export const MCP_DEFAULT_MAX_WIDTH = 2048;
export const MCP_MIN_MAX_WIDTH = 320;
export const MCP_MAX_MAX_WIDTH = 4096;

/**
 * 工具名。**这是 MCP 对外暴露的名字**，改它等于改 API：已经写进用户
 * `claude_desktop_config.json` 之外的地方不会跟着变，AI 客户端缓存过的
 * 工具列表也会对不上。加工具可以，改名要慎重。
 */
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

/**
 * 唯一不需要 Pro 的工具。
 *
 * 为什么给它免费：它是**诊断**工具。非 Pro 用户调它拿到 `pro:false` 与
 * 「哪些工具需要 Pro」，这是升级路径的一部分，不是功能泄露。反过来，
 * 如果它也要 Pro，一个刚配好还没付费的用户只会看到一句
 * 「pro_required」，既不知道连没连上，也不知道自己缺什么。
 */
export const MCP_FREE_TOOLS: readonly McpToolName[] = [MCP_TOOLS.STATUS];

/**
 * 错误码。bridge 拿它决定 MCP 层的 `isError` 与给 AI 的提示，
 * 扩展侧拿它决定给人看的本地化文案。**两个都要**：AI 需要稳定的机器码，
 * 用户需要人话。
 *
 * `needs_user_gesture` 是这一整套里最要紧的一个——见架构文档 §7。
 */
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

const TOOL_SET: ReadonlySet<string> = new Set(Object.values(MCP_TOOLS));

/** 运行时校验：bridge 收到 `tools/call` 的 name 时先过一遍。 */
export function isMcpTool(v: unknown): v is McpToolName {
  return typeof v === 'string' && TOOL_SET.has(v);
}

/** 这个工具是否需要 Pro。 */
export function toolNeedsPro(name: string): boolean {
  return !MCP_FREE_TOOLS.includes(name as McpToolName);
}

/**
 * 把总字节数切成块数。
 *
 * 0 字节返回 **1** 而不是 0：空图不该出现，但如果真出现，块数 0 会让
 * 接收端永远等不齐（`received.length === chunkCount` 永不成立），
 * 变成一个挂到超时为止的请求。返回 1 至少让它立刻以一个空块完成。
 */
export function chunkCount(totalBytes: number, chunkBytes = MCP_CHUNK_BYTES): number {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return 1;
  const per = Number.isFinite(chunkBytes) && chunkBytes > 0 ? chunkBytes : MCP_CHUNK_BYTES;
  return Math.max(1, Math.ceil(totalBytes / per));
}

/**
 * 夹住 `maxWidth`。
 *
 * **只接受真正的 number**，字符串 `'800'` 一律回默认值：MCP 的 inputSchema
 * 已经声明 `type: 'number'`，客户端送字符串说明它没按 schema 来。多写一条
 * 字符串解析路径就是第二个真相源，而且 `parseInt('800px')` 这种会静默成功。
 */
export function clampMaxWidth(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return MCP_DEFAULT_MAX_WIDTH;
  return Math.min(MCP_MAX_MAX_WIDTH, Math.max(MCP_MIN_MAX_WIDTH, Math.round(v)));
}
