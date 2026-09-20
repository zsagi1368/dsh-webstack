/**
 * W1b 守卫式 seam 四锁（TC-B4-W1b，W3-F1 缺陷处置验证面）。
 *
 * 背景：旧 peekService 走属性读+try/catch 吞错——真 cordis context proxy 对未声明
 * inject 的服务属性读**抛错**（reflect.ts get trap：`cannot get property "…"
 * without inject`），生产装载通道上全部可选 seam 静默降级（W3-F1：真 ToolRuntime
 * 在场而三工具零注册）。修形=双通道守卫式 seam（src/index.ts peekService 详注）：
 * ctx.get 优先（cordis 文档逃生门 "Read a service from the store without the
 * inject requirement"，strict 缺省 true=只解析 ACTIVE fiber 实现，返回
 * getTraceable 包装=注册面仍 fiber 托管）+ 属性读回退（plain-object mock 与
 * 真 Context 属性赋值假面兼容）。
 *
 * 锁谱（卡面四锁 + 增补锁⑤，增补申报见回执 §8 申报 #5）：
 * - 锁① 生产门控行为形：get 面 + 属性读抛错代理（reflect.ts 同签名）→ 三工具
 *   经 get seam 在注册面在场（mock 保真依据 = 仓内 cordis 4.0.1 fiber 内实测
 *   抛错/解析双语义，回执 §1.4 探针 A/B）；
 * - 锁② 回退兼容形：plain-object ctx（无 get 面）属性直读 → 注册面同样在场；
 *   附真 Context 属性赋值假面腿（get 面在场而 store 不可见 → 回退通道命中，
 *   申报偏差 #1 的保护通道显式锁）；
 * - 锁③ 负对照：旧属性读形制（c1b24d4 原文逐字复刻）在锁①同一 ctx 下经同一
 *   注册门 → 工具零注册（静默跳过复现）=判别力自证；附真 cordis fiber 腿
 *   （判别力非 Proxy mock 工件）；
 * - 锁④ 降级保持：ctx 无 tools 面（get 恒 undefined + 门控属性读抛错）→
 *   apply 不炸、web 双 provider 注册照走、加载标记照常（降级梯语义不变）；
 * - 锁⑤ 真 cordis fiber 机制重演（增补）：宿主 fiber provide('tools') + 真
 *   WebRuntime，webstack 插件本体以 inject=['web'] fiber 挂载 → 三工具在注册
 *   面在场。**非真宿主装载正证**（无 loader.create/真 ToolRuntime——该正证归
 *   主仓 ra1 webstack 腿，W3 re-pin 后翻绿；禁假绿自充）。
 *
 * 锁①③④ mock 形制与真 cordis get trap 语义同构：自有面（自有属性/mixin，
 * 含 get/inject/logger——真 Context 上三者恒直读安全，回执 §1.4 探针 B）放行，
 * 缺席键属性读抛同签名错。
 */
import { Context } from '@deepseek-ai/cordis';
import WebRuntime from '@deepseek-ai/dsh-web';
import { describe, expect, it } from 'vitest';
import {
  apply,
  assembleWebstack,
  Config,
  inject,
  name,
  type WebstackAssembly,
} from '../src/index.ts';

/** 三工具名有序谱（W-B-113/114 + F-113 + F-205 冻结面）。 */
const TOOL_NAMES = ['web_backend_status', 'web_batch_search', 'web_history'];

/** tools seam 假面：注册捕获（复刻注册副作用最小形，工具定义逐件入账）。 */
function fakeToolsFace(): { registered: Record<string, unknown>[]; face: Record<string, unknown> } {
  const registered: Record<string, unknown>[] = [];
  return {
    registered,
    face: {
      register: (definition: Record<string, unknown>): (() => void) => {
        registered.push(definition);
        return () => {};
      },
    },
  };
}

/** web seam 假面：双 provider 注册捕获（锁④「注册照走」观测面）。 */
function fakeWebFace(): {
  searchProviders: unknown[];
  fetchProviders: unknown[];
  face: Record<string, unknown>;
} {
  const searchProviders: unknown[] = [];
  const fetchProviders: unknown[] = [];
  return {
    searchProviders,
    fetchProviders,
    face: {
      registerSearchProvider: (provider: unknown): (() => void) => {
        searchProviders.push(provider);
        return () => {};
      },
      registerFetchProvider: (provider: unknown): (() => void) => {
        fetchProviders.push(provider);
        return () => {};
      },
    },
  };
}

