/**
 * 聚合器端到端（离线）：假引擎注入 registry + vi.mock 假出站客户端。
 * 覆盖：free 层单引擎直出、双引擎 RRF 去重保首见原样 URL、缓存二次命中零网络
 * 调用、fallback 链 terminal 终止语义、fetch 404 数据化 + SSRF 拒绝透传。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BaseEngine } from '../src/engines/engine.ts';
import { type AggregatorSnapshot, WebstackAggregator } from '../src/kernel/aggregator.ts';
import { engineError } from '../src/kernel/errors.ts';
import { EngineRegistry } from '../src/kernel/registry.ts';
import type {
  EngineDescriptor,
  EngineSearchRequest,
  EngineSearchResponse,
  NormalizedHit,
} from '../src/kernel/types.ts';

// ---------------------------------------------------------------------------
// 出站客户端替身：vi.mock 拦截动态导入路径（fetch 管线经此下网络）。
// ---------------------------------------------------------------------------
const outboundMock = vi.hoisted(() => ({ impl: undefined as unknown }));
vi.mock('../src/safety/outbound.ts', () => ({
  get outboundFetch(): unknown {
    return outboundMock.impl;
  },
}));

/** 脚本化假引擎：不触安全管道，纯本地取数，调用计数供缓存/降级断言。 */
class ScriptedEngine extends BaseEngine {
  calls = 0;
  lastReq: EngineSearchRequest | undefined;
  constructor(
    descriptor: EngineDescriptor,
    private readonly script: (req: EngineSearchRequest) => Promise<NormalizedHit[]>,
  ) {
    super(descriptor);
  }
  async search(req: EngineSearchRequest): Promise<EngineSearchResponse> {
    this.calls++;
    this.lastReq = req;
    return await this.runSearch(req, () => this.script(req));
  }
}

function fakeDescriptor(id: string): EngineDescriptor {
  return {
    id,
    kind: 'search',
    tier: 'free',
    caps: {},
    cost: { keysRequired: 0 },
    latencyBudgetMs: 50,
  };
}

function hit(url: string, title = url): NormalizedHit {
  return { url, title, provenance: { engine: 'pending' } };
}

function snap(overrides: Partial<AggregatorSnapshot> = {}): AggregatorSnapshot {
  return {
    enabled: true,
    layer: 'free',
    autoFallback: true,
    maxResults: 8,
    fusionEnabled: true,
    complexityRouting: true,
    fetchMode: 'raw',
    maxContentChars: 12_000,
    ssrfExempts: [],
    cacheEnabled: true,
    ...overrides,
  };
}

beforeEach(() => {
  outboundMock.impl = async () => {
    throw engineError('transport', 'outbound stub not configured in this test');
  };
});
afterEach(() => {
  outboundMock.impl = undefined;
});

