/**
 * TC-B4-W5 锁组②：回退+冷却行为锁——注册序=候选序（src/index.ts:251-262 头注
 * 「注册序即 fallback 候选序」语义锁）+ 单引擎失败→下一候选接管 + 冷却窗内外
 * 行为差判别对（fake timers 形制，FileHub RA1d 锁 A 先例）。
 *
 * 断言依据 = 亲读实际语义（禁臆测）：
 * - registry.ts:104-201：register 序=Map 插入序=listIds/candidates 序；
 *   runWithFallback 成功**不停链**（continue 收集全部候选命中，供融合），
 *   non-retryable 失败换下一候选，terminal（aborted/ssrf-blocked）立即整场
 *   终止 rethrow；显式 ids 保序、未知 id 安全跳过；候选全冷却 → 闭集
 *   `cooldown/all-cooling`；尝试过全败 → rethrow 最后错误。
 * - 冷却窗：rate-limited → `retryAfterMs ?? RATE_LIMIT_COOLDOWN_MS(60s)`、
 *   quota → `?? QUOTA_COOLDOWN_MS(300s)`；rate-limited/quota 走冷却分支
 *   **不做同候选重试**（registry.ts:286-295 先于 retryable 分支 return）；
 *   `inCooldown = Date.now() < cooldownUntil`——**窗沿（now===until）已出窗**；
 *   窗内候选剔除+闭集 warning 键（ddg→webstack.engine.ddg.degraded）；
 *   成功清 lastCode（statusSnapshot 回 ok）。
 * - Date.now+setTimeout 双源全落 fake timers 控制面（vi.useFakeTimers 默认
 *   含 Date toFake）——窗内/窗外/窗沿三点判别对零真实等待。
 *
 * 负对照形制（零改源）：terminal 不接管腿（红）vs non-retryable 接管腿（绿）
 * 同表对照；「无剔除坏孪生」（窗内直接重触引擎）与真注册表（窗内零触达）
 * 在同一 noRetouch 谓词下红绿分明。真引擎接管腿（DdgEngine 429 → BingLite
 * 接管）走 class 基白名单 fetch 桩——白名单外 URL 响亮抛=零真实外呼自证。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}));

import { BaseEngine, KEYED_ENGINE_IDS } from '../src/engines/engine.ts';
import { buildEngineRegistry } from '../src/index.ts';
import { engineError } from '../src/kernel/errors.ts';
import {
  EngineRegistry,
  QUOTA_COOLDOWN_MS,
  RATE_LIMIT_COOLDOWN_MS,
  RETRY_BACKOFF_MS,
} from '../src/kernel/registry.ts';
import type {
  EngineDescriptor,
  EngineSearchRequest,
  EngineSearchResponse,
  McpServerEntry,
  NormalizedHit,
} from '../src/kernel/types.ts';

// ---------------------------------------------------------------------------
// 夹具与 class 基假引擎（this 忠实，extends BaseEngine 走真 runSearch 包装）
// ---------------------------------------------------------------------------

const REQ: EngineSearchRequest = {
  query: 'w5 fallback',
  hints: { hard: [], soft: [] },
  count: 5,
  layer: 'free',
  band: 'simple',
};
const REQ_API: EngineSearchRequest = { ...REQ, layer: 'api' };

const hit = (url: string, engine: string): NormalizedHit => ({
  url,
  title: url,
  provenance: { engine },
});

/** 脚本化假引擎：按注入脚本取数；calls 计数=触达观测点（不触任何真实管道）。 */
class ScriptedEngine extends BaseEngine {
  calls = 0;
  constructor(
    descriptor: EngineDescriptor,
    private readonly script: (req: EngineSearchRequest) => Promise<NormalizedHit[]>,
  ) {
    super(descriptor);
  }
  async search(req: EngineSearchRequest): Promise<EngineSearchResponse> {
    this.calls++;
    return await this.runSearch(req, () => this.script(req));
  }
}

let seq = 0;
function fakeDescriptor(overrides: Partial<EngineDescriptor> = {}): EngineDescriptor {
  seq++;
  return {
    id: overrides.id ?? `w5-fake-${seq}`,
    kind: 'search',
    tier: overrides.tier ?? 'free',
    caps: {},
    cost: { keysRequired: 0 },
    latencyBudgetMs: 50,
    ...overrides,
  };
}

