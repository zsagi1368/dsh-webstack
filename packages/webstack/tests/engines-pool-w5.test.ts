/**
 * TC-B4-W5 锁组①③④：引擎池装配位证明（W-DEC 口径①「装配位打通、单元级
 * 零真实外呼」兑现面）——免费池 / keyed 六家 / MCP 最小核验。
 *
 * 断言依据 = 亲读实际语义（禁臆测）：
 * - index.ts:251-262 注册矩阵：免费池无条件注册（区注释「结构性零凭据，
 *   W-B-12」）、searxng trim+`/^https?:\/\//i` 门控、keyed 六家名单、MCP
 *   逐条 validateMcpEntry 门控（拒绝项进 invalidMcpIds 诊断清单，F-108）。
 * - available() 归属面实测：引擎类无 available()；语义在聚合器 seam 面
 *   （aggregator.ts:220，W-B-97 廉价同步=snapshot.enabled 总开关，零探针）。
 *   「零凭据结构断言」= descriptor cost.keysRequired===0 + credsSourceViewFrom
 *   仅遍历 KEYED_ENGINE_IDS（免费池不进凭据视图，W-B-12）。
 * - keyed「无凭据不可用」实际语义 = requireCredential 缺键抛 auth 且先于
 *   pipeline/outbound（engine.ts:306-316 + tavily.ts:114 亲证）——缺键零外呼。
 * - validateMcpEntry（mcp-generic.ts:75-102）：合法 null / 拒绝返回闭集 i18n
 *   键；启动向量含 `@version` 锁定形态，裸 npx 结构性拒绝（W-A-02）。
 *   McpSearchEngine 构造只建冻结名片（buildMcpDescriptor），SDK 懒加载——
 *   构建期零网络零子进程。
 * - Config schema（schemastery，index.ts Config）：Config({}) 过默认全、
 *   非法枚举/类型必抛（本地探针实测形制）。
 *
 * 零真实网络自证（W-DEC 口径②：真实外呼不列硬验收）：全部出站腿走 class 基
 * FetchStub（URL 白名单路由，白名单外响亮抛）或 ForbiddenFetch 守卫（任何
 * 外呼尝试即抛+计数）；G2 DNS 闸走 hoisted dns mock（engines-ddg.test.ts
 * 先例形制）。构建腿一律在守卫下执行并断言零触达。
 *
 * backlog 登记声明（PLAN-intake-requirements.md:179 授权原文）：「不在完工
 * 门禁内的显式声明（定性为范围外遗留，非未完成）：webstack V1 全 11 项中
 * 『有钥引擎/MCP 引擎/凭据链』等按批次四内部再分级，允许带 backlog 收口」
 * ——keyed 六家真实 key 验证与 MCP 真实连接验证归用户侧/后续批次（backlog
 * A.4⑤，触发条件=W-DEC 口径③），本卡为最小构建核验非真实端点验证。
 *
 * MCP 独立栈并存登记（contract-webstack.md:45 表行 12 原文）：
 * 「@modelcontextprotocol/sdk | engines/mcp-generic.ts 直用 | peer optional，
 * 插件自带 | 主线走 dsh-mcp-client 自研栈（不同栈） | 独立栈并存登记」——
 * 本插件 MCP 面自带 SDK 依赖（package.json peerDependenciesMeta optional），
 * 与主线 dsh-mcp-client 是两条互不消费的栈；W5 锁面只锁插件侧装配位。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}));

import { BING_LITE_DESCRIPTOR, BingLiteEngine } from '../src/engines/bing-lite.ts';
import { DDG_DESCRIPTOR, DdgEngine } from '../src/engines/ddg.ts';
import { FREE_POOL_ENGINE_IDS, KEYED_ENGINE_IDS } from '../src/engines/engine.ts';
import {
  MCP_LATENCY_BUDGET_MS,
  MCP_VALIDATION_KEYS,
  McpSearchEngine,
  validateMcpEntry,
} from '../src/engines/mcp-generic.ts';
import type { SearxngEngine } from '../src/engines/searxng.ts';
import { TavilyEngine } from '../src/engines/tavily.ts';
import { buildEngineRegistry, Config, composeSnapshot, credsSourceViewFrom } from '../src/index.ts';
import { WebstackAggregator } from '../src/kernel/aggregator.ts';
import type { EngineSearchRequest, McpServerEntry } from '../src/kernel/types.ts';

// ---------------------------------------------------------------------------
// class 基 fetch 桩（this 忠实；URL 白名单路由 = 零真实外呼自证面）
// ---------------------------------------------------------------------------

interface StubCall {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

/** 白名单路由桩：命中前缀路由应答；白名单外 URL 响亮抛（当场红）。 */
class FetchStub {
  readonly calls: StubCall[] = [];
  constructor(private readonly routes: Readonly<Record<string, () => Response>> = {}) {}
  readonly fetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const raw = String(url);
    this.calls.push({ url: raw, init });
    for (const [prefix, make] of Object.entries(this.routes)) {
      if (raw.startsWith(prefix)) return make();
    }
    throw new Error(`[zero-network guard] unexpected outbound URL: ${raw}`);
  };
  get urls(): string[] {
    return this.calls.map((call) => call.url);
  }
}