describe('WebstackAggregator.search 全管线', () => {
  it('free 层单引擎直出：sources 映射 + truncated=false', async () => {
    const ddg = new ScriptedEngine(fakeDescriptor('ddg'), async () => [
      hit('https://a.example/x', 'A'),
      hit('https://b.example/y', 'B'),
    ]);
    const agg = new WebstackAggregator({
      snapshot: snap(),
      registry: (() => {
        const r = new EngineRegistry();
        r.register(ddg);
        return r;
      })(),
    });
    const res = await agg.search({ query: 'hello world' });
    expect(res.truncated).toBe(false);
    expect(res.sources).toEqual([
      { url: 'https://a.example/x', title: 'A' },
      { url: 'https://b.example/y', title: 'B' },
    ]);
    // 单来源直出不写归一化分。
    expect(ddg.lastReq?.hints.topic).toBe('hello world');
  });

  it('hints 下推：site: 从引擎 query 剔除并进 hints.siteFilter', async () => {
    let seen: EngineSearchRequest | undefined;
    const ddg = new ScriptedEngine(fakeDescriptor('ddg'), async (req) => {
      seen = req;
      return [];
    });
    const reg = new EngineRegistry();
    reg.register(ddg);
    const agg = new WebstackAggregator({ snapshot: snap(), registry: reg });
    await agg.search({ query: 'deepseek site:example.com' });
    expect(seen?.query).toBe('deepseek');
    expect(seen?.hints.siteFilter).toBe('example.com');
    expect(seen?.hints.hard).toContain('site:example.com');
  });

  it('双引擎 RRF 融合：同 URL 去重保首见原样 URL，归一化分写入 provenance.score', async () => {
    const COMMON_URL = 'https://common.example/page';
    const ddg = new ScriptedEngine(fakeDescriptor('ddg'), async () => [
      hit(COMMON_URL, 'DDG 版本'),
      hit('https://only-ddg.example/1', 'only d'),
    ]);
    const bing = new ScriptedEngine(fakeDescriptor('bing-lite'), async () => [
      hit('https://only-bing.example/2', 'only b'),
      hit(COMMON_URL, 'BING 版本'),
    ]);
    const reg = new EngineRegistry();
    reg.register(ddg);
    reg.register(bing);
    const agg = new WebstackAggregator({ snapshot: snap(), registry: reg });

    // 查询 >16 字符（medium 档）才会规划双引擎。
    const res = await agg.search({
      query: 'fusion check with a longer query phrase here',
    });
    const urls = res.sources.map((s) => s.url);
    // common 在两池均列首（rank=1 各得 1/61），融合分并列最高且首见在前。
    expect(urls[0]).toBe(COMMON_URL); // 首见原样，未被改写
    expect(urls).toContain('https://only-bing.example/2');
    expect(urls).toContain('https://only-ddg.example/1');
    // 去重后 common 只出现一次。
    expect(urls.filter((u) => u === COMMON_URL).length).toBe(1);
    expect(res.sources).toHaveLength(3);
  });

  it('缓存二次命中：第二次搜索零引擎调用（零网络计数验证）', async () => {
    const ddg = new ScriptedEngine(fakeDescriptor('ddg'), async () => [
      hit('https://c.example/1', 'C'),
    ]);
    const reg = new EngineRegistry();
    reg.register(ddg);
    const agg = new WebstackAggregator({ snapshot: snap(), registry: reg });

    const first = await agg.search({ query: 'cached query' });
    const second = await agg.search({ query: 'cached query' });
    expect(first.sources).toEqual(second.sources);
    expect(ddg.calls).toBe(1); // 第二次完全走缓存
    expect(agg.cache.stats().hits).toBe(1);
  });

  it('fallback 链 terminal 终止语义：aborted 抛出且后续候选零调用', async () => {
    const bad = new ScriptedEngine(fakeDescriptor('bad'), async () => {
      throw engineError('aborted', 'caller aborted', { engineId: 'bad' });
    });
    const neverCalled = new ScriptedEngine(fakeDescriptor('next'), async () => [
      hit('https://n.example/1'),
    ]);
    const reg = new EngineRegistry();
    reg.register(bad);
    reg.register(neverCalled);
    const agg = new WebstackAggregator({ snapshot: snap(), registry: reg });

    await expect(agg.search({ query: 'terminal case' })).rejects.toMatchObject({
      name: 'EngineError',
      code: 'aborted',
    });
    expect(neverCalled.calls).toBe(0);
    expect(agg.cache.stats().size).toBe(0); // 失败不写缓存
  });

  it('请求级 maxResults 截断先于 seam（W-B-95 成本优化位）', async () => {
    const ddg = new ScriptedEngine(fakeDescriptor('ddg'), async (req) =>
      Array.from({ length: req.count }, (_, i) => hit(`https://t.example/${i}`, `T${i}`)),
    );
    const reg = new EngineRegistry();
    reg.register(ddg);
    const agg = new WebstackAggregator({ snapshot: snap(), registry: reg });
    const res = await agg.search({ query: 'truncate me', maxResults: 2 });
    expect(res.sources).toHaveLength(2);
  });

  it('enabled=false 显式失败为统一错误而非静默空结果', async () => {
    const agg = new WebstackAggregator({
      snapshot: snap({ enabled: false }),
      registry: new EngineRegistry(),
    });
    expect(agg.available()).toBe(false);
    await expect(agg.search({ query: 'x' })).rejects.toMatchObject({
      code: 'transport',
      detail: 'disabled',
    });
    await expect(agg.fetch({ url: 'https://x.example/' })).rejects.toMatchObject({
      code: 'transport',
      detail: 'disabled',
    });
  });

  it('空候选池抛 no-candidates 统一错误', async () => {
    const agg = new WebstackAggregator({
      snapshot: snap(),
      registry: new EngineRegistry(),
    });
    await expect(agg.search({ query: 'q' })).rejects.toMatchObject({
      detail: 'no-candidates',
    });
  });

  it('search 路径引擎错误消息经 scrubber 脱敏后抛出（敏感 query 值不外泄）', async () => {
    const leaky = new ScriptedEngine(fakeDescriptor('ddg'), async () => {
      throw engineError(
        'http-upstream',
        'upstream rejected https://api.example/v1?api_key=sk-secret-value&x=1',
        {},
      );
    });
    const reg = new EngineRegistry();
    reg.register(leaky);
    const agg = new WebstackAggregator({ snapshot: snap(), registry: reg });
    const err = await agg.search({ query: 'leak probe' }).catch((e) => e);
    expect(err.name).toBe('EngineError');
    expect(err.code).toBe('http-upstream');
    // 敏感参数值已被 *** 遮蔽；非敏感 query 对保持原样。
    expect(err.message).toContain('api_key=***');
    expect(err.message).not.toContain('sk-secret-value');
    expect(err.message).toContain('x=1');
  });

  it('cacheEnabled=false 不读不写缓存', async () => {
    const ddg = new ScriptedEngine(fakeDescriptor('ddg'), async () => [
      hit('https://nc.example/1'),
    ]);
    const reg = new EngineRegistry();
    reg.register(ddg);
    const agg = new WebstackAggregator({
      snapshot: snap({ cacheEnabled: false }),
      registry: reg,
    });
    await agg.search({ query: 'no cache' });
    await agg.search({ query: 'no cache' });
    expect(ddg.calls).toBe(2);
    expect(agg.cache.stats().size).toBe(0);
  });
});

