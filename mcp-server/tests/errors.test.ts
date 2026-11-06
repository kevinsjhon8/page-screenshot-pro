/* mcp-server/tests/errors.test.ts —— 错误码映射
 *
 * 这里钉的不是文案，是**两个方向**：
 *   - 已知码原样透传（否则 AI 拿到 `internal`，`needs_user_gesture` 的
 *     指导就没了）
 *   - 未知码收敛到 `internal`（否则客户端拿到一个它不认识的字符串）
 *
 * `HINTS` 的覆盖也逐个断言：一个码漏了建议不会报错，只是那类失败对 AI
 * 变成了一句没有出路的描述。
 */

import { describe, expect, it } from 'vitest';
import { MCP_ERROR } from '../../utils/mcp-protocol.js';
import { BridgeError, errorResult, errorText, normalizeCode, toBridgeError } from '../src/errors.js';

describe('normalizeCode', () => {
  it('已知码原样返回', () => {
    for (const code of Object.values(MCP_ERROR)) {
      expect(normalizeCode(code)).toBe(code);
    }
  });

  it('未知/非字符串 → internal', () => {
    expect(normalizeCode('nope')).toBe(MCP_ERROR.INTERNAL);
    expect(normalizeCode(undefined)).toBe(MCP_ERROR.INTERNAL);
    expect(normalizeCode(42)).toBe(MCP_ERROR.INTERNAL);
    expect(normalizeCode('')).toBe(MCP_ERROR.INTERNAL);
  });
});

describe('BridgeError', () => {
  it('构造时归一化 code', () => {
    const e = new BridgeError(MCP_ERROR.BUSY, 'x');
    expect(e.code).toBe(MCP_ERROR.BUSY);
    expect(e.message).toBe('x');
    expect(e).toBeInstanceOf(Error);
  });

  it('构造时把非法 code 收敛成 internal', () => {
    expect(new BridgeError('bogus' as never, 'x').code).toBe(MCP_ERROR.INTERNAL);
  });
});

describe('errorText', () => {
  it('形如 `code: message`', () => {
    /* `busy` 是带 Hint 的码，所以断言前缀而不是全等——全等会把"加了建议"
     * 变成一次红灯，而加建议恰恰是对的。 */
    const text = errorText(MCP_ERROR.BUSY, '正在截图');
    expect(text.split('\n')[0]).toBe(`${MCP_ERROR.BUSY}: 正在截图`);
  });

  it('需要动作的码带一行 Hint', () => {
    const text = errorText(MCP_ERROR.NEEDS_USER_GESTURE, '权限不足');
    expect(text).toContain(`${MCP_ERROR.NEEDS_USER_GESTURE}: 权限不足`);
    expect(text).toContain('Hint:');
    expect(text).toContain('Alt+Shift+D');
  });

  it('每个需要动作的码都有自己的 Hint', () => {
    /* 漏一个不会报错——那一类失败对 AI 就只是一句描述。逐个点名。 */
    for (const code of [
      MCP_ERROR.PRO_REQUIRED,
      MCP_ERROR.NOT_CONNECTED,
      MCP_ERROR.NEEDS_USER_GESTURE,
      MCP_ERROR.BUSY,
      MCP_ERROR.TAB_NOT_FOUND,
      MCP_ERROR.PAGE_NOT_SCRIPTABLE,
      MCP_ERROR.INVALID_PARAMS,
    ]) {
      expect(errorText(code, 'm')).toContain('Hint:');
    }
  });

  it('没有额外动作的码不编 Hint', () => {
    expect(errorText(MCP_ERROR.INTERNAL, 'm')).toBe(`${MCP_ERROR.INTERNAL}: m`);
    expect(errorText(MCP_ERROR.CAPTURE_FAILED, 'm')).not.toContain('Hint:');
  });
});

describe('errorResult', () => {
  it('是 isError 结果，且带码', () => {
    const r = errorResult(MCP_ERROR.PRO_REQUIRED, '需要 Pro');
    expect(r.isError).toBe(true);
    expect(r.content).toHaveLength(1);
    const block = r.content[0] as { type: string; text: string };
    expect(block.type).toBe('text');
    expect(block.text).toContain(MCP_ERROR.PRO_REQUIRED);
    expect(block.text).toContain('需要 Pro');
  });
});

describe('toBridgeError', () => {
  it('BridgeError 原样返回', () => {
    const e = new BridgeError(MCP_ERROR.BUSY, 'x');
    expect(toBridgeError(e)).toBe(e);
  });

  it('带 code 的普通对象被收敛成 BridgeError', () => {
    const e = toBridgeError({ code: MCP_ERROR.PRO_REQUIRED, message: '需要 Pro' });
    expect(e).toBeInstanceOf(BridgeError);
    expect(e.code).toBe(MCP_ERROR.PRO_REQUIRED);
    expect(e.message).toBe('需要 Pro');
  });

  it('没有 code 的 Error → internal，message 保留', () => {
    const e = toBridgeError(new Error('boom'));
    expect(e.code).toBe(MCP_ERROR.INTERNAL);
    expect(e.message).toBe('boom');
  });

  it('连 message 都没有的东西也有文案，不会变成 undefined', () => {
    expect(toBridgeError(null).message).not.toBe('undefined');
    expect(toBridgeError('oops').message).toBe('oops');
  });
});
