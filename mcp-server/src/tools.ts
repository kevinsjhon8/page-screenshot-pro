/* mcp-server/src/tools.ts —— 八个工具的 MCP schema 与实现
 *
 * 工具名、错误码全部来自 `utils/mcp-protocol.ts`（与扩展共用同一个文件），
 * 这里**不写字符串字面量**：`MCP_TOOLS.VISIBLE` 而不是 `'capture_visible'`。
 * 两边共用常量是一回事，调用点也用常量是另一回事——后者才是"改名时一定会
 * 一起改"的保证。
 *
 * schema 用 `fromJsonSchema()` 包一层，不是直接给 `{type:'object', …}`：
 * 首选重载要的是 `StandardSchemaWithJSON`，裸 JSON Schema 对象满足的是
 * **已废弃**的 ZodRawShape 重载，会在类型层面挑一个不该用的分支
 * （docs/mcp-implementation.md §F5 的修正）。
 *
 * 返回内容的分工：
 *   - 截图类 → `image` 块 + 一句 `text`（尺寸、历史 id、质量警告）
 *   - `export_pdf` → **`resource` 块**，不是 image：`mimeType: application/pdf`
 *     塞进 image 块，客户端会按图片去解码，得到的是乱码或一次解码失败。
 *     扩展侧的 `sendBytes` 对 PDF 发的也是 `type:'image'` 元数据帧（它只
 *     关心分块），所以这个分支必须**按 mime 判**，不能按工具名判——
 *     按工具名判的话，将来再加一个"导出某种二进制"的工具就会重犯一次。
 *   - `ocr_capture` / `history_list` / `psp_status` → 纯文本
 */

import { McpServer, fromJsonSchema, type CallToolResult } from '@modelcontextprotocol/server';
import {
  MCP_ERROR,
  MCP_MAX_MESSAGE_BYTES,
  MCP_TOOLS,
  MCP_DEFAULT_MAX_WIDTH,
  MCP_MAX_MAX_WIDTH,
  MCP_MIN_MAX_WIDTH,
  type McpToolName,
} from '../../utils/mcp-protocol.js';
import { BridgeError, errorResult, toBridgeError } from './errors.js';
import type { Bridge, BridgeResult } from './ws.js';

/** 普通工具的超时。够一次可见区截图 + 编码 + 分块传输。 */
const CALL_TIMEOUT_MS = 120_000;
/** 整页截图：`MAX_SEGMENTS` 40 行、每行可能多列，300s 是余量而不是目标。 */
const FULL_PAGE_TIMEOUT_MS = 300_000;

/** 截图类工具共用的三个参数。 */
const SHOT_PROPS = {
  format: {
    type: 'string',
    enum: ['jpeg', 'png'],
    description: 'Image format. jpeg (default) is much smaller; png is lossless.',
  },
  maxWidth: {
    type: 'number',
    minimum: MCP_MIN_MAX_WIDTH,
    maximum: MCP_MAX_MAX_WIDTH,
    description: `Downscale so the image is at most this many pixels wide (default ${MCP_DEFAULT_MAX_WIDTH}). Text stays legible; only width is capped, never height.`,
  },
} as const;

const FORMAT_ONLY_SCHEMA = fromJsonSchema<{ format?: string; maxWidth?: number }>({
  type: 'object',
  properties: SHOT_PROPS,
  additionalProperties: false,
});

const FULL_PAGE_SCHEMA = fromJsonSchema<{
  format?: string;
  maxWidth?: number;
  expandInfiniteScroll?: boolean;
}>({
  type: 'object',
  properties: {
    ...SHOT_PROPS,
    expandInfiniteScroll: {
      type: 'boolean',
      description:
        'Scroll the page first to trigger infinite-scroll loading. Omit to use the extension’s own setting.',
    },
  },
  additionalProperties: false,
});

const ELEMENT_SCHEMA = fromJsonSchema<{ selector: string; format?: string; maxWidth?: number }>({
  type: 'object',
  properties: {
    selector: {
      type: 'string',
      minLength: 1,
      description: 'CSS selector for the element to capture, e.g. "#main .title". The first match is used.',
    },
    ...SHOT_PROPS,
  },
  required: ['selector'],
  additionalProperties: false,
});

const OCR_SCHEMA = fromJsonSchema<{ selector?: string }>({
  type: 'object',
  properties: {
    selector: {
      type: 'string',
      description:
        'CSS selector of the element to read. Omit to read the visible area of the current tab.',
    },
  },
  additionalProperties: false,
});