/** class 基 fetch 桩（this 忠实）：URL 白名单路由；白名单外响亮抛（零外呼自证）。 */
class FetchStub {
  readonly calls: string[] = [];
  constructor(private readonly routes: Readonly<Record<string, () => Response>> = {}) {}
  readonly fetch = async (url: string | URL): Promise<Response> => {
    const raw = String(url);
    this.calls.push(raw);
    for (const [prefix, make] of Object.entries(this.routes)) {
      if (raw.startsWith(prefix)) return make();
    }
    throw new Error(`[zero-network guard] unexpected outbound URL: ${raw}`);
  };
}

let installed = false;
afterEach(() => {
  if (installed) {
    vi.unstubAllGlobals();
    installed = false;
  }
});

const BING_RSS =
  '<rss><channel><item><title>W5 Bing Hit</title><link>https://w5.example/bing</link>' +
  '<description>rss snippet</description></item></channel></rss>';

// ---------------------------------------------------------------------------
// 注册序 = 候选序（index.ts:251-262 头注语义锁）
// ---------------------------------------------------------------------------

describe('W5 锁组② · 注册序=候选序（fallback 候选序的单一事实源）', () => {
  it('全矩阵注册序锁：免费池→searxng→keyed 六家→native→mcp（配置序）', () => {
    const mcpEntry: McpServerEntry = {
      id: 'g1',
      transport: 'http',
      url: 'https://mcp.example/sse',
    };
    const { registry } = buildEngineRegistry({
      searxngBaseUrl: 'https://searx.example.org',
      mcpServers: [mcpEntry],
    });
    expect(registry.listIds()).toEqual([
      'ddg',
      'bing-lite',
      'searxng',
      'tavily',
      'brave',
      'exa',
      'jina',
      'firecrawl',
      'anysearch',
      'native',
      'mcp-g1',
    ]);
    // 层候选=注册序过滤投影（W-B-11）。
    expect(registry.candidates('free').map((e) => e.descriptor.id)).toEqual(['ddg', 'bing-lite']);
    expect(registry.candidates('api').map((e) => e.descriptor.id)).toEqual([...KEYED_ENGINE_IDS]);
    expect(registry.candidates('selfhosted').map((e) => e.descriptor.id)).toEqual(['searxng']);
    expect(registry.candidates('native').map((e) => e.descriptor.id)).toEqual(['native']);
    expect(registry.candidates('mcp').map((e) => e.descriptor.id)).toEqual(['mcp-g1']);
  });

  it('缺省候选=注册序消费：执行序与 attempts 序恒等注册序（成功不停链，收集全部命中）', async () => {
    const registry = new EngineRegistry();
    const order: string[] = [];
    const a = new ScriptedEngine(fakeDescriptor({ id: 'w5-a' }), async () => {
      order.push('w5-a');
      return [hit('https://a.example/1', 'w5-a')];
    });
    const b = new ScriptedEngine(fakeDescriptor({ id: 'w5-b' }), async () => {
      order.push('w5-b');
      return [hit('https://b.example/1', 'w5-b')];
    });
    registry.register(a);
    registry.register(b);
    const res = await registry.runWithFallback(REQ); // 缺省 candidates(free)=注册序 [a,b]
    expect(order).toEqual(['w5-a', 'w5-b']); // 消费序=注册序（亲读：成功 continue 不停链）
    expect(res.attempts.map((x) => x.engineId)).toEqual(['w5-a', 'w5-b']);
    expect(res.hits.map((h) => h.url)).toEqual(['https://a.example/1', 'https://b.example/1']);
  });

  it('显式 ids 序即执行序；未知 id 安全跳过（不抛不缺位）', async () => {
    const registry = new EngineRegistry();
    const a = new ScriptedEngine(fakeDescriptor({ id: 'w5-a' }), async () => [
      hit('https://a.example/1', 'w5-a'),
    ]);
    const b = new ScriptedEngine(fakeDescriptor({ id: 'w5-b' }), async () => [
      hit('https://b.example/1', 'w5-b'),
    ]);
    registry.register(a);
    registry.register(b);
    const res = await registry.runWithFallback(REQ, ['ghost', 'w5-b', 'w5-a']);
    expect(res.attempts.map((x) => x.engineId)).toEqual(['w5-b', 'w5-a']); // ghost 静默跳过
    expect(a.calls).toBe(1);
    expect(b.calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 单引擎失败 → 下一候选接管（含 terminal 不接管判别对）
// ---------------------------------------------------------------------------

describe('W5 锁组② · 失败接管（non-retryable 换候选 vs terminal 整场终止）', () => {
  it('绿腿：首候选 auth（non-retryable）→ 下一候选接管出命中，失败留痕不传染', async () => {
    const registry = new EngineRegistry();
    const bad = new ScriptedEngine(fakeDescriptor({ id: 'w5-bad' }), async () => {
      throw engineError('auth', 'no key', { engineId: 'w5-bad' });
    });
    const good = new ScriptedEngine(fakeDescriptor({ id: 'w5-good' }), async () => [
      hit('https://good.example/1', 'w5-good'),
    ]);
    registry.register(bad);
    registry.register(good);
    const res = await registry.runWithFallback(REQ, ['w5-bad', 'w5-good']);
    expect(res.hits.map((h) => h.url)).toEqual(['https://good.example/1']); // 接管成功
    expect(res.attempts.map((x) => x.outcome)).toEqual(['auth', 'ok']); // 失败留痕在审计轨迹
    expect(bad.calls).toBe(1); // non-retryable 不同候选重试（auth 非 retryable 分类）
    expect(good.calls).toBe(1);
  });

  it('红腿（判别对）：terminal（aborted）立即整场终止——后续候选零触达、不接管', async () => {
    const registry = new EngineRegistry();
    const aborter = new ScriptedEngine(fakeDescriptor({ id: 'w5-abort' }), async () => {
      throw engineError('aborted', 'caller gone', { engineId: 'w5-abort' });
    });
    const good = new ScriptedEngine(fakeDescriptor({ id: 'w5-good2' }), async () => [
      hit('https://good.example/2', 'w5-good2'),
    ]);
    registry.register(aborter);
    registry.register(good);
    await expect(registry.runWithFallback(REQ, ['w5-abort', 'w5-good2'])).rejects.toMatchObject({
      name: 'EngineError',
      code: 'aborted', // terminal rethrow 原样（W-B-42）
    });
    expect(good.calls).toBe(0); // 不接管=红腿面（与 non-retryable 绿腿同表对照）
  });

  it('真引擎接管腿（装配位+mock fetch 面）：真 Ddg 429 → 冷却 → 真 BingLite 接管出命中', async () => {
    const stub = new FetchStub({
      'https://html.duckduckgo.com/': () => new Response('', { status: 429 }),
      'https://www.bing.com/': () => new Response(BING_RSS, { status: 200 }),
    });
    vi.stubGlobal('fetch', stub.fetch);
    installed = true;
    const { registry } = buildEngineRegistry({}); // 真装配位产出的真引擎
    const res = await registry.runWithFallback(REQ); // 缺省候选=[ddg, bing-lite]
    expect(res.hits.map((h) => h.url)).toEqual(['https://w5.example/bing']);
    expect(res.hits[0]?.provenance.engine).toBe('bing-lite'); // 接管者盖章
    expect(res.attempts.map((x) => x.engineId)).toEqual(['ddg', 'bing-lite']);
    expect(res.attempts.map((x) => x.outcome)).toEqual(['rate-limited', 'ok']);
    expect(res.warnings).toContain('webstack.engine.ddg.degraded'); // 闭集 warning 键
    expect(registry.inCooldown('ddg')).toBe(true); // 429→rate-limited→60s 窗（衔接冷却组）
    // 零真实外呼自证：全部出站 URL 落白名单两端点。
    expect(
      stub.calls.every(
        (u) =>
          u.startsWith('https://html.duckduckgo.com/') || u.startsWith('https://www.bing.com/'),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 冷却窗内外判别对（fake timers；FileHub RA1d 锁 A 形制）
// ---------------------------------------------------------------------------

const T0 = 1_800_000_000_000;

/** 谓词：窗内引擎零再触达（冷却剔除生效的唯一可观测判据）。 */
const noRetouchInsideWindow = (callsDelta: number): boolean => callsDelta === 0;

describe('W5 锁组② · 冷却窗内外判别对（fake timers，零真实等待）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('窗值常量锁：60s/300s/250ms（源侧单一事实源）', () => {
    expect(RATE_LIMIT_COOLDOWN_MS).toBe(60_000);
    expect(QUOTA_COOLDOWN_MS).toBe(300_000);
    expect(RETRY_BACKOFF_MS).toBe(250);
  });

  it('rate-limited 默认 60s 窗：窗内剔除（all-cooling/零重试）、窗沿即出窗、窗外重试成功', async () => {
    const registry = new EngineRegistry();
    let fail = true;
    const engine = new ScriptedEngine(fakeDescriptor({ id: 'w5-rl' }), async () => {
      if (fail) throw engineError('rate-limited', '429', { engineId: 'w5-rl' });
      return [hit('https://rl.example/1', 'w5-rl')];
    });
    registry.register(engine);

    // t0：首跑失败入窗（单候选 → rethrow 最后错误 rate-limited）。
    await expect(registry.runWithFallback(REQ, ['w5-rl'])).rejects.toMatchObject({
      code: 'rate-limited',
    });
    expect(engine.calls).toBe(1);
    expect(registry.statusSnapshot()['w5-rl']).toMatchObject({
      state: 'cooldown',
      cooldownUntil: T0 + RATE_LIMIT_COOLDOWN_MS,
      lastCode: 'rate-limited',
    });

    // 窗内（t0+59_999）：剔除 → 闭集 all-cooling；引擎零触达。
    vi.advanceTimersByTime(RATE_LIMIT_COOLDOWN_MS - 1);
    expect(registry.inCooldown('w5-rl')).toBe(true);
    await expect(registry.runWithFallback(REQ, ['w5-rl'])).rejects.toMatchObject({
      code: 'cooldown',
      detail: 'all-cooling',
    });
    expect(engine.calls).toBe(1); // 窗内零重试（rate-limited 不同候选重试，registry.ts:286-290 亲读）

    // 窗沿（now===cooldownUntil）：`now < until` 为假 → 已出窗（边界语义锁）。
    vi.advanceTimersByTime(1);
    expect(registry.inCooldown('w5-rl')).toBe(false);
    fail = false;
    const res = await registry.runWithFallback(REQ, ['w5-rl']);
    expect(res.hits).toHaveLength(1); // 窗外立即重试成功
    expect(engine.calls).toBe(2);
    expect(registry.statusSnapshot()['w5-rl']).toEqual({ state: 'ok' }); // 成功清失败码
  });

  it('负对照（判别力自证）：无剔除孪生窗内再触达——noRetouch 谓词红绿分明', async () => {
    const registry = new EngineRegistry();
    let first = true;
    const engine = new ScriptedEngine(fakeDescriptor({ id: 'w5-twin' }), async () => {
      if (first) {
        first = false;
        throw engineError('rate-limited', '429', { engineId: 'w5-twin' });
      }
      return [hit('https://twin.example/1', 'w5-twin')];
    });
    registry.register(engine);
    await expect(registry.runWithFallback(REQ, ['w5-twin'])).rejects.toMatchObject({
      code: 'rate-limited',
    });
    vi.advanceTimersByTime(1000); // 窗内任意点

    // 真注册表：窗内 runWithFallback 零触达（剔除生效）。
    const realBefore = engine.calls;
    await expect(registry.runWithFallback(REQ, ['w5-twin'])).rejects.toMatchObject({
      code: 'cooldown',
    });
    const realDelta = engine.calls - realBefore;

    // 坏孪生：不查冷却状态直接重调引擎（建模「冷却窗失效」缺陷面）——窗内再触达。
    const twinBefore = engine.calls;
    await engine.search(REQ);
    const twinDelta = engine.calls - twinBefore;

    expect(noRetouchInsideWindow(realDelta)).toBe(true); // 绿：真实现窗内零触达
    expect(twinDelta).toBe(1);
    expect(noRetouchInsideWindow(twinDelta)).toBe(false); // 红：同谓词孪生立即为假
  });

  it('quota 默认 300s 窗 + retryAfterMs 服务端指示优先（窗值判别对）', async () => {
    // quota 默认窗：t0+299_999 窗内、t0+300_000 窗沿出窗。
    const registry = new EngineRegistry();
    const drained = new ScriptedEngine(fakeDescriptor({ id: 'w5-q' }), async () => {
      throw engineError('quota', 'exhausted', { engineId: 'w5-q' });
    });
    registry.register(drained);
    await expect(registry.runWithFallback(REQ, ['w5-q'])).rejects.toMatchObject({ code: 'quota' });
    expect(registry.statusSnapshot()['w5-q']?.cooldownUntil).toBe(T0 + QUOTA_COOLDOWN_MS);
    vi.advanceTimersByTime(QUOTA_COOLDOWN_MS - 1);
    expect(registry.inCooldown('w5-q')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(registry.inCooldown('w5-q')).toBe(false);

    // retryAfterMs 优先：1234ms 指示 → 窗值=当前时刻+1234（非默认 60s）。
    const base = T0 + QUOTA_COOLDOWN_MS; // 前段已推进到 quota 窗沿
    const hinted = new ScriptedEngine(fakeDescriptor({ id: 'w5-ra' }), async () => {
      throw engineError('rate-limited', 'slow', { engineId: 'w5-ra', retryAfterMs: 1234 });
    });
    registry.register(hinted);
    await expect(registry.runWithFallback(REQ, ['w5-ra'])).rejects.toMatchObject({
      code: 'rate-limited',
    });
    expect(registry.statusSnapshot()['w5-ra']?.cooldownUntil).toBe(base + 1234);
    vi.advanceTimersByTime(1233);
    expect(registry.inCooldown('w5-ra')).toBe(true); // 窗内
    vi.advanceTimersByTime(1);
    expect(registry.inCooldown('w5-ra')).toBe(false); // 窗沿出窗
  });

  it('部分候选冷却不停摆：冷却者剔除+闭集 warning 键，健康候选照常执行', async () => {
    const registry = new EngineRegistry();
    const cooling = new ScriptedEngine(fakeDescriptor({ id: 'ddg' }), async () => {
      throw engineError('rate-limited', '429', { engineId: 'ddg' });
    });
    const healthy = new ScriptedEngine(fakeDescriptor({ id: 'bing-lite' }), async () => [
      hit('https://h.example/1', 'bing-lite'),
    ]);
    registry.register(cooling);
    registry.register(healthy);
    await expect(registry.runWithFallback(REQ, ['ddg'])).rejects.toMatchObject({
      code: 'rate-limited',
    }); // ddg 入窗
    const res = await registry.runWithFallback(REQ, ['ddg', 'bing-lite']);
    expect(res.hits.map((h) => h.url)).toEqual(['https://h.example/1']); // 健康候选接管
    expect(res.warnings).toEqual(['webstack.engine.ddg.degraded']); // 闭集键（registry.ts:338-339）
    expect(cooling.calls).toBe(1); // 窗内零触达
    expect(healthy.calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// api 层装配位回退穷尽（衔接锁组③语义：六家全 auth → 最后错误 rethrow）
// ---------------------------------------------------------------------------

describe('W5 锁组② · 装配位回退穷尽（keyed 层无凭据全败形制）', () => {
  it('api 层缺省候选=六家注册序；全 auth 败 → rethrow 最后错误且零外呼', async () => {
    const stub = new FetchStub({}); // 无路由：任何出站即响亮抛（本腿期望零触达）
    vi.stubGlobal('fetch', stub.fetch);
    installed = true;
    const { registry } = buildEngineRegistry({});
    await expect(registry.runWithFallback(REQ_API)).rejects.toMatchObject({
      name: 'EngineError',
      code: 'auth',
    });
    expect(stub.calls).toHaveLength(0); // 缺键先于出站——零真实外呼自证
    const attempted = [...KEYED_ENGINE_IDS].map((id) => registry.recentAttempts(id)[0]?.outcome);
    expect(attempted).toEqual(Array.from({ length: 6 }, () => 'auth')); // 六家注册序全试全败
  });
});
