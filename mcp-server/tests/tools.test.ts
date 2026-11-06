/* mcp-server/tests/tools.test.ts —— 八个工具：名字、参数、超时、内容块形状
 *
 * 这一组测试的存在理由是**工具名有两份**：`utils/mcp-protocol.ts` 的
 * `MCP_TOOLS`（扩展侧按它 switch）和 `tools.ts` 里注册时写的那一个。两边
 * 共用常量只能保证"常量改了会一起改"，不能保证"调用点用的是常量"——把
 * `MCP_TOOLS.VISIBLE` 手写成 `'capture_visible'` 一样能跑，直到哪天常量
 * 改名。所以这里 mock 掉 `Bridge`，逐个断言**实际发出去的 tool 字符串**
 * 等于常量，而不是等于字面量。
 *
 * 另外三件事也在这里钉：
 *   - 超时：整页最慢（300s），其余 120s。传错的话整页截图会被半路掐断，
 *     而症状是"长页面截不全"，看起来像扩展的锅。
 *   - 内容块：`application/pdf` 必须是 `resource`，不是 `image`。塞进 image
 *     块客户端会按图片解码，得到乱码或一次解码失败。
 *   - 异常一律变成 `{isError:true}`，**不能**往上抛：抛出去 SDK 回的是
 *     一段没有 code 的 JSON-RPC 错误，而 `needs_user_gesture` 恰恰是需要
 *     AI 读到码才能给出正确建议的一条。
 */

import { describe, expect, it } from 'vitest';
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { MCP_ERROR, MCP_MAX_MESSAGE_BYTES, MCP_TOOLS } from '../../utils/mcp-protocol.js';
import { BridgeError } from '../src/errors.js';
import { registerTools } from '../src/tools.js';
import type { Bridge, BridgeResult } from '../src/ws.js';

/** 一次注册记录。 */
interface Reg {
  name: string;
  config: { title?: string; description?: string; inputSchema?: unknown };
  handler: (args: unknown) => Promise<CallToolResult>;
}

/** 假 server：只记下注册了什么。`registerTools` 只用到这一个方法。 */
function fakeServer(): { server: McpServer; regs: Reg[] } {
  const regs: Reg[] = [];
  const server = {
    registerTool(name: string, config: Reg['config'], handler: Reg['handler']) {
      regs.push({ name, config, handler });
    },
  };
  return { server: server as unknown as McpServer, regs };
}

/** 假 bridge：记下每次调用，按预设返回。 */
function fakeBridge(impl: (tool: string, params: unknown, timeoutMs: number) => Promise<BridgeResult>) {
  const calls: { tool: string; params: unknown; timeoutMs: number }[] = [];
  const bridge: Bridge = {
    call(tool, params, timeoutMs) {
      calls.push({ tool, params, timeoutMs });
      return impl(tool, params, timeoutMs);
    },
    isConnected: () => true,
    close: async () => {},
  };
  return { bridge, calls };
}

const IMAGE: BridgeResult = {
  kind: 'image',
  bytes: Buffer.from([1, 2, 3, 4]),
  mime: 'image/jpeg',
  w: 100,
  h: 200,
  note: '100×200.',
};

/** 取出第 n 个注册项，顺带断言它存在（`noUncheckedIndexedAccess` 下必需）。 */
function at(regs: Reg[], i: number): Reg {
  const r = regs[i];
  if (!r) throw new Error(`没有第 ${i} 个工具，只注册了 ${regs.length} 个`);
  return r;
}

function byName(regs: Reg[], name: string): Reg {
  const r = regs.find((x) => x.name === name);
  if (!r) throw new Error(`没有注册 ${name}，注册了：${regs.map((x) => x.name).join(', ')}`);
  return r;
}

describe('registerTools 注册表', () => {
  it('八个工具全部注册，且名字就是 MCP_TOOLS 的值', () => {
    const { server, regs } = fakeServer();
    const { bridge } = fakeBridge(async () => IMAGE);
    registerTools(server, bridge);
    expect(regs.map((r) => r.name).sort()).toEqual(Object.values(MCP_TOOLS).sort());
  });

  it('每个工具都有 title 与 description（AI 靠它选工具）', () => {
    const { server, regs } = fakeServer();
    registerTools(server, fakeBridge(async () => IMAGE).bridge);
    for (const r of regs) {
      expect(r.config.title, r.name).toBeTruthy();
      expect(r.config.description, r.name).toBeTruthy();
    }
  });
});