const HISTORY_LIST_SCHEMA = fromJsonSchema<{ limit?: number }>({
  type: 'object',
  properties: {
    limit: {
      type: 'number',
      minimum: 1,
      maximum: 30,
      description: 'How many entries to return, newest first (default 20, max 30).',
    },
  },
  additionalProperties: false,
});

const HISTORY_GET_SCHEMA = fromJsonSchema<{ id: string; format?: string; maxWidth?: number }>({
  type: 'object',
  properties: {
    id: {
      type: 'string',
      minLength: 1,
      description: 'Screenshot id from history_list or from a previous capture’s note.',
    },
    ...SHOT_PROPS,
  },
  required: ['id'],
  additionalProperties: false,
});

const EXPORT_PDF_SCHEMA = fromJsonSchema<{ id: string }>({
  type: 'object',
  properties: {
    id: {
      type: 'string',
      minLength: 1,
      description: 'Screenshot id from history_list or from a previous capture’s note.',
    },
  },
  required: ['id'],
  additionalProperties: false,
});

/** 一次调用要用多久。整页最慢，其余同价。 */
function timeoutFor(tool: McpToolName): number {
  return tool === MCP_TOOLS.FULL_PAGE ? FULL_PAGE_TIMEOUT_MS : CALL_TIMEOUT_MS;
}

/**
 * 图片 → MCP content。
 *
 * base64 长度校验放在这里而不是等 transport 报错：`StdioServerTransport` 的
 * `maxBufferSize` 默认 10 MB，超了它会**关掉整条连接**——用户看到的是"所有
 * 工具都坏了"，而不是"这张图太大"。扩展侧已经按 `MCP_MAX_MESSAGE_BYTES`
 * 拦过一次，这里是第二道：协议两端各拦一次，任何一侧的常量改动都不会让
 * 另一侧静默失守。
 */
function imageContent(r: Extract<BridgeResult, { kind: 'image' }>, tool: McpToolName): CallToolResult {
  const b64len = Math.ceil(r.bytes.length / 3) * 4;
  if (b64len > MCP_MAX_MESSAGE_BYTES) {
    throw new BridgeError(
      MCP_ERROR.CAPTURE_FAILED,
      `the encoded image is ${Math.round(b64len / 1024 / 1024)} MiB, over the ${Math.round(
        MCP_MAX_MESSAGE_BYTES / 1024 / 1024,
      )} MiB limit; ask again with a smaller maxWidth`,
    );
  }
  const data = r.bytes.toString('base64');
  const note = r.note || `Captured ${r.w}×${r.h}.`;
  /* PDF 走 resource 块：见文件头。`uri` 用工具名 + 尺寸拼一个稳定的、
   * 不指向任何真实地址的标识——MCP 要求 resource 有 uri，而这里的东西
   * 是一次性产物，没有可寻址的位置。 */
  if (r.mime === 'application/pdf') {
    return {
      content: [
        {
          type: 'resource',
          resource: {
            uri: `psp://${tool}/${r.w}x${r.h}.pdf`,
            mimeType: r.mime,
            blob: data,
          },
        },
        { type: 'text', text: note },
      ],
    };
  }
  return {
    content: [
      { type: 'image', data, mimeType: r.mime },
      { type: 'text', text: note },
    ],
  };
}

/** JSON 结果统一序列化成一段文本——AI 读 JSON 文本没有障碍。 */
function jsonContent(value: unknown): CallToolResult {
  let text: string;
  try {
    text = JSON.stringify(value ?? null, null, 2);
  } catch {
    text = String(value);
  }
  return { content: [{ type: 'text', text }] };
}

/**
 * 注册全部八个工具。
 *
 * 每个 handler 都是同一个三段式：`bridge.call` → 按 `kind` 转 content →
 * 任何异常走 `errorResult`。**异常一律不往上抛**：抛出去 SDK 会回一个
 * JSON-RPC 错误，客户端拿到的是一段没有 `code` 的字符串，而 `needs_user_gesture`
 * 与 `pro_required` 恰恰是需要 AI 读码才能给出正确建议的两条。
 */