/** logger 假面：加载标记捕获（装配全链可达尾证）。 */
function fakeLogger(): { lines: string[]; face: Record<string, unknown> } {
  const lines: string[] = [];
  return {
    lines,
    face: {
      info: (message: unknown): void => {
        lines.push(String(message));
      },
    },
  };
}

/**
 * cordis 同构门控 ctx（锁①③④ mock 形制）：自有面放行、缺席键属性读抛错——
 * reflect.ts get trap 门控行为复刻（同签名）。get/inject/logger 以自有面在场=
 * 保真要求（真 cordis 上三者为 mixin/实例自有面，fiber 内恒直读安全），非门控放松。
 */
function gatedCtx(opts: {
  get?: (name: string) => unknown;
  faces?: Record<string, unknown>;
}): Record<string, unknown> {
  const target: Record<string, unknown> = {
    get: opts.get ?? ((): undefined => undefined),
    // settings seam 消费面（cordis 自有 mixin 面）：no-op = 服务缺席回调不执行即降级。
    inject: (): void => {},
    ...opts.faces,
  };
  return new Proxy(target, {
    get(t, prop, receiver) {
      if (typeof prop === 'symbol' || prop in t) return Reflect.get(t, prop, receiver);
      throw new Error(`cannot get property "${String(prop)}" without inject`);
    },
  });
}