describe('每个工具发出的 tool 名与超时', () => {
  const CASES: { tool: string; args: unknown; timeout: number }[] = [
    { tool: MCP_TOOLS.STATUS, args: {}, timeout: 120_000 },
    { tool: MCP_TOOLS.VISIBLE, args: {}, timeout: 120_000 },
    { tool: MCP_TOOLS.FULL_PAGE, args: {}, timeout: 300_000 },
    { tool: MCP_TOOLS.ELEMENT, args: { selector: '#a' }, timeout: 120_000 },
    { tool: MCP_TOOLS.OCR, args: {}, timeout: 120_000 },
    { tool: MCP_TOOLS.HISTORY_LIST, args: {}, timeout: 120_000 },
    { tool: MCP_TOOLS.HISTORY_GET, args: { id: 'x' }, timeout: 120_000 },
    { tool: MCP_TOOLS.EXPORT_PDF, args: { id: 'x' }, timeout: 120_000 },
  ];

  for (const c of CASES) {
    it(`${c.tool} → 发出 ${c.tool}，超时 ${c.timeout}ms`, async () => {
      const { server, regs } = fakeServer();
      const { bridge, calls } = fakeBridge(async (tool) =>
        tool === MCP_TOOLS.STATUS || tool === MCP_TOOLS.HISTORY_LIST || tool === MCP_TOOLS.OCR
          ? { kind: 'json', value: { ok: true } }
          : IMAGE,
      );
      registerTools(server, bridge);
      await byName(regs, c.tool).handler(c.args);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.tool).toBe(c.tool);
      expect(calls[0]?.timeoutMs).toBe(c.timeout);
    });
  }

  it('参数原样转发，不丢字段', async () => {
    const { server, regs } = fakeServer();
    const { bridge, calls } = fakeBridge(async () => IMAGE);
    registerTools(server, bridge);
    const params = { selector: '#main', format: 'png', maxWidth: 1024 };
    await byName(regs, MCP_TOOLS.ELEMENT).handler(params);
    expect(calls[0]?.params).toEqual(params);
  });

  it('没有参数时发空对象，不是 undefined', async () => {
    /* 扩展侧按 `msg.params.xxx` 取字段，undefined 会让它抛——一个本该
     * 走默认值的调用变成一次内部错误。 */
    const { server, regs } = fakeServer();
    const { bridge, calls } = fakeBridge(async () => IMAGE);
    registerTools(server, bridge);
    await byName(regs, MCP_TOOLS.VISIBLE).handler(undefined);
    expect(calls[0]?.params).toEqual({});
  });
});