export function registerTools(server: McpServer, bridge: Bridge): void {
  const call = async (tool: McpToolName, params: unknown): Promise<BridgeResult> =>
    bridge.call(tool, params ?? {}, timeoutFor(tool));

  /** 三个截图类 + `history_get` 共用的收尾。 */
  const shotResult = async (tool: McpToolName, params: unknown): Promise<CallToolResult> => {
    const r = await call(tool, params);
    if (r.kind !== 'image') {
      /* 扩展说成功了却没给图：协议违例。不编一句"截图成功"，那会让 AI
       * 以为拿到了一张空图。 */
      throw new BridgeError(MCP_ERROR.CAPTURE_FAILED, 'the extension returned no image data');
    }
    return imageContent(r, tool);
  };

  const guard = async (fn: () => Promise<CallToolResult>): Promise<CallToolResult> => {
    try {
      return await fn();
    } catch (e) {
      const err = toBridgeError(e);
      return errorResult(err.code, err.message);
    }
  };

  server.registerTool(
    MCP_TOOLS.STATUS,
    {
      title: 'Page Screenshot Pro status',
      description:
        'Check whether Page Screenshot Pro is installed, connected and licensed, and which tools are available. Free — use it first when a screenshot tool fails.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () =>
      guard(async () => {
        const r = await call(MCP_TOOLS.STATUS, {});
        return jsonContent(r.kind === 'json' ? r.value : null);
      }),
  );

  server.registerTool(
    MCP_TOOLS.VISIBLE,
    {
      title: 'Capture visible area',
      description:
        'Capture what is currently visible in the active browser tab. Requires Pro. Returns the image plus a note with its size and history id.',
      inputSchema: FORMAT_ONLY_SCHEMA,
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    (args) => guard(() => shotResult(MCP_TOOLS.VISIBLE, args)),
  );

  server.registerTool(
    MCP_TOOLS.FULL_PAGE,
    {
      title: 'Capture full page',
      description:
        'Capture the entire scrollable page, stitching the tiles. Requires Pro. Can take a while on long pages. Returns the image plus a note with its size and history id.',
      inputSchema: FULL_PAGE_SCHEMA,
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    (args) => guard(() => shotResult(MCP_TOOLS.FULL_PAGE, args)),
  );

  server.registerTool(
    MCP_TOOLS.ELEMENT,
    {
      title: 'Capture element',
      description:
        'Capture a single element of the active tab, chosen by CSS selector. Requires Pro. The first match is used.',
      inputSchema: ELEMENT_SCHEMA,
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    (args) => guard(() => shotResult(MCP_TOOLS.ELEMENT, args)),
  );

  server.registerTool(
    MCP_TOOLS.OCR,
    {
      title: 'Read text from the page',
      description:
        'Run OCR on the visible area, or on one element when a selector is given, and return the recognized text. Requires Pro.',
      inputSchema: OCR_SCHEMA,
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    (args) =>
      guard(async () => {
        const r = await call(MCP_TOOLS.OCR, args);
        if (r.kind !== 'json') throw new BridgeError(MCP_ERROR.INTERNAL, 'expected OCR text');
        const text = (r.value as { text?: unknown } | null)?.text;
        return { content: [{ type: 'text', text: typeof text === 'string' ? text : '' }] };
      }),
  );

  server.registerTool(
    MCP_TOOLS.HISTORY_LIST,
    {
      title: 'List screenshot history',
      description:
        'List recent screenshots taken with this extension (id, kind, size, timestamp). Returns no images — use history_get to fetch one.',
      inputSchema: HISTORY_LIST_SCHEMA,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) =>
      guard(async () => {
        const r = await call(MCP_TOOLS.HISTORY_LIST, args);
        return jsonContent(r.kind === 'json' ? r.value : null);
      }),
  );

  server.registerTool(
    MCP_TOOLS.HISTORY_GET,
    {
      title: 'Get a screenshot from history',
      description:
        'Fetch one stored screenshot by id and return it as an image. Requires Pro.',
      inputSchema: HISTORY_GET_SCHEMA,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => guard(() => shotResult(MCP_TOOLS.HISTORY_GET, args)),
  );

  server.registerTool(
    MCP_TOOLS.EXPORT_PDF,
    {
      title: 'Export a screenshot as PDF',
      description:
        'Render one stored screenshot into a single-page PDF and return it as a binary resource (application/pdf). Requires Pro.',
      inputSchema: EXPORT_PDF_SCHEMA,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => guard(() => shotResult(MCP_TOOLS.EXPORT_PDF, args)),
  );
}
