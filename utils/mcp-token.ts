/* utils/mcp-token.ts —— MCP 配对 token 与开关状态（纯逻辑 + 注入存储）
 *
 * 存 `storage.local['psp_mcp_v1']`，**不是 storage.sync**：
 * token 是「本机授权」。漫游到别的机器等于两台机器抢同一个 token，
 * 而且 sync 有 8KB/键限制与写入配额，这里没有任何理由冒这个险。
 * （`utils/settings.ts` 的注释里也写着：配额、授权这类有安全含义的数据
 * 留在 local，不要搬去 sync。）
 *
 * 存储抽成 `McpKV` 参数注入，理由与 `license.ts` / `settings.ts` 一样：
 * 扩展里传 `browser.storage.local`，测试里传 mock，纯函数才可测。
 */

export const MCP_STATE_KEY = 'psp_mcp_v1';
export const MCP_LOG_KEY = 'psp_mcp_log_v1';

/** token 定长：16 字节随机 → 32 个十六进制字符。 */
export const MCP_TOKEN_LEN = 32;

export interface McpState {
  /** 用户开关。关掉保留 token，下次打开不用重新配对。 */
  enabled: boolean;
  /** 32 位十六进制。首次启用时生成，重置时覆盖。 */
  token: string;
  createdAt: number;
  /** 最近一次成功认证的时间（毫秒）。设置页用它区分「从未连过」与「连过又断了」。 */
  lastConnectedAt?: number;
}

/** 只读键值区抽象（生产传 browser.storage.local，测试传 mock） */
export interface McpKV {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

const TOKEN_RE = /^[0-9a-f]{32}$/;

/**
 * 生成新 token。
 *
 * 注入 `random` 是为了让测试不依赖真 crypto，不是为了留后门——生产调用点
 * 一律不传参。**绝不能用 `Math.random()`**：它不是密码学安全的，32 位十六
 * 进制听起来多，用可预测序列生成就只剩摆设。
 */
export function newToken(random?: (n: number) => Uint8Array): string {
  let bytes: Uint8Array;
  if (random) {
    bytes = random(16);
  } else {
    bytes = new Uint8Array(16);
    /* 结构化类型而不是全局 `Crypto`：这个文件同时被扩展（lib 里有 DOM）
     * 和 `mcp-server/`（只有 @types/node，没有 DOM lib）编译，`Crypto` 这个
     * 全局名字在后者里不存在——写成结构化类型，两边都认得，也不用为了一个
     * 类型把 DOM lib 塞进 bridge 的 tsconfig。 */
    const c = (globalThis as {
      crypto?: { getRandomValues?: (b: Uint8Array) => Uint8Array };
    }).crypto;
    if (!c || typeof c.getRandomValues !== 'function') {
      // 没有 crypto 就**不能**退化到 Math.random：宁可抛，让调用方看见。
      // 一个弱 token 比一个明晃晃的错误危险得多。
      throw new Error('crypto.getRandomValues 不可用，无法生成安全 token');
    }
    c.getRandomValues(bytes);
  }
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += (bytes[i] as number).toString(16).padStart(2, '0');
  return out;
}

/**
 * 常量时间比较。
 *
 * 长度不等直接 `false` 会泄露长度，但 token 定长 32，泄露它没有意义；
 * 反过来，先补齐再比会让「长度不同」这条路径变慢，反而多一个侧信道。
 *
 * 逐字符 XOR 累积：无论第几个字符不同，循环次数都一样。
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * 逐字段校验存储里读出来的东西。
 *
 * **不是** `{...DEFAULT, ...raw}`：那个写法让 `enabled: 'yes'` 变成真、
 * 让 token 变成 `'abc'`，然后整个通道在认证时静默失败。理由与
 * `normalizeSettings` 完全一样。
 *
 * 返回 `null` 表示「没有可用的 MCP 配置」——首次使用、或者数据被清掉。
 * 注意 `enabled: true` 但 token 非法也返回 `null`：那是一个坏记录，
 * 不是「已启用」。
 */
export function normalizeMcpState(raw: unknown): McpState | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.enabled !== true) return null;
  if (typeof r.token !== 'string' || !TOKEN_RE.test(r.token)) return null;
  const createdAt = typeof r.createdAt === 'number' && Number.isFinite(r.createdAt)
    ? r.createdAt
    : 0;
  const out: McpState = { enabled: true, token: r.token, createdAt };
  if (typeof r.lastConnectedAt === 'number' && Number.isFinite(r.lastConnectedAt)) {
    out.lastConnectedAt = r.lastConnectedAt;
  }
  return out;
}