/** 修前旧形制逐字复刻（c1b24d4 src/index.ts:330-341 peekService 本体）——锁③负对照夹具。 */
function legacyPeekService(ctx: unknown, key: string): Record<string, unknown> | undefined {
  if (typeof ctx !== 'object' || ctx === null) return undefined;
  try {
    const value = (ctx as Record<string, unknown>)[key];
    return typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

describe('锁① 生产门控行为形：get 面 + 属性读抛错代理 → 三工具经 seam 在注册面在场', () => {
  it('apply 后三工具在 fakeTools 依序注册；同一 ctx 门控抛错同签名自证', () => {
    const tools = fakeToolsFace();
    const logger = fakeLogger();
    const ctx = gatedCtx({
      get: (service) => (service === 'tools' ? tools.face : undefined),
      faces: { logger: logger.face },
    });
    // mock 保真前置自证：未声明面属性直读 = reflect.ts 同签名抛错（锁③依赖同一门控形）。
    expect(() => ctx.tools).toThrowError('cannot get property "tools" without inject');
    expect(() => apply(ctx as unknown as Context, {})).not.toThrow();
    expect(tools.registered.map((d) => d.name)).toEqual(TOOL_NAMES);
    // 装配全链可达尾证：加载标记经 logger seam（get 无值→属性回退命中自有面）。
    expect(logger.lines.join('\n')).toContain('[webstack] loaded');
  });
});

describe('锁② 回退兼容形：plain-object ctx（无 get 面）属性直读 → 注册面同样在场', () => {
  it('plain-object mock：三工具注册（既有 mock 全谱兼容的显式锁）', () => {
    const tools = fakeToolsFace();
    const logger = fakeLogger();
    const ctx = {
      tools: tools.face,
      logger: logger.face,
      inject: (): void => {},
    };
    expect(() => apply(ctx as unknown as Context, {})).not.toThrow();
    expect(tools.registered.map((d) => d.name)).toEqual(TOOL_NAMES);
  });

  it('真 Context 属性赋值假面：get 面在场而 store 不可见 → 属性读回退通道命中（偏差 #1 保护）', () => {
    const tools = fakeToolsFace();
    const ctx = new Context();
    (ctx as unknown as Record<string, unknown>).tools = tools.face;
    // 拓扑自证（回执 §1.4 探针 A）：真 Context 有 get 面，但属性赋值假面不入 reflect store。
    expect(typeof ctx.get).toBe('function');
    expect(ctx.get('tools')).toBeUndefined();
    expect(() => assembleWebstack(ctx, {})).not.toThrow();
    expect(tools.registered.map((d) => d.name)).toEqual(TOOL_NAMES);
  });
});

describe('锁③ 负对照：旧属性读形制在抛错代理 ctx 下工具零注册（静默跳过复现=判别力自证）', () => {
  it('同一锁① ctx：旧形 seam→undefined→注册门零命中；新形对照三工具在场', () => {
    const tools = fakeToolsFace();
    const ctx = gatedCtx({
      get: (service) => (service === 'tools' ? tools.face : undefined),
      faces: { logger: fakeLogger().face },
    });
    // 旧形制（c1b24d4 逐字）：门控抛错被 try/catch 吞成 undefined——W3-F1 静默降级机制原样。
    const legacySeam = legacyPeekService(ctx, 'tools');
    expect(legacySeam).toBeUndefined();
    // 旧注册门（修前 src/index.ts:530 同款分支形）：零注册动作，注册面纯净。
    let legacyGateHits = 0;
    if (typeof legacySeam?.register === 'function') {
      legacyGateHits += 1;
      (legacySeam.register as (d: unknown) => void)({});
    }
    expect(legacyGateHits).toBe(0);
    expect(tools.registered).toHaveLength(0);
    // 对照腿：同一 ctx 过修后 apply → 三工具在场——新旧在同一面上判别成立，锁①非空洞。
    expect(() => apply(ctx as unknown as Context, {})).not.toThrow();
    expect(tools.registered.map((d) => d.name)).toEqual(TOOL_NAMES);
  });

  it('真 cordis fiber 腿：旧形制在真门控下同样静默跳过（判别力非 Proxy mock 工件）', async () => {
    const ctx = new Context();
    await ctx.plugin({
      name: 'tools-host-w1b-legacy',
      apply: (c) => {
        c.provide('tools', { register: (): (() => void) => () => {} });
      },
    });
    const legacyOutcome: unknown[] = ['unset'];
    await ctx.plugin({
      name: 'legacy-probe-w1b',
      apply: (c) => {
        legacyOutcome[0] = legacyPeekService(c, 'tools');
      },
    });
    // 旧形制在真 cordis fiber 内 = undefined（抛错被吞）：三工具零注册机制仓内原样复现。
    expect(legacyOutcome).toEqual([undefined]);
  });
});

describe('锁④ 降级保持：ctx 无 tools 面（get 恒 undefined）→ apply 不炸、web provider 注册照走', () => {
  it('降级梯语义不变：双 provider 注册 + tools 注册面零注册 + 加载标记照常', () => {
    const web = fakeWebFace();
    const logger = fakeLogger();
    // tools 假面存在但两通道均不可达（get 恒 undefined + 属性读门控抛错）=「无 tools 面」形。
    const tools = fakeToolsFace();
    const ctx = gatedCtx({
      get: () => undefined,
      faces: { web: web.face, logger: logger.face },
    });
    let assembly: WebstackAssembly | undefined;
    expect(() => {
      assembly = assembleWebstack(ctx as unknown as Context, {});
    }).not.toThrow();
    expect(web.searchProviders).toHaveLength(1);
    expect(web.fetchProviders).toHaveLength(1);
    expect(tools.registered).toHaveLength(0);
    expect(assembly?.tier).toBe('coexist');
    expect(assembly?.bridgeOnline).toBe(false);
    expect(logger.lines.join('\n')).toContain('[webstack] loaded');
  });
});

describe('锁⑤（增补）真 cordis fiber 机制重演：真 provide + 真 WebRuntime + 插件本体 fiber 挂载', () => {
  it("inject=['web'] 单声明的 webstack fiber 在宿主 provide 的 tools 服务下三工具达注册（非真宿主装载正证，正证归主仓 ra1）", async () => {
    const ctx = new Context();
    await ctx.plugin(WebRuntime, {});
    const tools = fakeToolsFace();
    await ctx.plugin({
      name: 'tools-host-w1b-mount',
      apply: (c) => {
        c.provide('tools', tools.face);
      },
    });
    // get 通道正例（回执 §1.4 探针 B 同形）：fiber 内不声明 inject 亦可解析 provided 服务。
    const getOutcome: unknown[] = ['unset'];
    await ctx.plugin({
      name: 'get-probe-w1b',
      apply: (c) => {
        getOutcome[0] = typeof c.get('tools');
      },
    });
    expect(getOutcome).toEqual(['object']);
    // webstack 插件本体 fiber 挂载（name/inject/Config/apply 真入口面，index-plugin.test.ts 同形）。
    const fiber = ctx.plugin({ name, inject, Config, apply }, {});
    await fiber;
    expect(tools.registered.map((d) => d.name)).toEqual(TOOL_NAMES);
  });
});
