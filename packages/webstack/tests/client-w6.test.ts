/**
 * TC-B4-W6 面③④⑤：client 半验证——slots 注入形状锁 / package.json dsh.client
 * 段三 inject 声明对照核验（只读不改）/ locale 字典注册面锁。
 *
 * 断言依据 = 亲读实际语义（禁臆测）：
 * - client/index.ts:114-245：apply(ctx) = ctx.effect 包两次 locale.register
 *   （label 'dsh-webstack: card/toggle dictionaries'，字典对象重载 {zh,en}，
 *   contract-webstack.md 表行 11=主线 dsh-client-locale/client/index.ts:380-381）
 *   → createSnapshotStore 视图（初始 readOnly:true/scopeStatus:'unbound'）→
 *   peekScopeBinder 结构探测 ctx.settingsScope（.bind 函数面）→ slots.inject
 *   两槽：'settings.plugin.item'（keyed，key=SETTINGS_NS='webstack'，locale=
 *   CARD_NS，inject→{hooks:{webstackCard},editField,save,discard}，组件=
 *   WebstackSettingsCard）与 'conversation.input.left'（id='webstack-online-mode'，
 *   order=30，locale=TOGGLE_NS，inject→{initial,requestChange}，组件=
 *   OnlineModeToggle）；requestChange 仅 scope writable&&status==='ready'&&
 *   视图非只读时接通，写 'mode.sessionOnline'（:218-241）。
 * - client/index.ts:47 `export const inject=['slots','locale']`（cordis 必需
 *   服务声明；settingsScope 软依赖不入清单，:46 注释）。
 * - package.json dsh.client 段实读：platform='web' + inject 三声明；
 *   tsdown.client.config.ts deps.neverBundle=true（全 external，宿主模块系统
 *   供给）。对照面=声明三包全部被 src/client 源文件真实 import（含 type-only）。
 * - 环境形制：node 环境零 DOM（client-ui.test.tsx 先例——本文件五面均纯形状/
 *   调用面断言，连渲染都不需要；不新造环境，无独立 config）。
 *
 * mock 形制：client ctx/locale/slots/settingsScope binder 全 class 基（this
 * 忠实）。零真实网络（无 fetch 面安装、无引擎执行；纯本地形状断言）。
 *
 * 负对照/判别对：面③=scope 三态判别（缺席 unbound 降级 / writable:false 只读 /
 * writable:true 写通——requestChange undefined vs 函数+写入透传）；面⑤=注册
 * 调用面与静态字典身份对照。**面④为纯形状锁（治理段只读核验），免坏孪生负
 * 对照——申报理由：package.json 治理段是冻结事实面，无法构造「坏 package.json」
 * 喂真实面；判别力由双向断言承载（三声明逐一被消费=无冗余 + 导出面/消费面
 * 实测登记=无漂移静默）。**
 */
import { readFileSync } from 'node:fs';
import type { Context as ClientContext } from '@deepseek-ai/cordis';
import { describe, expect, it } from 'vitest';
import * as clientHalf from '../src/client/index.ts';
import { OnlineModeToggle } from '../src/client/input-toggle.tsx';
import { CARD_NS, cardEn, cardZh, TOGGLE_NS, toggleEn, toggleZh } from '../src/client/locale.ts';
import { WebstackSettingsCard } from '../src/client/settings-card.tsx';

// ---------------------------------------------------------------------------
// class 基假 client 面（this 忠实）
// ---------------------------------------------------------------------------

class FakeLocale {
  readonly registered: { ns: string; dict: unknown }[] = [];
  register(ns: string, dict: unknown): () => void {
    this.registered.push({ ns, dict });
    return () => {};
  }
}

class FakeSlots {
  readonly injected: { name: string; factory: () => unknown }[] = [];
  readonly registered: { spec: Record<string, unknown>; component: unknown }[] = [];
  inject(name: string, factory: () => unknown): void {
    this.injected.push({ name, factory });
  }
  register(spec: Record<string, unknown>, component: unknown): () => void {
    this.registered.push({ spec, component });
    return () => {};
  }
}

class FakeClientCtx {
  readonly effectLabels: (string | undefined)[] = [];
  readonly locale = new FakeLocale();
  readonly slots = new FakeSlots();
  settingsScope: unknown;
  effect(fn: () => unknown, label?: string): () => void {
    this.effectLabels.push(label);
    const dispose = fn(); // cordis effect 语义：立即执行注册体并捕获清理函数
    return typeof dispose === 'function' ? (dispose as () => void) : () => {};
  }
}