/** 禁面守卫桩：期望零外呼的腿安装；任何触达即计数（断言 calls===0 收口）。 */
class ForbiddenFetch {
  calls = 0;
  readonly fetch = async (url: string | URL): Promise<never> => {
    this.calls++;
    throw new Error(`[zero-network guard] outbound attempted: ${String(url)}`);
  };
}

let installed = false;
function installFetch(stub: FetchStub | ForbiddenFetch): void {
  vi.stubGlobal('fetch', stub.fetch);
  installed = true;
}
afterEach(() => {
  if (installed) {
    vi.unstubAllGlobals();
    installed = false;
  }
});

// ---------------------------------------------------------------------------
// 离线夹具（合成，非真实站点载荷）
// ---------------------------------------------------------------------------

const DDG_HTML = [
  '<div class="result">',
  '<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fw5.example%2Fddg&amp;rut=x">W5 DDG Hit</a>',
  '</div>',
].join('');
const TAVILY_JSON = JSON.stringify({
  results: [{ url: 'https://w5.example/tavily', title: 'W5 Tavily', content: 'c' }],
});

const REQ: EngineSearchRequest = {
  query: 'w5 pool',
  hints: { hard: [], soft: [] },
  count: 5,
  layer: 'free',
  band: 'simple',
};
const REQ_API: EngineSearchRequest = { ...REQ, layer: 'api' };

// ---------------------------------------------------------------------------
// 锁组①：免费池装配位证明（W-DEC 口径①）
// ---------------------------------------------------------------------------

