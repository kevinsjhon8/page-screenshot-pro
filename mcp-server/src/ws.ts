/* mcp-server/src/ws.ts —— WebSocket 服务端：认证、请求/响应配对、图片重组
 *
 * 这条连接的另一端是扩展的 offscreen document（`entrypoints/offscreen/
 * mcp-bridge.ts`）。协议在 `docs/mcp-architecture.md` §4.2，这里逐条对应。
 *
 * 三条纪律：
 *
 * 1. **必须绑 `127.0.0.1`。** `WebSocketServer` 的默认 host 是 `0.0.0.0`，
 *    那会把端口暴露到局域网——同一张 Wi-Fi 下的任何人都能连上来试 token。
 *    这是本文件唯一一处"少写一行就静默降级成不安全"的地方。
 * 2. **认证在 `call()` 之前，且只认第一帧。** token 是 128 位随机数，比较走
 *    常量时间（`utils/mcp-token.ts` 的 `timingSafeEqual`，与扩展侧同一份
 *    实现）。认证失败 `close(4001)`，不重试——重试只是每 30 秒撞一次同样的墙。
 * 3. **断连时所有 pending 立刻 reject，不重放。** 截图有副作用（消耗额度、
 *    翻页滚动、写历史），重放会把一次用户没要的截图变成两次。
 */

import { WebSocketServer, type WebSocket } from 'ws';
import {
  MCP_ERROR,
  MCP_PORT_BASE,
  MCP_PORT_COUNT,
  MCP_PROTOCOL_VERSION,
} from '../../utils/mcp-protocol.js';
import { timingSafeEqual } from '../../utils/mcp-token.js';
import { BridgeError } from './errors.js';
import { ChunkAssembler } from './chunk.js';

/** 连上之后等第一帧 `auth` 的上限。扩展侧自己的 `AUTH_TIMEOUT_MS` 是 3s。 */
const AUTH_WAIT_MS = 5_000;

/** 关码：4001 token 不对 / 4003 Origin 不对 / 4004 协议不对。 */
const CLOSE_AUTH = 4001;
const CLOSE_ORIGIN = 4003;

/**
 * 一次 `call()` 的结果。
 *
 * 文档 §F4 写的是 `Promise<unknown>`，这里改成**带标签的联合**：图片与
 * JSON 是两种完全不同的东西（前者是几 MB 的二进制、后者是几百字节的
 * 对象），用 `unknown` 的话 `tools.ts` 每一处都要写类型守卫去猜，
 * 而猜错的表现是"把 Buffer 当成对象取字段"——一个 `undefined` 静默流到
 * 用户面前。`kind` 让 `tools.ts` 的 switch 是穷尽的。
 */
export type BridgeResult =
  | { kind: 'json'; value: unknown }
  | { kind: 'image'; bytes: Buffer; mime: string; w: number; h: number; note: string };

export interface Bridge {
  /** 发一次工具调用。超时或断连时抛 `BridgeError`。 */
  call(tool: string, params: unknown, timeoutMs: number): Promise<BridgeResult>;
  isConnected(): boolean;
  /** 关掉服务端（测试与进程退出用）。 */
  close(): Promise<void>;
}

interface Pending {
  tool: string;
  resolve: (r: BridgeResult) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /** 这个 id 是否收到过图片元数据帧——用来区分"本来就该是 JSON"与
   *  "本该有图但拼不出来"。少了它，截断的图片会静默变成一次 JSON 成功。 */
  sawImage: boolean;
}

/** 绑一个端口，成功返回 server，失败返回 `null`（`EADDRINUSE` 等）。 */
function listenOn(port: number): Promise<WebSocketServer | null> {
  return new Promise((resolve) => {
    let settled = false;
    const server = new WebSocketServer({ port, host: '127.0.0.1' });
    const done = (ok: WebSocketServer | null): void => {
      if (settled) return;
      settled = true;
      server.removeAllListeners('listening');
      server.removeAllListeners('error');
      if (!ok) {
        try {
          server.close();
        } catch {
          /* 还没监听，close 可能抛 */
        }
      }
      resolve(ok);
    };
    server.once('listening', () => done(server));
    server.once('error', () => done(null));
  });
}

/**
 * Origin 检查。
 *
 * 只有**浏览器**会带 `Origin`，所以这一条挡住的正是最要紧的攻击面：用户
 * 随便打开的一个网页在 JS 里 `new WebSocket('ws://127.0.0.1:39127')`——
 * 没有它，任何网站都能连上本地端口去猜 token。
 *
 * 没有 `Origin` 的客户端放行（`curl`、`ws` 库的默认客户端、测试）：那是
 * 非浏览器进程，本来就跑在用户自己的机器上，真正的闸门是 token。把它一起
 * 拒掉只会让"用别的工具调一下"变成不可能，却挡不住任何真正的攻击者。
 */
