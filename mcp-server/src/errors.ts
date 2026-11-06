/* mcp-server/src/errors.ts —— 错误码 → MCP 结果的映射（纯函数）
 *
 * 错误码的**唯一真相源**是 `utils/mcp-protocol.ts` 的 `MCP_ERROR`，扩展与
 * bridge 两侧共用同一个文件（见 tsconfig.json 的 `rootDir: ".."`）。这里
 * 只做两件事：把任意异常收成一个带码的 `BridgeError`，以及把
 * `{code, message}` 变成 MCP 的 `isError` 结果。
 *
 * 为什么不能把错误吞成空 content：AI 需要 `code` 才能给用户正确的建议。
 * `needs_user_gesture` 与 `capture_failed` 对人来说都是"截图失败了"，对 AI
 * 来说一个是"请用户点一下扩展图标"、一个是"重试或调小 maxWidth"——只给人话
 * 的话，AI 只能靠正则猜（这正是 `docs/mcp-architecture.md` §5 把错误码列成
 * 一张表的原因）。
 */

import type { CallToolResult } from '@modelcontextprotocol/server';
import { MCP_ERROR, type McpErrorCode } from '../../utils/mcp-protocol.js';

const KNOWN: ReadonlySet<string> = new Set(Object.values(MCP_ERROR));

/**
 * 未知码一律落到 `internal`。
 *
 * 不原样透传：扩展与 bridge 是两个独立版本，一个未来的错误码在这里只会让
 * 客户端拿到一个它不认识的字符串，而 `internal` 至少是协议里存在的。
 */
export function normalizeCode(raw: unknown): McpErrorCode {
  return typeof raw === 'string' && KNOWN.has(raw) ? (raw as McpErrorCode) : MCP_ERROR.INTERNAL;
}

/** 带机器码的 bridge 侧错误。`code` 一定是 `MCP_ERROR` 里的一个值。 */
export class BridgeError extends Error {
  readonly code: McpErrorCode;

  constructor(code: McpErrorCode, message: string) {
    super(message);
    this.name = 'BridgeError';
    this.code = normalizeCode(code);
  }
}

/**
 * 每个码后面那句「接下来该做什么」。
 *
 * 扩展带回来的 `message` 是**给用户看的人话**，而且是用户自己选的语言
 * （八种之一）——AI 读得懂，但读不出该采取什么动作。这里补的是动作。
 *
 * 只给"动作确实不同"的码写：`internal` 和 `capture_failed` 没有额外建议，
 * 硬编一句只会稀释真正的信息。
 */
const HINTS: Partial<Record<McpErrorCode, string>> = {
  [MCP_ERROR.PRO_REQUIRED]:
    'MCP access is a Pro feature. Ask the user to upgrade in the extension settings; psp_status reports the current licence.',
  [MCP_ERROR.NOT_CONNECTED]:
    'The Chrome extension is not connected. Ask the user to open Chrome with Page Screenshot Pro installed and "MCP access" enabled in its settings, then retry in a few seconds.',
  [MCP_ERROR.NEEDS_USER_GESTURE]:
    'Chrome requires a recent user gesture before it allows a capture. Ask the user to click the extension icon (or press Alt+Shift+D) in the browser window, then retry.',
  [MCP_ERROR.BUSY]: 'Another capture is still running. Wait for it to finish and retry.',
  [MCP_ERROR.TAB_NOT_FOUND]:
    'Switch the browser to a normal http(s) page. chrome:// pages, the Web Store and other extensions’ pages cannot be captured.',
  [MCP_ERROR.PAGE_NOT_SCRIPTABLE]:
    'The extension could not inject into this page. Ask the user to reload the tab and retry.',
  [MCP_ERROR.INVALID_PARAMS]:
    'Fix the arguments and retry. The tool schema lists what is accepted; psp_status reports the connected extension’s version.',
};

/** `code: message`，有建议时再跟一行 `Hint: …`。 */
export function errorText(code: unknown, message: string): string {
  const c = normalizeCode(code);
  const head = `${c}: ${message}`;
  const hint = HINTS[c];
  return hint ? `${head}\nHint: ${hint}` : head;
}

/** MCP 的失败结果。`isError` 让客户端知道这是失败而不是内容。 */
export function errorResult(code: unknown, message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: errorText(code, message) }] };
}

/**
 * 任意异常 → `BridgeError`。
 *
 * 三处来源都要能接住：`BridgeError` 自己（`call` 的超时、断连）、扩展经由
 * WS 带回来的 `{code, message}`（`ws.ts` 里重新抛成 `BridgeError`）、以及
 * 一个连 `.message` 都没有的怪东西（`String(e)` 兜底，绝不让 `undefined`
 * 变成错误文案）。
 */
export function toBridgeError(e: unknown): BridgeError {
  if (e instanceof BridgeError) return e;
  const o = e as { code?: unknown; message?: unknown } | null;
  const message = o && o.message !== undefined && o.message !== null ? String(o.message) : String(e);
  return new BridgeError(normalizeCode(o ? o.code : undefined), message);
}
