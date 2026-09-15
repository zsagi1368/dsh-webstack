/**
 * TC-B2-23C 自证：verticals cordis 装配入口。
 *
 * 三层判据（对齐 B 卡第 3 条「tmpdir 复放 + 真 loader.create 等价自证」口径）：
 *  1. M-F1 静态判据——src barrel 与**构建产物 lib/index.js** 经 unwrapExports
 *     （`exports.default ?? exports`）归一后须命中「函数或带 `.apply` 的对象」；
 *  2. 真装载等价——直载落盘 lib 产物，喂给**真实 @deepseek-ai/cordis**
 *     `new Context().plugin(...)`（loader `_start → registry.plugin` 的同款
 *     消费面），断言 entry 装载不抛、`x-vertical` 服务可 resolve、canHandle
 *     正负例对在位（2.1b 同款三元判例）；
 *  3. tmpdir 复放——把 lib/index.js + 最小 package.json 拷入 mkdtemp 目录
 *     （模拟安装态落点）重跑同一判据，证明产物自包含、不依赖仓内路径解析。
 *
 * 附负例回归锁：纯 barrel（无 apply/default）在真 cordis 下必抛
 * `invalid plugin`——即 M-F6 记载的改动前形态，锁死契约不漂移。
 */
import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it, vi } from 'vitest';
import type { CordisContextLike } from '../src/cordis.ts';
import * as ns from '../src/cordis.ts';
import { apply, inject, name } from '../src/cordis.ts';
import type { SearchHints } from '../src/framework.ts';

/** 镜像 vendor/loader unwrapExports（ESM 无 __esModule interop 分支）。 */
function unwrap(exports: Record<string, unknown>): unknown {
  return exports.default ?? exports;
}

/** 2.1b 同款 canHandle 三元判例。 */
const HINTS_X: SearchHints = { hard: [], soft: [], siteFilter: 'x.com' };
const HINTS_OTHER: SearchHints = { hard: [], soft: [], siteFilter: 'example.com' };
const HINTS_EMPTY: SearchHints = { hard: [], soft: [] };

function fakeCtx(): CordisContextLike & {
  provide: ReturnType<typeof provideMock>;
  effect: ReturnType<typeof effectMock>;
} {
  return { provide: provideMock(), effect: effectMock() };
}

function provideMock() {
  return vi.fn<(name: string, service: unknown) => void>();
}
function effectMock() {
  return vi.fn<(teardown: () => unknown, label?: string) => unknown>();
}

describe('cordis 装配入口（src 层，M-F1 静态判据）', () => {
  it('barrel 归一后命中「函数或带 .apply 的对象」契约', () => {
    const unwrapped = unwrap(ns as unknown as Record<string, unknown>);
    expect(
      typeof unwrapped === 'function' ||
        typeof (unwrapped as { apply?: unknown }).apply === 'function',
    ).toBe(true);
  });

  it('name/inject 出口形状合规（registry.ts:322-323 消费面）', () => {
    expect(name).toBe('dsh-webstack-verticals');
    expect(inject).toEqual([]);
    expect(typeof apply).toBe('function');
  });

  it('apply 注册 x-vertical 服务并返回在位实例', () => {
    const ctx = fakeCtx();
    const service = apply(ctx);
    expect(ctx.provide).toHaveBeenCalledWith(
      'x-vertical',
      expect.objectContaining({ registry: expect.any(Object), channel: expect.any(Object) }),
    );
    expect(service?.canHandle(HINTS_X)).toBe(true);
    expect(service?.canHandle(HINTS_OTHER)).toBe(false);
    expect(service?.canHandle(HINTS_EMPTY)).toBe(false);
  });

  it('disposer 经 effect 登记且随 fiber 卸载摘除频道（setup 语义：返回值=disposer）', () => {
    const ctx = fakeCtx();
    const service = apply(ctx);
    expect(ctx.effect).toHaveBeenCalledWith(expect.any(Function), 'x-vertical-dispose');
    // effect setup 在 apply 期已执行且不得有副作用（频道仍在位）
    const setup = ctx.effect.mock.calls[0]?.[0] as () => () => void;
    expect(service?.registry.list()).toHaveLength(1);
    const teardown = setup();
    expect(() => teardown()).not.toThrow();
    expect(service?.registry.list()).toHaveLength(0);
  });

  it('config.enabled=false 时完全不注册（显式关闭位）', () => {
    const ctx = fakeCtx();
    expect(apply(ctx, { enabled: false })).toBeUndefined();
    expect(ctx.provide).not.toHaveBeenCalled();
  });

  it('缺 effect 面的裸 ctx 不抛（结构化 ctx 兼容）', () => {
    const bare = { provide: provideMock() };
    expect(() => apply(bare)).not.toThrow();
  });
});