function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  return origin.startsWith('chrome-extension://');
}

export interface StartBridgeOptions {
  /** 起始端口，默认 `MCP_PORT_BASE`。测试用它避开真实占用。 */
  portBase?: number;
  /** 试多少个端口，默认 `MCP_PORT_COUNT`。 */
  portCount?: number;
}

/**
 * 起服务并返回 `Bridge`。
 *
 * **全部端口都被占用时抛错**，由 `index.ts` 写 stderr 后 `exit(1)`。
 * 文档 §F3 把 `exit(1)` 写在 `startBridge` 里面，这里挪到了调用方：库函数
 * 直接结束进程，任何单测都没法覆盖"端口占满"这条分支，而它恰恰是最容易
 * 在用户机器上发生的一条（另一个 AI 客户端已经开着）。
 */
export async function startBridge(
  token: string,
  opts: StartBridgeOptions = {},
): Promise<Bridge> {
  const base = opts.portBase ?? MCP_PORT_BASE;
  const count = opts.portCount ?? MCP_PORT_COUNT;

  let server: WebSocketServer | null = null;
  let port = 0;
  for (let i = 0; i < count; i++) {
    const candidate = base + i;
    const s = await listenOn(candidate);
    if (s) {
      server = s;
      port = candidate;
      break;
    }
  }
  if (!server) {
    throw new BridgeError(
      MCP_ERROR.NOT_CONNECTED,
      `no free port in ${base}..${base + count - 1} (another MCP bridge is already running?)`,
    );
  }

  const pending = new Map<string, Pending>();
  const assembler = new ChunkAssembler();
  let sock: WebSocket | null = null;
  let authed = false;

  const srv: WebSocketServer = server;

  const failAll = (message: string): void => {
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      pending.delete(id);
      p.reject(new BridgeError(MCP_ERROR.NOT_CONNECTED, message));
    }
    assembler.reset();
  };

  const send = (obj: unknown): void => {
    if (!sock || sock.readyState !== 1) return;
    try {
      sock.send(JSON.stringify(obj));
    } catch {
      /* 发送瞬间断开：调用方按超时/断连处理 */
    }
  };

  function settle(id: string, frame: Record<string, unknown>): void {
    const p = pending.get(id);
    if (!p) return;
    const ok = frame.ok === true;
    if (!ok) {
      clearTimeout(p.timer);
      pending.delete(id);
      assembler.drop(id);
      const err = (frame.error || {}) as { code?: unknown; message?: unknown };
      const code = typeof err.code === 'string' ? err.code : MCP_ERROR.INTERNAL;
      const message = typeof err.message === 'string' ? err.message : 'extension reported an error';
      p.reject(new BridgeError(code as never, message));
      return;
    }
    /* 图片先到、`result` 后到：`sendBytes` 的最后一步才是 result 帧。
     * 所以这里 take() 拿到东西就说明这次调用带图。 */
    const img = assembler.take(id);
    clearTimeout(p.timer);
    pending.delete(id);
    if (p.sawImage) {
      if (!img) {
        /* 收到过元数据帧却没有完整的图：缺块、截断、或总长度对不上。
         * **不能**退化成 JSON 成功——那会让 AI 以为"这次没图"，而真正
         * 的原因是传输坏了，重试一次就好了。 */
        p.reject(new BridgeError(MCP_ERROR.CAPTURE_FAILED, 'image transfer was incomplete; retry'));
        return;
      }
      const res = (frame.result || {}) as { note?: unknown };
      p.resolve({
        kind: 'image',
        bytes: img.bytes,
        mime: img.mime,
        w: img.w,
        h: img.h,
        note: typeof res.note === 'string' ? res.note : '',
      });
      return;
    }
    p.resolve({ kind: 'json', value: frame.result });
  }

  srv.on('connection', (ws: WebSocket, req: { headers: Record<string, string | string[] | undefined> }) => {
    const rawOrigin = req.headers.origin;
    const origin = typeof rawOrigin === 'string' ? rawOrigin : undefined;
    if (!originAllowed(origin)) {
      try {
        ws.close(CLOSE_ORIGIN, 'origin not allowed');
      } catch {
        /* ignore */
      }
      return;
    }
    /* 只允许一条连接。第二台上线就把第一台挤掉的话，AI 客户端会看到
     * 请求随机失败；直接拒掉新的，行为可预期。 */
    if (sock) {
      try {
        ws.close(CLOSE_ORIGIN, 'another connection is active');
      } catch {
        /* ignore */
      }
      return;
    }
    sock = ws;
    authed = false;

    let authTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      authTimer = null;
      try {
        ws.close(CLOSE_AUTH, 'auth timeout');
      } catch {
        /* ignore */
      }
    }, AUTH_WAIT_MS);

    const clearAuthTimer = (): void => {
      if (authTimer !== null) {
        clearTimeout(authTimer);
        authTimer = null;
      }
    };

    ws.on('message', (data: unknown, isBinary: boolean) => {
      if (isBinary) {
        /* 二进制帧只可能是上一帧元数据对应的图块。认证前收到任何二进制
         * 都是协议违例——直接丢，不关连接（关连接会让"扩展发早了"变成
         * 一条需要重连才能恢复的故障）。 */
        if (!authed) return;
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        assembler.onBinary(buf);
        return;
      }
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(String(data)) as Record<string, unknown>;
      } catch {
        return;
      }
      const type = typeof frame.type === 'string' ? frame.type : '';

      if (!authed) {
        /* 第一帧必须是 auth。 */
        if (type !== 'auth') {
          clearAuthTimer();
          try {
            ws.close(CLOSE_AUTH, 'auth required');
          } catch {
            /* ignore */
          }
          return;
        }
        const got = typeof frame.token === 'string' ? frame.token : '';
        if (!timingSafeEqual(got, token)) {
          clearAuthTimer();
          send({ type: 'auth-fail', reason: 'bad token' });
          try {
            ws.close(CLOSE_AUTH, 'bad token');
          } catch {
            /* ignore */
          }
          return;
        }
        const version = typeof frame.protocolVersion === 'number' ? frame.protocolVersion : 0;
        if (version !== MCP_PROTOCOL_VERSION) {
          /* 版本不同就拒绝，而不是"尽力兼容"：两边的工具集与错误码都在变，
           * 半兼容的表现是 AI 收到它不认识的错误码，比明说"版本不对"难查。 */
          clearAuthTimer();
          send({ type: 'auth-fail', reason: 'protocol version mismatch' });
          try {
            ws.close(CLOSE_AUTH, 'protocol mismatch');
          } catch {
            /* ignore */
          }
          return;
        }
        authed = true;
        clearAuthTimer();
        send({ type: 'auth-ok', protocolVersion: MCP_PROTOCOL_VERSION });
        return;
      }

      if (type === 'result') {
        settle(typeof frame.id === 'string' ? frame.id : '', frame);
        return;
      }
      if (type === 'image') {
        const id = typeof frame.id === 'string' ? frame.id : '';
        const p = pending.get(id);
        /* 元数据帧本身要被接受，后面的二进制帧才有归属。`sawImage` 记在
         * pending 上而不是 assembler 里：它是"这次调用该有图"的证据，与
         * 块收得全不全无关。 */
        if (p && assembler.onMeta(frame)) p.sawImage = true;
        return;
      }
      /* `progress` 与未知类型：忽略。进度目前只用于人看的日志，
       * 转成 MCP 的 progress 通知需要一个 progressToken，而 AI 客户端
       * 大多不发；沉默比假装支持好。 */
    });

    ws.on('close', () => {
      clearAuthTimer();
      if (sock === ws) {
        sock = null;
        authed = false;
      }
      /* 不重放：见文件头第 3 条。 */
      failAll('the extension disconnected');
    });

    ws.on('error', () => {
      /* close 一定紧跟其后，统一在那里处理 */
    });
  });

  const bridge: Bridge = {
    call(tool: string, params: unknown, timeoutMs: number): Promise<BridgeResult> {
      if (!sock || sock.readyState !== 1 || !authed) {
        return Promise.reject(
          new BridgeError(MCP_ERROR.NOT_CONNECTED, 'the extension is not connected'),
        );
      }
      const id = crypto.randomUUID();
      return new Promise<BridgeResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          assembler.drop(id);
          reject(
            new BridgeError(
              MCP_ERROR.CAPTURE_FAILED,
              `the extension did not answer within ${Math.round(timeoutMs / 1000)}s`,
            ),
          );
        }, timeoutMs);
        /* `unref`：定时器不该在进程该退出时把 Node 拖住。`ocr-e2e.mjs`
         * 就因为一个没清掉的 race 截止时间多活了七分钟（CLAUDE.md 记着
         * 这一课），同样的形状不要在服务端再犯一次。 */
        if (typeof timer.unref === 'function') timer.unref();
        pending.set(id, { tool, resolve, reject, timer, sawImage: false });
        send({ type: 'request', id, tool, params: params ?? {} });
      });
    },

    isConnected(): boolean {
      return authed && !!sock && sock.readyState === 1;
    },

    close(): Promise<void> {
      failAll('bridge is shutting down');
      return new Promise<void>((resolve) => {
        try {
          if (sock) sock.close();
        } catch {
          /* ignore */
        }
        srv.close(() => resolve());
      });
    },
  };

  /* 端口只用于日志与排查，走 stderr。stdout 是 MCP 协议的专属通道，
   * 一行 `console.log` 就能让客户端解析失败（docs/mcp-implementation.md
   * §F3 第 1 条）。 */
  process.stderr.write(`page-screenshot-mcp: listening on ws://127.0.0.1:${port}\n`);

  return bridge;
}