describe('内容块形状', () => {
  it('图片 → image 块 + 一句 note', async () => {
    const { server, regs } = fakeServer();
    registerTools(server, fakeBridge(async () => IMAGE).bridge);
    const r = await byName(regs, MCP_TOOLS.VISIBLE).handler({});
    expect(r.isError).toBeFalsy();
    expect(r.content).toHaveLength(2);
    expect(r.content[0]).toMatchObject({
      type: 'image',
      mimeType: 'image/jpeg',
      data: IMAGE.kind === 'image' ? IMAGE.bytes.toString('base64') : '',
    });
    expect(r.content[1]).toMatchObject({ type: 'text', text: '100×200.' });
  });

  it('note 为空时补一句尺寸，不留空文本块', async () => {
    const { server, regs } = fakeServer();
    registerTools(server, fakeBridge(async () => ({ ...(IMAGE as Extract<BridgeResult, { kind: 'image' }>), note: '' })).bridge);
    const r = await byName(regs, MCP_TOOLS.VISIBLE).handler({});
    const text = r.content[1] as { type: string; text: string };
    expect(text.text).toContain('100×200');
  });

  it('application/pdf → resource 块，不是 image 块', async () => {
    /* 塞进 image 块客户端会按图片去解码。按 mime 判、不按工具名判：
     * 将来再加一个"导出二进制"的工具不会重犯。 */
    const { server, regs } = fakeServer();
    const pdf: BridgeResult = { kind: 'image', bytes: Buffer.from('PDF'), mime: 'application/pdf', w: 800, h: 1200, note: 'PDF.' };
    registerTools(server, fakeBridge(async () => pdf).bridge);
    const r = await byName(regs, MCP_TOOLS.EXPORT_PDF).handler({ id: 'x' });
    expect(r.content.some((c) => c.type === 'image')).toBe(false);
    const res = r.content[0] as { type: string; resource: { uri: string; mimeType: string; blob: string } };
    expect(res.type).toBe('resource');
    expect(res.resource.mimeType).toBe('application/pdf');
    expect(res.resource.uri).toContain('psp://');
    expect(res.resource.uri).toContain('.pdf');
    expect(res.resource.blob).toBe(Buffer.from('PDF').toString('base64'));
  });

  it('超过 8 MiB 的 base64 → capture_failed，并提示调小 maxWidth', async () => {
    /* transport 自己的 maxBufferSize 是 10 MB，超了它会关掉整条连接：
     * 用户看到"所有工具都坏了"。这里提前拦，报错是可执行的。 */
    const { server, regs } = fakeServer();
    const big: BridgeResult = {
      kind: 'image',
      bytes: Buffer.alloc(Math.ceil((MCP_MAX_MESSAGE_BYTES * 3) / 4) + 1024),
      mime: 'image/png',
      w: 10,
      h: 10,
      note: '',
    };
    registerTools(server, fakeBridge(async () => big).bridge);
    const r = await byName(regs, MCP_TOOLS.VISIBLE).handler({});
    expect(r.isError).toBe(true);
    const text = (r.content[0] as { text: string }).text;
    expect(text).toContain(MCP_ERROR.CAPTURE_FAILED);
    expect(text).toContain('maxWidth');
  });

  it('OCR → 纯文本，且缺 text 字段时给空串而不是 "undefined"', async () => {
    const { server, regs } = fakeServer();
    registerTools(server, fakeBridge(async () => ({ kind: 'json', value: { text: 'hello' } })).bridge);
    const r = await byName(regs, MCP_TOOLS.OCR).handler({});
    expect(r.content).toEqual([{ type: 'text', text: 'hello' }]);

    const { server: s2, regs: r2 } = fakeServer();
    registerTools(s2, fakeBridge(async () => ({ kind: 'json', value: {} })).bridge);
    const r3 = await byName(r2, MCP_TOOLS.OCR).handler({});
    expect(r3.content).toEqual([{ type: 'text', text: '' }]);
  });

  it('history_list / psp_status → 格式化的 JSON 文本', async () => {
    const { server, regs } = fakeServer();
    registerTools(server, fakeBridge(async () => ({ kind: 'json', value: { shots: [{ id: 'a' }] } })).bridge);
    const r = await byName(regs, MCP_TOOLS.HISTORY_LIST).handler({});
    const text = (r.content[0] as { text: string }).text;
    expect(JSON.parse(text)).toEqual({ shots: [{ id: 'a' }] });
  });

  it('截图工具拿到 JSON 而不是图 → capture_failed，不编一句"截图成功"', async () => {
    const { server, regs } = fakeServer();
    registerTools(server, fakeBridge(async () => ({ kind: 'json', value: {} })).bridge);
    const r = await byName(regs, MCP_TOOLS.VISIBLE).handler({});
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain(MCP_ERROR.CAPTURE_FAILED);
  });
});

describe('异常 → isError 结果，不往上抛', () => {
  it('BridgeError 的 code 与 message 都进文案', async () => {
    const { server, regs } = fakeServer();
    registerTools(
      server,
      fakeBridge(async () => {
        throw new BridgeError(MCP_ERROR.NEEDS_USER_GESTURE, '需要先点一下扩展图标');
      }).bridge,
    );
    const r = await byName(regs, MCP_TOOLS.VISIBLE).handler({});
    expect(r.isError).toBe(true);
    const text = (r.content[0] as { text: string }).text;
    expect(text).toContain(MCP_ERROR.NEEDS_USER_GESTURE);
    expect(text).toContain('需要先点一下扩展图标');
    expect(text).toContain('Hint:');
  });

  it('普通 Error → internal，不让异常逃到 JSON-RPC 层', async () => {
    const { server, regs } = fakeServer();
    registerTools(
      server,
      fakeBridge(async () => {
        throw new Error('boom');
      }).bridge,
    );
    const r = await byName(regs, MCP_TOOLS.VISIBLE).handler({});
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain(MCP_ERROR.INTERNAL);
  });

  it('八个工具都走同一个 guard（逐个点一遍，漏一个不会报错）', async () => {
    const { server, regs } = fakeServer();
    registerTools(
      server,
      fakeBridge(async () => {
        throw new BridgeError(MCP_ERROR.NOT_CONNECTED, '扩展未连接');
      }).bridge,
    );
    for (const r of regs) {
      const out = await r.handler({ selector: '#a', id: 'x' });
      expect(out.isError, r.name).toBe(true);
      expect((out.content[0] as { text: string }).text, r.name).toContain(MCP_ERROR.NOT_CONNECTED);
    }
  });

  it('第一个注册项确实存在（防止上面的循环空转）', () => {
    const { server, regs } = fakeServer();
    registerTools(server, fakeBridge(async () => IMAGE).bridge);
    expect(regs.length).toBe(8);
    expect(at(regs, 0).name).toBeTruthy();
  });
});