/** 假 SettingsScope（getSnapshot/subscribe/set 三面，dsh-client-ui-settings 契约形）。 */
class FakeSettingsScope {
  readonly writes: { field: string; value: unknown }[] = [];
  private subscriber: (() => void) | undefined;
  constructor(
    private snapshot: { value: Record<string, unknown>; writable: boolean; status: string },
  ) {}
  getSnapshot(): { value: Record<string, unknown>; writable: boolean; status: string } {
    return this.snapshot;
  }
  subscribe(cb: () => void): () => void {
    this.subscriber = cb;
    return () => {
      this.subscriber = undefined;
    };
  }
  async set(field: string, value: unknown): Promise<void> {
    this.writes.push({ field, value });
  }
  pushSnapshot(next: { value: Record<string, unknown>; writable: boolean; status: string }): void {
    this.snapshot = next;
    this.subscriber?.(); // 订阅镜像同步（client syncFromScope 路径）
  }
}

/** 假 settingsScope binder（bind 是服务方法——class 基 this 忠实）。 */
class FakeScopeBinder {
  readonly binds: { namespace: string }[] = [];
  constructor(private readonly scope: FakeSettingsScope | undefined) {}
  bind(spec: { namespace: string }): unknown {
    this.binds.push(spec);
    if (this.scope === undefined) throw new Error('namespace not bound');
    return this.scope;
  }
}

function applyOn(ctx: FakeClientCtx): void {
  clientHalf.apply(ctx as unknown as ClientContext);
}

type SlotProps = Record<string, unknown>;

/** 触发指定槽的 inject 工厂并取回注册 spec 与组件。 */
function realizeSlot(
  ctx: FakeClientCtx,
  name: string,
): { spec: Record<string, unknown>; component: unknown } {
  const entry = ctx.slots.injected.find((x) => x.name === name);
  if (entry === undefined) throw new Error(`slot inject "${name}" not found`);
  entry.factory();
  const registered = ctx.slots.registered.find((x) => x.spec.name === name);
  if (registered === undefined) throw new Error(`slot register "${name}" not found`);
  return registered;
}

// ---------------------------------------------------------------------------
// 面③：slots 注入形状锁（settings.plugin.item + conversation.input.left）
// ---------------------------------------------------------------------------