describe('WebstackAggregator.fetch 全管线（假出站客户端）', () => {
  function fakeOutbound(init: {
    status: number;
    finalUrl?: string;
    body?: string;
    headers?: Record<string, string>;
  }) {
    outboundMock.impl = async (req: { url: string }) => ({
      status: init.status,
      finalUrl: init.finalUrl ?? req.url,
      headers: init.headers ?? { 'content-type': 'text/html; charset=utf-8' },
      bytes: (init.body ?? '').length,
      text: async () => init.body ?? '',
    });
  }

  it('404 是数据不是异常：statusCode 如实上呈 + 带解释前缀', async () => {
    fakeOutbound({ status: 404, body: '<html><body>gone</body></html>' });
    const agg = new WebstackAggregator({
      snapshot: snap(),
      registry: new EngineRegistry(),
    });
    const res = await agg.fetch({ url: 'https://data.example/missing' });
    expect(res.statusCode).toBe(404);
    expect(res.body.kind).toBe('text');
    expect(res.body.content).toContain('[HTTP 404]');
    expect(res.body.content).toContain('gone');
    expect(res.truncated).toBe(false);
  });

  it('SSRF 拒绝透传：ssrf-blocked terminal 错误经脱敏后抛出', async () => {
    outboundMock.impl = async () => {
      throw engineError('ssrf-blocked', 'blocked by G1-static: scheme-disallowed', {
        detail: 'scheme-disallowed',
      });
    };
    const agg = new WebstackAggregator({
      snapshot: snap(),
      registry: new EngineRegistry(),
    });
    await expect(agg.fetch({ url: 'file:///etc/passwd' })).rejects.toMatchObject({
      name: 'EngineError',
      code: 'ssrf-blocked',
      detail: 'scheme-disallowed',
    });
  });

  it('预算派生：canonical=min(maxContentChars×4, 8MiB)、rendered=maxContentChars', async () => {
    let seenMaxBytes: number | undefined;
    outboundMock.impl = async (req: { maxBytes: number; url: string }) => {
      seenMaxBytes = req.maxBytes;
      return {
        status: 200,
        finalUrl: req.url,
        headers: { 'content-type': 'text/plain' },
        bytes: 0,
        text: async () => '',
      };
    };
    const agg = new WebstackAggregator({
      snapshot: snap({ maxContentChars: 1000 }),
      registry: new EngineRegistry(),
    });
    const res = await agg.fetch({ url: 'https://budget.example/' });
    // canonicalChars=4000（1000×4），管线自身再做 ×4 字节派生 → 16000。
    expect(seenMaxBytes).toBe(16_000);
    // 空正文带解释兜底（绝不静默空白）。
    expect(res.body.content.length).toBeGreaterThan(0);
  });
});