describe('W5 锁组① · 免费池装配位证明（可构建/零凭据结构/schema 零 key/零网络副作用）', () => {
  it('装配位正例：Ddg/BingLite 零配置构建成功，注册矩阵无条件收录（构建期零外呼）', () => {
    const guard = new ForbiddenFetch();
    installFetch(guard);
    const { registry } = buildEngineRegistry({}); // 零 config 构建 = 装配位打通
    expect(registry.describe('ddg')?.tier).toBe('free');
    expect(registry.describe('bing-lite')?.tier).toBe('free');
    // 独立构建面（W-DEC 口径①「可构建」）：默认描述符=冻结常量本体。
    expect(new DdgEngine().descriptor).toBe(DDG_DESCRIPTOR);
    expect(new BingLiteEngine().descriptor).toBe(BING_LITE_DESCRIPTOR);
    expect(Object.isFrozen(DDG_DESCRIPTOR)).toBe(true);
    expect(Object.isFrozen(BING_LITE_DESCRIPTOR)).toBe(true);
    expect(guard.calls).toBe(0); // 构建全程零网络副作用（守卫零触达）
  });

  it('零凭据结构断言（W-B-12，index.ts 免费池区注释对照）：keysRequired===0 + 免费池不进凭据视图', () => {
    expect(DDG_DESCRIPTOR.cost.keysRequired).toBe(0);
    expect(BING_LITE_DESCRIPTOR.cost.keysRequired).toBe(0);
    expect(FREE_POOL_ENGINE_IDS).toEqual(['ddg', 'bing-lite', 'searxng']); // 词表闭集
    // 结构性禁止：即便用户在 engines.ddg 塞 key，凭据视图也不收（免费池无键位）。
    const view = credsSourceViewFrom({ engines: { ddg: { key: 'forbidden' }, bingLiteAlias: {} } });
    expect(view.configValues && 'ddg' in view.configValues).toBe(false);
  });

  it('available() 语义锁（实际归属面=聚合器 seam，W-B-97）：enabled 总开关判别对+零探针外呼', () => {
    const guard = new ForbiddenFetch();
    installFetch(guard);
    const on = new WebstackAggregator({ snapshot: composeSnapshot({ enabled: true }) });
    const off = new WebstackAggregator({ snapshot: composeSnapshot({ enabled: false }) });
    expect(on.available()).toBe(true); // 廉价同步：只读本地快照
    expect(off.available()).toBe(false); // 判别对：总开关翻 false 即不可用
    expect(guard.calls).toBe(0); // available() 绝非网络探针（W-B-97 自证）
  });

  it('config schema 接受零 key 条目（W-DEC 口径①第三句）；非法枚举/类型必抛（负对照）', () => {
    const zeroKey = Config({});
    expect(zeroKey.enabled).toBe(true);
    expect(zeroKey.layer).toBe('free'); // 开箱默认层=免费池
    expect(zeroKey.searxngBaseUrl).toBe('');
    expect(zeroKey.engines).toEqual({}); // 零 key 条目合法
    expect(() => Config({ layer: 'cloud' } as never)).toThrowError(); // 红腿：非法层词汇
    expect(() => Config({ enabled: 'yes' } as never)).toThrowError(); // 红腿：类型违规
  });

  it('searxng 门控正反例：trim+http(s) 大小写不敏感才注册；非法/缺席静默无该引擎', () => {
    const positive: readonly string[] = ['https://searx.example.org', ' HTTP://X.example '];
    for (const raw of positive) {
      const guard = new ForbiddenFetch();
      installFetch(guard);
      const { registry } = buildEngineRegistry({ searxngBaseUrl: raw });
      expect(registry.describe('searxng')?.tier).toBe('selfhosted');
      const engine = registry.candidates('selfhosted')[0] as SearxngEngine;
      expect(engine.baseUrl).toBe(raw.trim()); // trim 语义锁（index.ts:264 亲读）
      expect(guard.calls).toBe(0); // 门控注册零外呼
      vi.unstubAllGlobals();
      installed = false;
    }
    const negative: readonly (string | undefined)[] = [
      undefined,
      '',
      '   ',
      'not-a-url',
      'ftp://x.example',
      'file:///etc/passwd',
    ];
    for (const raw of negative) {
      const { registry } = buildEngineRegistry({
        ...(raw === undefined ? {} : { searxngBaseUrl: raw }),
      });
      expect(registry.describe('searxng')).toBeUndefined(); // 静默缺席（不抛不注册）
      expect(registry.candidates('selfhosted')).toEqual([]);
    }
  });

  it('免费池执行面离线回放：装配位产出的 ddg 引擎零凭据走 mock fetch 面出命中', async () => {
    const stub = new FetchStub({
      'https://html.duckduckgo.com/': () => new Response(DDG_HTML, { status: 200 }),
    });
    installFetch(stub);
    const { registry } = buildEngineRegistry({});
    // REQ 无 credentials 字段=零凭据执行正例（对照锁组③缺键 auth 红腿）。
    const res = await registry.runWithFallback(REQ, ['ddg']);
    expect(res.hits.map((h) => h.url)).toEqual(['https://w5.example/ddg']);
    expect(res.hits[0]?.provenance.engine).toBe('ddg'); // BaseEngine 盖章（W-B-16）
    expect(res.attempts[0]?.outcome).toBe('ok');
    expect(stub.urls.every((u) => u.startsWith('https://html.duckduckgo.com/'))).toBe(true);
  });

  it('免费池失败形制判别腿：上游 429 → rate-limited 结构化（裸错不出环）', async () => {
    const stub = new FetchStub({
      'https://html.duckduckgo.com/': () => new Response('', { status: 429 }),
    });
    installFetch(stub);
    const { registry } = buildEngineRegistry({});
    await expect(registry.runWithFallback(REQ, ['ddg'])).rejects.toMatchObject({
      name: 'EngineError',
      code: 'rate-limited',
      engineId: 'ddg',
      httpStatus: 429,
    });
  });
});

// ---------------------------------------------------------------------------
// 锁组③：keyed 六家最小构建核验（backlog 声明见文件头）
// ---------------------------------------------------------------------------