describe('W6 面③ · slots settings.plugin.item 形状锁（keyed 寻址+组件身份+降级梯）', () => {
  it('正例：apply 注入两槽（序=卡先钮后）；settings.plugin.item 注册形制逐位锁', () => {
    const ctx = new FakeClientCtx();
    applyOn(ctx);
    expect(ctx.slots.injected.map((x) => x.name)).toEqual([
      'settings.plugin.item',
      'conversation.input.left',
    ]);
    const card = realizeSlot(ctx, 'settings.plugin.item');
    expect(card.spec.key).toBe('webstack'); // keyed 派发按设置命名空间寻址（client/index.ts:199-214）
    expect(card.spec.locale).toBe(CARD_NS);
    expect(card.component).toBe(WebstackSettingsCard); // 组件身份（非包装非副本）
    const props = (card.spec.inject as () => SlotProps)();
    expect(typeof props.editField).toBe('function');
    expect(typeof props.save).toBe('function');
    expect(typeof props.discard).toBe('function');
    const store = (props.hooks as Record<string, unknown>).webstackCard as {
      getSnapshot: () => Record<string, unknown>;
      subscribe: unknown;
      set: unknown;
    };
    expect(typeof store.getSnapshot).toBe('function'); // SnapshotStore 契约面
    expect(typeof store.subscribe).toBe('function');
    // 降级梯初始态（scope 缺席）：只读+unbound+默认形状基线。
    const view = store.getSnapshot();
    expect(view.readOnly).toBe(true);
    expect(view.scopeStatus).toBe('unbound');
    const machine = view.machine as { phase: string; committed: Record<string, unknown> };
    expect(machine.phase).toBe('clean');
    expect(machine.committed.layer).toBe('free'); // DEFAULT_SETTINGS 基线
    expect(machine.committed.maxResults).toBe(8);
  });

  it('正例：conversation.input.left 条目形制（id/order/locale/组件身份）+降级本地态', () => {
    const ctx = new FakeClientCtx();
    applyOn(ctx);
    const toggle = realizeSlot(ctx, 'conversation.input.left');
    expect(toggle.spec.id).toBe('webstack-online-mode');
    expect(toggle.spec.order).toBe(30);
    expect(toggle.spec.locale).toBe(TOGGLE_NS);
    expect(toggle.component).toBe(OnlineModeToggle);
    const props = (toggle.spec.inject as () => SlotProps)();
    expect(props.initial).toBeUndefined(); // scope 缺席 → 无注入初始态
    expect(props.requestChange).toBeUndefined(); // 写入通道未接通 = 会话内本地态
  });

  it('判别对（scope 三态）：缺席 unbound / writable:false 只读 / writable:true 写通——requestChange 红绿分明', () => {
    // 态二：scope 在场但不可写 → 视图只读、requestChange 仍不接通。
    const roScope = new FakeSettingsScope({
      value: { mode: { sessionOnline: 'on' } },
      writable: false,
      status: 'ready',
    });
    const roCtx = new FakeClientCtx();
    roCtx.settingsScope = new FakeScopeBinder(roScope);
    applyOn(roCtx);
    expect((roCtx.settingsScope as unknown as FakeScopeBinder).binds).toEqual([
      { namespace: 'webstack' },
    ]); // binder 按命名空间绑定
    const roCard = realizeSlot(roCtx, 'settings.plugin.item');
    const roView = (
      ((roCard.spec.inject as () => SlotProps)().hooks as Record<string, unknown>).webstackCard as {
        getSnapshot: () => Record<string, unknown>;
      }
    ).getSnapshot();
    expect(roView.readOnly).toBe(true); // writable:false → 只读位
    expect(roView.scopeStatus).toBe('ready');
    const roProps = (
      realizeSlot(roCtx, 'conversation.input.left').spec.inject as () => SlotProps
    )();
    expect(roProps.initial).toBe('on'); // 初始态仍从快照注入
    expect(roProps.requestChange).toBeUndefined(); // 只读 → 写通道关闭（红腿面）

    // 态三：可写 scope → 视图开放 + requestChange 接通且写入透传 mode.sessionOnline。
    const rwScope = new FakeSettingsScope({
      value: { mode: { sessionOnline: 'off' } },
      writable: true,
      status: 'ready',
    });
    const rwCtx = new FakeClientCtx();
    rwCtx.settingsScope = new FakeScopeBinder(rwScope);
    applyOn(rwCtx);
    const rwCard = realizeSlot(rwCtx, 'settings.plugin.item');
    const rwView = (
      ((rwCard.spec.inject as () => SlotProps)().hooks as Record<string, unknown>).webstackCard as {
        getSnapshot: () => Record<string, unknown>;
      }
    ).getSnapshot();
    expect(rwView.readOnly).toBe(false); // 绿腿：可写翻转只读位
    const rwProps = (
      realizeSlot(rwCtx, 'conversation.input.left').spec.inject as () => SlotProps
    )();
    expect(rwProps.initial).toBe('off');
    const requestChange = rwProps.requestChange as (next: string) => boolean;
    expect(typeof requestChange).toBe('function');
    expect(requestChange('ask')).toBe(true);
    expect(rwScope.writes).toEqual([{ field: 'mode.sessionOnline', value: 'ask' }]); // 写通道透传锁
  });
});

// ---------------------------------------------------------------------------
// 面④：package.json dsh.client 段三 inject 声明对照核验（只读不改）
// ---------------------------------------------------------------------------

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  dsh?: { client?: { platform?: string; inject?: readonly string[] } };
};

const CLIENT_FILES = [
  'index.ts',
  'locale.ts',
  'settings-card.tsx',
  'input-toggle.tsx',
  'draft-state.ts',
];

/** src/client 五文件的全部 @deepseek-ai import 包根集合（含 type-only；子路径归并）。 */
function consumedClientPackages(): Set<string> {
  const pkgs = new Set<string>();
  for (const file of CLIENT_FILES) {
    const source = readFileSync(new URL(`../src/client/${file}`, import.meta.url), 'utf8');
    for (const match of source.matchAll(/from\s+'(@deepseek-ai\/[^']+)'/g)) {
      const segments = (match[1] ?? '').split('/');
      pkgs.add(segments.slice(0, 2).join('/'));
    }
  }
  return pkgs;
}

