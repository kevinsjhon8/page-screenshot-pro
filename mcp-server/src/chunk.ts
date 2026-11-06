/* mcp-server/src/chunk.ts —— 图片分块重组（纯逻辑，可单测）
 *
 * 线上格式（`docs/mcp-architecture.md` §4.2）：
 *
 *   → { type:'image', id, mime, w, h, bytes, chunkIndex, chunkCount }
 *   → <binary frame: 该块字节>
 *
 * 元数据帧与紧随的二进制帧成对出现。WS 保证同一条连接上的帧顺序，所以
 * "上一个元数据帧的 id 就是这一块的主人"是可靠的——**但只在同一条连接内**，
 * 因此 `reset()` 必须在每次重连时调用，否则上一代连接残留的 `awaiting`
 * 会把新连接的第一块二进制帧塞进旧的 id 里。
 *
 * 为什么分块：`StdioServerTransport` 的 `maxBufferSize` 默认 10 MB，单条
 * MCP 消息超过它，transport 会报错并**关掉整条连接**——连累同一连接上的
 * 后续请求，用户看到的是"所有工具都坏了"。
 */

import { MCP_CHUNK_BYTES, MCP_MAX_MESSAGE_BYTES } from '../../utils/mcp-protocol.js';

/** 元数据帧解析后的形状。 */
export interface ImageMeta {
  id: string;
  mime: string;
  w: number;
  h: number;
  /** 整张图的总字节数（不是这一块的） */
  bytes: number;
  chunkIndex: number;
  chunkCount: number;
}

export interface AssembledImage {
  bytes: Buffer;
  mime: string;
  w: number;
  h: number;
}

/**
 * 块数上限。
 *
 * 不是"能收多少收多少"：一个坏掉的或恶意的对端发 `chunkCount: 1e9` 时，
 * 若照单全收就是一个内存炸弹。上限由协议自己的两个常量推出——一张图最多
 * `MCP_MAX_MESSAGE_BYTES`，每块 `MCP_CHUNK_BYTES`——再留两块余量，让
 * "扩展侧将来把块调小一点"不至于立刻被拒。
 */
const MAX_CHUNKS = Math.ceil(MCP_MAX_MESSAGE_BYTES / MCP_CHUNK_BYTES) + 2;

interface Entry {
  mime: string;
  w: number;
  h: number;
  total: number;
  chunkCount: number;
  parts: Map<number, Buffer>;
  gotBytes: number;
}

/**
 * 把 `unknown` 解析成 `ImageMeta`，任何一处不对就返回 `null`。
 *
 * 校验全部放在这里而不是"用的时候再说"：一条畸形的元数据帧如果被接受，
 * 后面每一块都会往一个没有边界的容器里写。
 */
export function parseImageMeta(raw: unknown): ImageMeta | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id : '';
  const mime = typeof r.mime === 'string' ? r.mime : '';
  if (!id || !mime) return null;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
  const w = num(r.w);
  const h = num(r.h);
  const total = num(r.bytes);
  const chunkIndex = num(r.chunkIndex);
  const chunkCount = num(r.chunkCount);
  if (!(w > 0) || !(h > 0)) return null;
  if (!(total > 0) || total > MCP_MAX_MESSAGE_BYTES) return null;
  if (!(chunkCount >= 1) || chunkCount > MAX_CHUNKS) return null;
  if (!(chunkIndex >= 0) || chunkIndex >= chunkCount) return null;
  return { id, mime, w, h, bytes: total, chunkIndex, chunkCount };
}

/**
 * 一张图的分块累加器。
 *
 * 按 `chunkIndex` 归位而不是按到达顺序 append：协议保证顺序，但"保证"是
 * 对端的行为，累加器不该依赖它——乱序到达时按索引填仍然是对的，而 append
 * 会把块拼错，且拼错的图片**不会报错**，只是 AI 看到一张花屏。
 */
