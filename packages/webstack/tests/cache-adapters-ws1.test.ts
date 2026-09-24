/**
 * TC-B4-WS1 F6（SECURITY-B4-D1a）：FilePersistenceAdapter.set 权限位判别锁。
 * vi.mock('node:fs/promises') 捕获调用参数（POSIX 形制模拟）：mode 位在
 * win32 宿主被内核忽略、真 tmpdir 读不回，故判别面=调用形本身——
 * mkdir `{recursive:true, mode:0o700}` / writeFile `{encoding:'utf8', mode:0o600}`
 * 精确断言；任何人删 mode、改宽权限位或回退字符串第三参旧形，本锁必红。
 * 真实 fs 往返语义（set/get/过期/静默降级）由既有 cache-adapters.test.ts
 * 真 tmpdir 腿覆盖，两锁互补不重叠。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fsMock = vi.hoisted(() => ({
  mkdir: vi.fn(async () => undefined),
  writeFile: vi.fn(async () => undefined),
  readFile: vi.fn(async () => {
    throw new Error('readFile not used on the set path');
  }),
  rm: vi.fn(async () => undefined),
}));
vi.mock('node:fs/promises', () => fsMock);

import { FilePersistenceAdapter } from '../src/cache/adapters.ts';

describe('WS1-F6 · 缓存写盘权限位（POSIX 多用户面）', () => {
  beforeEach(() => {
    for (const fn of Object.values(fsMock)) fn.mockClear();
  });

  it('mkdir 携带 mode 0o700 + recursive（精确形：缺 mode/宽权限位必红）', async () => {
    const adapter = new FilePersistenceAdapter('/fake/ws-cache');
    await adapter.set('search:k1', { hits: [] }, 60_000);
    expect(fsMock.mkdir).toHaveBeenCalledTimes(1);
    const [, opts] = fsMock.mkdir.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(opts).toEqual({ recursive: true, mode: 0o700 });
  });

  it('writeFile 携带 mode 0o600 + utf8 对象形（字符串第三参旧形必红），信封 JSON 语义不变', async () => {
    const adapter = new FilePersistenceAdapter('/fake/ws-cache');
    await adapter.set('search:k2', { hits: [{ url: 'https://a.example' }] }, 30_000);
    expect(fsMock.writeFile).toHaveBeenCalledTimes(1);
    const [file, body, opts] = fsMock.writeFile.mock.calls[0] as unknown as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(typeof opts).toBe('object'); // 旧形 `'utf8'` 字符串第三参在此必红
    expect(opts).toEqual({ encoding: 'utf8', mode: 0o600 });
    // 既有语义零变化：分桶文件路径 + 信封三键（value/storedAt/ttlMs）。
    expect(file.endsWith('.json')).toBe(true);
    const envelope = JSON.parse(body) as Record<string, unknown>;
    expect(envelope).toMatchObject({
      value: { hits: [{ url: 'https://a.example' }] },
      ttlMs: 30_000,
    });
    expect(typeof envelope.storedAt).toBe('number');
  });

  it('权限位故障不放大：mkdir 抛错仍静默降级（F6 加固不破坏「缓存层故障绝不抛」契约）', async () => {
    fsMock.mkdir.mockRejectedValueOnce(Object.assign(new Error('EPERM'), { code: 'EPERM' }));
    const adapter = new FilePersistenceAdapter('/fake/ws-cache');
    await expect(adapter.set('search:k3', 'v', 1_000)).resolves.toBeUndefined();
  });
});