describe('构建产物 lib/index.js：真 loader.create 等价自证 + tmpdir 复放', () => {
  const libUrl = new URL('../lib/index.js', import.meta.url).href;

  it('lib 产物 import 不抛、归一后含 .apply，且既有具名导出零破坏', async () => {
    const mod = (await import(libUrl)) as Record<string, unknown>;
    const unwrapped = unwrap(mod) as { apply?: unknown };
    expect(typeof unwrapped.apply).toBe('function');
    expect(mod.name).toBe('dsh-webstack-verticals');
    expect(mod.inject).toEqual([]);
    expect(mod.default).toBeUndefined(); // 纯 ESM barrel，loader 回落命名空间
    // 零破坏断言：改动前公开面逐名仍在位
    for (const kept of [
      'VerticalRegistry',
      'XVerticalChannel',
      'OEMBED_ENDPOINT',
      'OEMBED_MAX_BYTES',
      'VIA_OEMBED',
      'VIA_SITE_SEARCH',
      'X_OEMBED_NOTE_KEY',
      'X_VERTICAL_ID',
      'X_VERTICAL_DESCRIPTOR',
      'buildOembedUrl',
      'buildXSearchQuery',
      'extractTweetUrls',
      'freezeDeep',
      'isTweetUrl',
    ]) {
      expect(mod[kept], `named export ${kept}`).toBeDefined();
    }
  });

  it('真 cordis Context.plugin 装载 lib 产物：LOADED 且 x-vertical 服务 resolve、canHandle 正负例在位', async () => {
    const mod = (await import(libUrl)) as Record<string, unknown>;
    const ctx = new Context();
    try {
      await ctx.plugin(unwrap(mod) as Parameters<Context['plugin']>[0]);
      const service = (ctx as unknown as Record<string, unknown>)['x-vertical'] as {
        canHandle(hints: SearchHints): boolean;
      };
      expect(service).toBeDefined();
      expect(service.canHandle(HINTS_X)).toBe(true);
      expect(service.canHandle(HINTS_OTHER)).toBe(false);
      expect(service.canHandle(HINTS_EMPTY)).toBe(false);
    } finally {
      const stop = (ctx as unknown as { stop?: () => Promise<unknown> }).stop;
      if (typeof stop === 'function') await stop.call(ctx);
    }
  });

  it('负例回归锁：纯 barrel（无 apply/default）真 cordis 必抛 invalid plugin', async () => {
    const ctx = new Context();
    try {
      // 真 cordis registry 对非法形状是**同步抛**（`throw new Error('invalid plugin…')`
      // 发生于 plugin 入口解析处），故用同步 toThrow 断言。
      expect(() =>
        ctx.plugin(
          unwrap({ name: 'pure-barrel', VerticalRegistry: class {} }) as Parameters<
            Context['plugin']
          >[0],
        ),
      ).toThrow(/invalid plugin/);
    } finally {
      const stop = (ctx as unknown as { stop?: () => Promise<unknown> }).stop;
      if (typeof stop === 'function') await stop.call(ctx);
    }
  });

  it('tmpdir 复放：拷入 mkdtemp 安装态目录后同判据复验（产物自包含）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'verticals-replay-'));
    copyFileSync(new URL('../lib/index.js', import.meta.url), join(dir, 'index.js'));
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'dsh-webstack-verticals',
        version: '0.2.0',
        type: 'module',
        main: './index.js',
      }),
      'utf8',
    );
    const replayUrl = pathToFileURL(join(dir, 'index.js')).href;
    const mod = (await import(replayUrl)) as Record<string, unknown>;
    const unwrapped = unwrap(mod) as { apply?: unknown };
    expect(typeof unwrapped.apply).toBe('function');

    const ctx = new Context();
    try {
      await ctx.plugin(unwrapped as Parameters<Context['plugin']>[0]);
      const service = (ctx as unknown as Record<string, unknown>)['x-vertical'] as {
        canHandle(hints: SearchHints): boolean;
      };
      expect(service.canHandle(HINTS_X)).toBe(true);
      expect(service.canHandle(HINTS_EMPTY)).toBe(false);
    } finally {
      const stop = (ctx as unknown as { stop?: () => Promise<unknown> }).stop;
      if (typeof stop === 'function') await stop.call(ctx);
    }
  });
});