/** 读状态；没有、坏了、或未启用都返回 `null`。 */
export async function readMcpState(kv: McpKV): Promise<McpState | null> {
  const got = await kv.get(MCP_STATE_KEY).catch(() => ({}) as Record<string, unknown>);
  return normalizeMcpState(got ? got[MCP_STATE_KEY] : null);
}

/** 写状态。调用方负责给出完整的 `McpState`（不做合并）。 */
export async function writeMcpState(kv: McpKV, s: McpState): Promise<void> {
  await kv.set({ [MCP_STATE_KEY]: s });
}

/**
 * 首次启用：没有合法 token 就生成一个。
 *
 * 单独一个函数而不是让调用方自己判断，是因为「启用时该不该生成 token」
 * 有两条路要走对：没有记录 → 生成；有记录但 `enabled:false` → **复用**
 * 原 token（用户关掉再打开，AI 客户端那边已经配好的 JSON 不该失效）。
 */
export async function ensureMcpState(
  kv: McpKV,
  now: number,
  random?: (n: number) => Uint8Array,
): Promise<McpState> {
  const got = await kv.get(MCP_STATE_KEY).catch(() => ({}) as Record<string, unknown>);
  const raw = got ? got[MCP_STATE_KEY] : null;
  // 这里不能用 normalizeMcpState：它对 enabled !== true 直接返回 null，
  // 会把「停用但保留 token」的旧记录当成不存在，从而重新生成 token。
  const prev = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  const prevToken = prev && typeof prev.token === 'string' && TOKEN_RE.test(prev.token)
    ? prev.token
    : '';
  const createdAt = prev && typeof prev.createdAt === 'number' && Number.isFinite(prev.createdAt)
    ? prev.createdAt
    : now;
  const s: McpState = { enabled: true, token: prevToken || newToken(random), createdAt };
  if (prev && typeof prev.lastConnectedAt === 'number' && Number.isFinite(prev.lastConnectedAt)) {
    s.lastConnectedAt = prev.lastConnectedAt;
  }
  await writeMcpState(kv, s);
  return s;
}

/** 关掉开关但**保留 token**。 */
export async function disableMcp(kv: McpKV): Promise<void> {
  const got = await kv.get(MCP_STATE_KEY).catch(() => ({}) as Record<string, unknown>);
  const raw = got ? got[MCP_STATE_KEY] : null;
  const prev = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  const token = prev && typeof prev.token === 'string' && TOKEN_RE.test(prev.token)
    ? prev.token
    : '';
  await writeMcpState(kv, {
    enabled: false,
    token,
    createdAt: prev && typeof prev.createdAt === 'number' ? prev.createdAt : Date.now(),
  });
}

/** 重置 token：生成新的、保持启用。旧连接必须由调用方断开。 */
export async function resetMcpToken(
  kv: McpKV,
  now: number,
  random?: (n: number) => Uint8Array,
): Promise<McpState> {
  const s: McpState = { enabled: true, token: newToken(random), createdAt: now };
  await writeMcpState(kv, s);
  return s;
}

/** 记一次成功连接的时间。写失败不影响连接本身，调用方 `.catch` 掉。 */
export async function markMcpConnected(kv: McpKV, now: number): Promise<void> {
  const cur = await readMcpState(kv);
  if (!cur) return;
  await writeMcpState(kv, { ...cur, lastConnectedAt: now });
}