describe('W5 锁组③ · keyed 六家最小构建核验（构建/schema/无凭据 auth 零外呼）', () => {
  it('名单锁：KEYED_ENGINE_IDS=卡面六家（src 实测一致）；装配位全收录且名片 keyed 画像', () => {
    expect(KEYED_ENGINE_IDS).toEqual(['tavily', 'brave', 'exa', 'jina', 'firecrawl', 'anysearch']);
    const guard = new ForbiddenFetch();
    installFetch(guard);
    const { registry } = buildEngineRegistry({}); // 零配置=零凭据构建六家
    for (const id of KEYED_ENGINE_IDS) {
      const descriptor = registry.describe(id);
      expect(descriptor?.tier, `${id} tier`).toBe('keyed');
      expect(descriptor?.cost.keysRequired, `${id} keysRequired`).toBe(1);
      expect(descriptor?.cost.quotaHint, `${id} quotaHint`).toBe('paid');
    }
    expect(registry.candidates('api').map((e) => e.descriptor.id)).toEqual([...KEYED_ENGINE_IDS]);
    expect(guard.calls).toBe(0); // 构建期零外呼（守卫零触达）
  });

  it('无凭据=不可用（实际语义形）：api 层回退穷尽 → auth 结构化失败，全程零外呼', async () => {
    const guard = new ForbiddenFetch();
    installFetch(guard);
    const { registry } = buildEngineRegistry({});
    await expect(registry.runWithFallback(REQ_API)).rejects.toMatchObject({
      name: 'EngineError',
      code: 'auth', // requireCredential 缺键即 auth（engine.ts:306-316），无匿名降级
    });
    expect(guard.calls).toBe(0); // 缺键先于 pipeline/outbound——零外呼自证
    // 六家逐一结构化失败留痕（审计轨迹，非裸抛）。
    for (const id of KEYED_ENGINE_IDS) {
      expect(registry.recentAttempts(id)[0]?.outcome, `${id} attempt`).toBe('auth');
    }
  });

  it('判别对（有凭据 true 形）：tavily 带键走 mock 面出命中+密钥只经头；同引擎缺键 auth 零外呼', async () => {
    const stub = new FetchStub({
      'https://api.tavily.com/': () => new Response(TAVILY_JSON, { status: 200 }),
    });
    installFetch(stub);
    const engine = new TavilyEngine();
    const ok = await engine.search({
      ...REQ_API,
      credentials: { tavilyKey: 'test-key-5' },
    });
    expect(ok.hits.map((h) => h.url)).toEqual(['https://w5.example/tavily']);
    expect(ok.attempts[0]?.outcome).toBe('ok');
    const headers = stub.calls[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-key-5'); // W-B-55：密钥只经请求头
    expect(stub.urls[0]).toContain('api.tavily.com');

    const callsBefore = stub.calls.length;
    await expect(engine.search({ ...REQ_API })).rejects.toMatchObject({ code: 'auth' }); // 红腿
    expect(stub.calls.length).toBe(callsBefore); // 缺键腿零新增外呼
  });

  it('config schema 正反例：engines 节点三级链键位过检；creds 视图仅收六家（负位=免费池/幽灵 id 不入视图）', () => {
    const parsed = Config({
      engines: {
        tavily: { key: 'k1' },
        brave: { apiKey: 'k2-alias' }, // 历史别名兼容（读取侧 key ?? apiKey）
        exa: { credentialRef: 'ref-exa' },
        ddg: { key: 'structurally-forbidden' },
        ghost: { key: 'unknown-id' },
      },
    });
    const view = credsSourceViewFrom(parsed);
    expect(view.configValues).toMatchObject({ tavily: 'k1', brave: 'k2-alias' });
    expect(view.credentialsRef).toMatchObject({ exa: 'ref-exa' });
    expect(view.configValues && 'ddg' in view.configValues).toBe(false); // W-B-12 负位
    expect(view.configValues && 'ghost' in view.configValues).toBe(false); // 六家闭集负位
    expect(() => Config({ engines: 'not-a-dict' } as never)).toThrowError(); // 结构违规必抛
  });
});

// ---------------------------------------------------------------------------
// 锁组④：MCP 引擎最小核验（F-108；独立栈登记+backlog 声明见文件头）
// ---------------------------------------------------------------------------

const GOOD_STDIO: McpServerEntry = {
  id: 'alpha',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@acme/search-mcp@1.2.3'], // 启动向量含 @version 锁定 token
};
const GOOD_HTTP: McpServerEntry = {
  id: 'gamma',
  transport: 'http',
  url: 'https://mcp.example/sse',
};
const BARE_NPX: McpServerEntry = {
  id: 'beta',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', 'some-mcp'],
};
const BAD_CRED: McpServerEntry = {
  id: 'delta',
  transport: 'http',
  url: 'https://mcp2.example/sse',
  credentialRefs: ['ok-ref', ' '],
};

describe('W5 锁组④ · MCP 最小核验（validateMcpEntry 正反例+装配位门控+诊断清单）', () => {
  it('正例：版本锁定 stdio（args 或 command 携带 @version）与 http(s) url 全过（null）', () => {
    expect(validateMcpEntry(GOOD_STDIO)).toBeNull();
    expect(validateMcpEntry(GOOD_HTTP)).toBeNull();
    expect(
      validateMcpEntry({ id: 'cmd-pin', transport: 'stdio', command: 'mcp-server@2.0.0' }),
    ).toBeNull(); // command 本体即锁定 token
  });

  it('负对照：裸 npx（W-A-02 结构性拒绝）/缺 id/缺 command/非 http url/空 credentialRef 全拒（闭集 i18n 键）', () => {
    expect(validateMcpEntry(BARE_NPX)).toBe(MCP_VALIDATION_KEYS.unpinned); // 红腿：无 @version
    expect(validateMcpEntry({ id: ' ', transport: 'http', url: 'https://a.example' })).toBe(
      MCP_VALIDATION_KEYS.idRequired,
    );
    expect(
      validateMcpEntry({ transport: 'stdio', command: 'x@1.0.0' } as unknown as McpServerEntry),
    ).toBe(MCP_VALIDATION_KEYS.idRequired);
    expect(validateMcpEntry({ id: 'nc', transport: 'stdio' })).toBe(
      MCP_VALIDATION_KEYS.commandRequired,
    );
    expect(validateMcpEntry({ id: 'ec', transport: 'stdio', command: '  ' })).toBe(
      MCP_VALIDATION_KEYS.commandRequired,
    );
    expect(validateMcpEntry({ id: 'nu', transport: 'http' })).toBe(MCP_VALIDATION_KEYS.urlRequired);
    expect(validateMcpEntry({ id: 'fu', transport: 'http', url: 'ftp://x.example' })).toBe(
      MCP_VALIDATION_KEYS.urlRequired,
    );
    expect(validateMcpEntry(BAD_CRED)).toBe(MCP_VALIDATION_KEYS.credRefEmpty);
  });

  it('装配位门控：过检条目注册 mcp-<id>（tier=mcp/预算 10s），拒绝项进 invalidMcpIds 诊断清单；构建零外呼零子进程', () => {
    const guard = new ForbiddenFetch();
    installFetch(guard);
    const { registry, mcpEngineIds, invalidMcpIds } = buildEngineRegistry({
      mcpServers: [GOOD_STDIO, BARE_NPX, GOOD_HTTP, BAD_CRED],
    });
    expect(mcpEngineIds).toEqual(['mcp-alpha', 'mcp-gamma']); // 配置序=注册序
    expect(invalidMcpIds).toEqual(['beta', 'delta']); // F-108 诊断清单（doctor unwired 数据源）
    expect(registry.describe('mcp-alpha')?.tier).toBe('mcp');
    expect(registry.describe('mcp-alpha')?.latencyBudgetMs).toBe(MCP_LATENCY_BUDGET_MS);
    expect(registry.describe('mcp-beta')).toBeUndefined(); // 拒绝项不注册
    expect(registry.describe('mcp-delta')).toBeUndefined();
    expect(registry.candidates('mcp').map((e) => e.descriptor.id)).toEqual([
      'mcp-alpha',
      'mcp-gamma',
    ]);
    expect(guard.calls).toBe(0); // SDK 懒加载：构建/注册期零网络零子进程（search 才 import）
  });

  it('McpSearchEngine 构建面：冻结名片 mcp- 前缀派生 id+零凭据画像；构建零触达', () => {
    const guard = new ForbiddenFetch();
    installFetch(guard);
    const engine = new McpSearchEngine(GOOD_STDIO);
    expect(engine.descriptor.id).toBe('mcp-alpha'); // entry.id 派生（跨层前缀防撞）
    expect(engine.descriptor.kind).toBe('search');
    expect(engine.descriptor.cost).toEqual({ keysRequired: 0, quotaHint: 'unknown' });
    expect(Object.isFrozen(engine.descriptor)).toBe(true);
    expect(Object.isFrozen(engine.descriptor.cost)).toBe(true);
    expect(guard.calls).toBe(0);
  });
});