export class ChunkAssembler {
  private readonly entries = new Map<string, Entry>();
  /** 上一个元数据帧；紧随的二进制帧属于它。`null` 表示没有等待中的块。 */
  private awaiting: ImageMeta | null = null;

  /**
   * 收一条元数据帧。返回 `false` 表示这条帧被拒了（畸形），调用方应当把
   * 随后的二进制帧当作孤立帧丢掉。
   */
  onMeta(raw: unknown): boolean {
    const meta = parseImageMeta(raw);
    if (!meta) {
      this.awaiting = null;
      return false;
    }
    const prev = this.entries.get(meta.id);
    /* 同一 id 的元数据帧必须自洽。第二块起 mime/尺寸/总数/块数都应当与
     * 第一块一致——不一致说明对端把两张图混进了一个 id，拼出来的东西
     * 既不是 A 也不是 B。 */
    if (
      prev &&
      (prev.mime !== meta.mime ||
        prev.w !== meta.w ||
        prev.h !== meta.h ||
        prev.total !== meta.bytes ||
        prev.chunkCount !== meta.chunkCount)
    ) {
      this.entries.delete(meta.id);
      this.awaiting = null;
      return false;
    }
    if (!prev) {
      this.entries.set(meta.id, {
        mime: meta.mime,
        w: meta.w,
        h: meta.h,
        total: meta.bytes,
        chunkCount: meta.chunkCount,
        parts: new Map(),
        gotBytes: 0,
      });
    }
    this.awaiting = meta;
    return true;
  }

  /**
   * 收一块二进制。没有等待中的元数据帧 → 丢弃（孤立帧）。
   *
   * 返回 `true` 表示这一块被收下了。重复的 `chunkIndex` 覆盖前一块而不是
   * 累加——同一块重发时累加会让总长度对不上，而总长度校验在 `take()` 里。
   */
  onBinary(data: Buffer): boolean {
    const meta = this.awaiting;
    this.awaiting = null;
    if (!meta) return false;
    const e = this.entries.get(meta.id);
    if (!e) return false;
    const old = e.parts.get(meta.chunkIndex);
    if (old) e.gotBytes -= old.length;
    e.parts.set(meta.chunkIndex, data);
    e.gotBytes += data.length;
    /* 收满就丢：再来的块只会覆盖已收的，留着只是多占内存。 */
    if (e.gotBytes > e.total) {
      this.entries.delete(meta.id);
      return false;
    }
    return true;
  }

  /**
   * 取走并删除一个已完成（或已失败）的 id。
   *
   * 返回 `null` 有三种情况，调用方**不需要**区分：还没收齐（`result` 帧
   * 先到是协议违例，但重连时也可能出现）、压根没有这个 id、以及总长度
   * 对不上（末块截断）。三种都归成"这张图不能交给 AI"。
   */
  take(id: string): AssembledImage | null {
    const e = this.entries.get(id);
    if (!e) return null;
    this.entries.delete(id);
    if (e.parts.size !== e.chunkCount) return null;
    const parts: Buffer[] = [];
    for (let i = 0; i < e.chunkCount; i++) {
      const p = e.parts.get(i);
      if (!p) return null; // 缺块
      parts.push(p);
    }
    const bytes = Buffer.concat(parts, e.gotBytes);
    /* 总长度对不上 = 截断。宁可让这次调用失败，也不要把半张图当成整张
     * 交给 AI——那看起来像"截图只截了一半"，而真正的原因是传输坏了。 */
    if (bytes.length !== e.total) return null;
    return { bytes, mime: e.mime, w: e.w, h: e.h };
  }

  /** 丢掉一个 id 的所有已收块（请求失败 / 超时时调用）。 */
  drop(id: string): void {
    this.entries.delete(id);
    if (this.awaiting && this.awaiting.id === id) this.awaiting = null;
  }

  /** 清空。**重连时必须调用**：见文件头关于 `awaiting` 的说明。 */
  reset(): void {
    this.entries.clear();
    this.awaiting = null;
  }
}
