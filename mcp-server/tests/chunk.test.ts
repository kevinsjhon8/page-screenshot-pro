/* mcp-server/tests/chunk.test.ts —— 图片分块重组
 *
 * 重点不在"一块能拼回来"，而在四条**拼错了不会报错**的路径：
 *   - 乱序到达（append 会拼成花屏，按索引填才对）
 *   - 缺块（少一块仍然"拼完了"，只是图是坏的）
 *   - 总长度对不上（末块截断）
 *   - 上一代连接残留的 awaiting 把新连接的二进制帧吞掉
 * 每一条都有独立 case，因为它们各自的失败样子都是"AI 看到一张错图"，
 * 没有断言的话一个都发现不了。
 */

import { describe, expect, it } from 'vitest';
import { ChunkAssembler, parseImageMeta } from '../src/chunk.js';

/** 一条合法的元数据帧。 */
function meta(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'a', mime: 'image/jpeg', w: 10, h: 20, bytes: 6, chunkIndex: 0, chunkCount: 2, ...over };
}

describe('parseImageMeta', () => {
  it('接受一条合法帧', () => {
    expect(parseImageMeta(meta())).toMatchObject({ id: 'a', chunkIndex: 0, chunkCount: 2 });
  });

  it('拒绝畸形帧', () => {
    expect(parseImageMeta(null)).toBeNull();
    expect(parseImageMeta({})).toBeNull();
    expect(parseImageMeta(meta({ id: '' }))).toBeNull();
    expect(parseImageMeta(meta({ mime: '' }))).toBeNull();
    expect(parseImageMeta(meta({ w: 0 }))).toBeNull();
    expect(parseImageMeta(meta({ h: NaN }))).toBeNull();
    expect(parseImageMeta(meta({ bytes: 0 }))).toBeNull();
    expect(parseImageMeta(meta({ chunkCount: 0 }))).toBeNull();
    /* chunkIndex 必须小于 chunkCount，否则这一块永远不会被 take() 读到 */
    expect(parseImageMeta(meta({ chunkIndex: 2 }))).toBeNull();
    expect(parseImageMeta(meta({ chunkIndex: -1 }))).toBeNull();
  });

  it('拒绝超过协议上限的 chunkCount（内存炸弹）', () => {
    expect(parseImageMeta(meta({ chunkCount: 1_000_000_000 }))).toBeNull();
  });
});

describe('ChunkAssembler', () => {
  it('两块顺序到达能拼回来', () => {
    const a = new ChunkAssembler();
    expect(a.onMeta(meta({ chunkIndex: 0 }))).toBe(true);
    a.onBinary(Buffer.from('abc'));
    expect(a.onMeta(meta({ chunkIndex: 1 }))).toBe(true);
    a.onBinary(Buffer.from('def'));
    const img = a.take('a');
    expect(img?.bytes.toString()).toBe('abcdef');
    expect(img).toMatchObject({ mime: 'image/jpeg', w: 10, h: 20 });
  });

  it('乱序到达仍然按索引拼', () => {
    const a = new ChunkAssembler();
    a.onMeta(meta({ chunkIndex: 1 }));
    a.onBinary(Buffer.from('def'));
    a.onMeta(meta({ chunkIndex: 0 }));
    a.onBinary(Buffer.from('abc'));
    expect(a.take('a')?.bytes.toString()).toBe('abcdef');
  });

  it('缺块返回 null，而不是交出半张图', () => {
    const a = new ChunkAssembler();
    a.onMeta(meta({ chunkIndex: 0 }));
    a.onBinary(Buffer.from('abc'));
    expect(a.take('a')).toBeNull();
  });

  it('总长度对不上（末块截断）返回 null', () => {
    const a = new ChunkAssembler();
    a.onMeta(meta({ chunkIndex: 0 }));
    a.onBinary(Buffer.from('abc'));
    a.onMeta(meta({ chunkIndex: 1 }));
    a.onBinary(Buffer.from('de')); // 少一个字节
    expect(a.take('a')).toBeNull();
  });

  it('没有等待中的元数据帧时，二进制帧被丢弃', () => {
    const a = new ChunkAssembler();
    expect(a.onBinary(Buffer.from('abc'))).toBe(false);
    /* 之后正常的图仍然能拼：孤立帧不能把状态搞坏 */
    a.onMeta(meta({ chunkIndex: 0 }));
    a.onBinary(Buffer.from('abc'));
    a.onMeta(meta({ chunkIndex: 1 }));
    a.onBinary(Buffer.from('def'));
    expect(a.take('a')?.bytes.toString()).toBe('abcdef');
  });

  it('同一 id 的两帧元数据不自洽 → 整条丢弃', () => {
    const a = new ChunkAssembler();
    a.onMeta(meta({ chunkIndex: 0 }));
    a.onBinary(Buffer.from('abc'));
    /* 尺寸变了：说明对端把两张图混进了一个 id */
    expect(a.onMeta(meta({ chunkIndex: 1, w: 11 }))).toBe(false);
    expect(a.take('a')).toBeNull();
  });

  it('reset() 清掉残留的 awaiting（重连时的场景）', () => {
    const a = new ChunkAssembler();
    a.onMeta(meta({ chunkIndex: 0 }));
    a.reset();
    /* 不清的话这一帧会被塞进旧 id */
    expect(a.onBinary(Buffer.from('abc'))).toBe(false);
  });

  it('重复的 chunkIndex 覆盖而不是累加', () => {
    const a = new ChunkAssembler();
    a.onMeta(meta({ chunkIndex: 0 }));
    a.onBinary(Buffer.from('XXX'));
    a.onMeta(meta({ chunkIndex: 0 }));
    a.onBinary(Buffer.from('abc'));
    a.onMeta(meta({ chunkIndex: 1 }));
    a.onBinary(Buffer.from('def'));
    expect(a.take('a')?.bytes.toString()).toBe('abcdef');
  });

  it('take() 之后同一个 id 不再有数据（不能重复交付）', () => {
    const a = new ChunkAssembler();
    a.onMeta(meta({ chunkIndex: 0 }));
    a.onBinary(Buffer.from('abc'));
    a.onMeta(meta({ chunkIndex: 1 }));
    a.onBinary(Buffer.from('def'));
    expect(a.take('a')).not.toBeNull();
    expect(a.take('a')).toBeNull();
  });
});
