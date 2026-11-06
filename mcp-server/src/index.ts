#!/usr/bin/env node
/* mcp-server/src/index.ts —— 入口：解析 env → 起 WS → serveStdio
 *
 * 这个进程同时是两样东西：
 *   - 对 AI 客户端：一个 stdio MCP server（stdout 只跑协议）
 *   - 对扩展：一个 127.0.0.1 上的 WebSocket 服务端
 *
 * 三条纪律（docs/mcp-implementation.md §F3）：
 *
 * 1. **stdout 只跑协议。** 所有日志走 `process.stderr.write`。一行
 *    `console.log` 就能让 MCP 客户端解析失败——而失败的样子是"客户端连不
 *    上这个 server"，不是"日志里多了一行"。
 * 2. **端口失败要快。** 全部端口被占用时写 stderr 并 `exit(1)`，不静默重试：
 *    用户需要知道"已经有一个 bridge 在跑了"，而不是看着一个永远连不上的
 *    进程在那儿转。
 * 3. **不要在 factory 外建 `McpServer`。** `serveStdio` 的 factory 每次连接
 *    调用一次；把实例建在外面会让第二个连接复用第一个的注册表。
 *
 * token 的来源：AI 客户端的配置里那一行 `"PSP_MCP_TOKEN": "…"`，与扩展
 * 设置页显示的 JSON 一致。**不接受命令行参数**——参数会出现在进程列表里，
 * `ps` 一行就能看到别的用户的 token。
 *
 * **第一行的 shebang 是必需的，不是装饰。** `package.json` 的 `bin` 指向编译
 * 产物，而 npm 在 Unix 上只给 `node_modules/.bin/` 建符号链接、**不会补
 * shebang**：没有这一行，`npx -y page-screenshot-mcp`（设置页生成的 JSON 正是
 * 这么写的）会让 shell 拿第一行注释当命令去执行，用户看到的是
 * `./node_modules/.bin/page-screenshot-mcp: 1: /bin: Permission denied`。
 * 0.1.0 发布出去时就是这个状态——`node dist/.../index.js` 能跑，只有 bin 那一
 * 层坏。`tsc` 会把它原样搬到 `dist/` 首行，`tests/bin.test.ts` 钉着。
 */

import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { MCP_TOKEN_LEN } from '../../utils/mcp-token.js';
import { startBridge } from './ws.js';
import { registerTools } from './tools.js';

function die(message: string): never {
  process.stderr.write(`page-screenshot-mcp: ${message}\n`);
  process.exit(1);
}

const token = process.env.PSP_MCP_TOKEN;
if (!token) {
  die(
    'PSP_MCP_TOKEN is not set. Copy the "env" block from the extension’s settings page into your MCP client config.',
  );
}
/* 长度与字符集都查：token 定长 32 个十六进制字符（`utils/mcp-token.ts` 的
 * `newToken`）。只查长度会让一个明显写错的 token 一路走到认证失败，而用户
 * 看到的是一句"扩展未连接"，排查方向完全错。 */
if (token.length !== MCP_TOKEN_LEN || !/^[0-9a-f]+$/.test(token)) {
  die(
    `PSP_MCP_TOKEN is malformed (expected ${MCP_TOKEN_LEN} lowercase hex characters). Re-copy it from the extension’s settings page.`,
  );
}

/* 端口全占满时抛 `BridgeError`，在这里收口成一次干净的退出。 */
const bridge = await startBridge(token).catch((e: unknown) => {
  die(String((e as Error)?.message || e));
});

serveStdio(() => {
  const server = new McpServer(
    { name: 'page-screenshot', version: '0.1.1' },
    { capabilities: { tools: {} } },
  );
  registerTools(server, bridge);
  return server;
});

/* 客户端断开（`serveStdio` 的 transport 关闭）之后进程本该自己退出，但 WS
 * 服务端还在监听，Node 会一直活着。挂一个显式的收尾，让"客户端退出 →
 * bridge 进程退出 → 端口释放"这条链完整，否则下次启动会撞上自己上一次的
 * 端口（39127..39137 共 11 个，撞几次就没了）。 */
const shutdown = (): void => {
  void bridge.close().finally(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