describe('W6 面④ · dsh.client 段三 inject 声明核验（治理段入库锁化防回归，W2 先例）', () => {
  it('段实读：platform=web + inject 恰三声明（序=段原文，多一少一即红）', () => {
    expect(pkg.dsh?.client?.platform).toBe('web');
    expect(pkg.dsh?.client?.inject).toEqual([
      '@deepseek-ai/dsh-client-ui-slots',
      '@deepseek-ai/dsh-client-ui-conversation',
      '@deepseek-ai/dsh-client-locale',
    ]);
  });

  it('对照面：三声明逐一被 src/client 真实 import（无冗余声明）；导出面 apply/inject 形状锁', () => {
    const consumed = consumedClientPackages();
    for (const declared of pkg.dsh?.client?.inject ?? []) {
      expect(consumed.has(declared), `declared-but-unconsumed: ${declared}`).toBe(true);
    }
    // 导出面对照（W2 治理段入库时的 src/client/index.ts 导出面）：
    expect(typeof clientHalf.apply).toBe('function'); // client 组合入口
    expect(clientHalf.inject).toEqual(['slots', 'locale']); // cordis 必需服务声明（软依赖不入清单）
    // 对照差实测登记（只读核验不判不改，回执偏差清单同步）：运行期 external 面
    // 另有 dsh-client-store（neverBundle=true 全 external，宿主模块系统供给，
    // tsdown.client.config.ts 注释）与 renderer/settings/conversation 的 type-only
    // 子路径消费——三声明是宿主注入清单非 external 全集，差额归主线 loader 面（U-1）。
    expect(consumed.has('@deepseek-ai/dsh-client-store')).toBe(true); // 运行期消费实测在案
    expect(consumed.has('@deepseek-ai/dsh-client-ui-renderer')).toBe(true); // type-only 消费实测在案
    expect(consumed.has('@deepseek-ai/dsh-client-ui-settings')).toBe(true); // type-only 消费实测在案
  });
});

// ---------------------------------------------------------------------------
// 面⑤：locale 字典注册锁（注册调用面；静态键集奇偶既有 client-ui.test.tsx 已锁）
// ---------------------------------------------------------------------------

describe('W6 面⑤ · locale 字典注册锁（apply 链注册调用面+zh/en 键集一致）', () => {
  it('正例：两次 register 走 effect 包裹（label 锁）；ns/字典对象身份逐位对照', () => {
    const ctx = new FakeClientCtx();
    applyOn(ctx);
    // effect 包裹形制（cordis 生命周期面）：两字典注册各占一个 effect，label 锁。
    expect(ctx.effectLabels.slice(0, 2)).toEqual([
      'dsh-webstack: card dictionaries',
      'dsh-webstack: toggle dictionaries',
    ]);
    // 注册调用面：字典对象重载 (ns, {zh,en})——contract-webstack.md 表行 11 形制。
    expect(ctx.locale.registered).toHaveLength(2);
    const [card, toggle] = ctx.locale.registered as {
      ns: string;
      dict: { zh: unknown; en: unknown };
    }[];
    expect(card!.ns).toBe('webstack.card'); // CARD_NS 常量值
    expect(toggle!.ns).toBe('webstack.toggle'); // TOGGLE_NS 常量值
    expect(card!.ns).toBe(CARD_NS);
    expect(toggle!.ns).toBe(TOGGLE_NS);
    expect(card!.dict.zh).toBe(cardZh); // 字典身份传递（非副本）
    expect(card!.dict.en).toBe(cardEn);
    expect(toggle!.dict.zh).toBe(toggleZh);
    expect(toggle!.dict.en).toBe(toggleEn);
  });

  it('注册载荷键集一致：每次注册的 zh/en 键集全等且值全非空串（注册面复核腿）', () => {
    const ctx = new FakeClientCtx();
    applyOn(ctx);
    for (const { dict } of ctx.locale.registered as {
      dict: { zh: Record<string, string>; en: Record<string, string> };
    }[]) {
      const zhKeys = Object.keys(dict.zh).sort();
      const enKeys = Object.keys(dict.en).sort();
      expect(zhKeys.length).toBeGreaterThan(0);
      expect(zhKeys).toEqual(enKeys); // 奇偶一致（类型 Record<Key,string> 静态保证的运行期复核）
      for (const key of zhKeys) {
        expect(dict.zh[key]!.length).toBeGreaterThan(0);
        expect(dict.en[key]!.length).toBeGreaterThan(0);
      }
    }
  });
});
