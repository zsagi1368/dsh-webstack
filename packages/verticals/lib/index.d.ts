//#region src/framework.d.ts
/**
 * 垂直频道最小框架（实验性卫星，默认关闭）。
 *
 * 职责边界（W-B-05 消费侧解耦同款姿态）：
 * - 本文件只定义「频道是什么」与「注册表如何治理频道」，不实现任何具体
 *   频道；具体频道见 x-search.ts 及后续增量。
 * - 全部契约类型均为 dsh-webstack 冻结契约的**本地结构镜像**：字段语义与
 *   `NormalizedHit` / `SearchHints` / `EngineDescriptor` 逐字对齐但零 import，
 *   结构兼容由装配层与 webstack 侧契约测试共同锁死；本包 monorepo 外可编译。
 * - 依赖全部经 `VerticalDeps` 注入：`search` 由装配层接免费池引擎聚合；
 *   `outboundFetch` 复用内核 SSRF 四道闸出站通道。两者缺席/非函数一律按
 *   「未接线」静默降级——本包自身永不直接触网。
 *
 * @module dsh-webstack-verticals/framework
 */
/** 结果出处元组的最小像（镜像 HitProvenance）。 */
interface HitProvenance {
  /** 产出该命中的引擎 id。 */
  engine: string;
  /** 降级/中转标注（如 "oembed"、"site-search"）；W-B-17 如实标注纪律。 */
  via?: string;
  /** 面向用户的补充说明键（i18n 键，不是自由文本——防注入 W-B-53）。 */
  note?: string;
}
/** 归一化命中的最小像（镜像 NormalizedHit；url 保留首见原样 W-B-35）。 */
interface NormalizedHit {
  url: string;
  title: string;
  snippet?: string;
  publishedAt?: string;
  provenance: HitProvenance;
}
/** 搜索提示的最小像（镜像 SearchHints 的频道消费子集）。 */
interface SearchHints {
  topic?: string;
  siteFilter?: string;
  hard: readonly string[];
  soft: readonly string[];
}
/**
 * 频道层搜索请求（EngineSearchRequest 的消费子集像）：layer/band 等路由
 * 字段对垂直频道无语义，刻意省略；结构兼容装配层的完整请求对象。
 */
interface VerticalSearchRequest {
  query: string;
  hints: SearchHints;
  count: number;
  signal?: AbortSignal;
}
/** 统一出站请求的最小像（镜像 OutboundRequest；GET 语义）。 */
interface OutboundRequestLike {
  url: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes: number;
}
/** 统一出站响应的最小像（镜像 OutboundResponse）。 */
interface OutboundResponseLike {
  status: number;
  text(): Promise<string>;
}
/** 出站客户端函数签名（失败抛 EngineError；本包一律 try/catch 静默降级）。 */
type OutboundFetchLike = (req: OutboundRequestLike) => Promise<OutboundResponseLike>;
/** 装配层注入的频道依赖：缺席成员 = 对应腿静默不可用，绝不裸触网。 */
interface VerticalDeps {
  /**
   * 免费池搜索回调：装配层把免费池引擎聚合（ddg / bing-lite 等）包装成
   * 单入口注入。返回 hits 或抛错由频道自行消化。
   */
  search(req: VerticalSearchRequest): Promise<NormalizedHit[]>;
  /** 内核 outboundFetch 注入位（SSRF 四道闸复用）；缺席 = oEmbed 腿跳过。 */
  outboundFetch?: OutboundFetchLike | undefined;
}
/** 引擎能力徽章位的频道子集像（内核恒缺省 vertical 位，仅卫星供给）。 */
interface VerticalCaps {
  readonly vertical: true;
}
/** 引擎描述符的频道名片像（tier 恒 'free'：垂直降级链结构性免凭据）。 */
interface VerticalDescriptor {
  readonly id: string;
  readonly kind: 'search';
  readonly tier: 'free';
  readonly caps: VerticalCaps;
  readonly cost: {
    readonly keysRequired: 0;
    readonly quotaHint: 'unknown';
  };
  readonly latencyBudgetMs: number;
}
/** 深冻结工具（webstack freezeDescriptor 同款语义，本地实现防跨包依赖）。 */
declare function freezeDeep<T>(value: T): T;
/**
 * 垂直频道接口：一个频道 = 一条「特定信息域」的结构化降级链。
 * `run` 必须自消化全部异常（最坏返回空数组），绝不向注册表抛错。
 */
interface VerticalChannel {
  /** 稳定唯一 id（同时是设置面 channels.<id> 开关键与缓存键维度）。 */
  readonly id: string;
  /** 确定性意图判定：给定 hints 是否值得让该频道出手（纯函数、不打网）。 */
  canHandle(hints: SearchHints): boolean;
  /** 执行降级链；deps 缺席成员按未接线处理。 */
  run(req: VerticalSearchRequest, deps: VerticalDeps): Promise<NormalizedHit[]>;
}
/**
 * 频道注册表：register/list/canRun 三面。同名重复注册按「替换」处理并返回
 * 新 disposer（旧 disposer 幂等失效）；list 返回注册顺序快照。
 */
declare class VerticalRegistry {
  private readonly channels;
  /**
   * 注册或替换频道；返回 disposer（再次调用幂等无害）。
   * @throws 同一实例重复注册不同对象但同 id 时按替换语义，不抛错。
   */
  register(channel: VerticalChannel): () => void;
  /** 注册顺序快照（只读数组副本，外部增删不影响注册表）。 */
  list(): readonly VerticalChannel[];
  /** 频道存在且 canHandle(hints)=true 才可运行；未知 id 恒 false。 */
  canRun(id: string, hints: SearchHints): boolean;
}
//#endregion
//#region src/cordis.d.ts
/** Loader/registry 记录名（`registry.ts:322` 取 `plugin.name`）。 */
declare const name = "dsh-webstack-verticals";
/**
 * 无硬注入服务（对齐 f4c 判据「填 inject 即成硬依赖、缺服务装载即挂」）：
 * 频道两腿依赖全部经 `VerticalDeps` 在**调用期**显式注入（`run(req, deps)`），
 * mount 期不解析任何宿主服务；dsh-webstack peer 缺席也不影响挂载。
 */
declare const inject: readonly string[];
/**
 * 宿主 ctx 的结构化子集（刻意不 `import type { Context }`，理由见文件头注）。
 * 仅声明本入口实际用到的两面：`provide`（注册命名服务）与可选 `effect`
 * （随 fiber 卸载释放注册）。
 */
interface CordisContextLike {
  /** cordis 服务注册面（f4c/bridge 同款调用：`ctx.provide(name, service)`）。 */
  provide(name: string, service: unknown): void;
  /** 可选 teardown 登记；裸 ctx（单测）缺位时静默跳过。 */
  effect?(teardown: () => unknown, label?: string): unknown;
}
/** `apply` 的可选配置。seed 通道今日不灌 config（§8-ADJ-3），缺省即挂载。 */
interface XVerticalConfig {
  /** 显式关闭位：`false` 时不注册服务（默认关态纪律在 seed/设置面，非本闸）。 */
  enabled?: boolean;
}
/** `x-vertical` 服务的对外形状：注册表 + 频道实例 + 判定便捷面。 */
interface XVerticalService {
  /** 频道注册表（后续增量频道经 `register` 并入同一实例）。 */
  readonly registry: VerticalRegistry;
  /** 本役唯一出厂频道（id = `x-vertical`）。 */
  readonly channel: VerticalChannel;
  /** 路由判定便捷面：`registry.canRun(X_VERTICAL_ID, hints)` 的闭包。 */
  canHandle(hints: SearchHints): boolean;
}
/**
 * 挂载 x-vertical 服务：new VerticalRegistry + register(XVerticalChannel) +
 * `ctx.provide('x-vertical', service)`；disposer 经 `ctx.effect` 随 fiber 卸载。
 * 同名重复 provide 由 cordis 语义处理；本函数返回注册的服务对象便于宿主/测试
 * 检视（f4c `mountedFor` 同款意图，此处直接回传、不单设 WeakMap 台账）。
 */
declare function apply(ctx: CordisContextLike, config?: XVerticalConfig): XVerticalService | undefined;
//#endregion
//#region src/x-search.d.ts
declare const X_VERTICAL_ID = "x-vertical";
/** 频道名片：免费档、零凭据、caps.vertical（深冻结防运行期篡改）。 */
declare const X_VERTICAL_DESCRIPTOR: VerticalDescriptor;
/** 判定 url 是否推文形态（/status/<id>）。 */
declare function isTweetUrl(url: string): boolean;
/**
 * 从候选列表抽取推文 URL：保序去重。W-B-35 纪律——url 保留首见原样，
 * 不做任何规范化改写（带查询串的变体是不同字符串，身份归一只发生在
 * 缓存指纹内部）；此处仅对完全相同的字符串按首见保留。
 */
declare function extractTweetUrls(urls: readonly string[]): string[];
/** 组装腿 1 的 site: 限域双站 OR 查询（硬约束片段直拼 query，ddg 同款语义）。 */
declare function buildXSearchQuery(topic: string): string;
/** X 官方公开 oEmbed 端点基址。 */
declare const OEMBED_ENDPOINT = "https://publish.twitter.com/oembed";
/** G4 有界响应体上限：oEmbed JSON 极小，256KB 封顶。 */
declare const OEMBED_MAX_BYTES = 262144;
/**
 * 组装官方 oEmbed GET URL：url 参数整体百分号编码；omit_script/dnt 固定 true
 * （消费端自渲染、不做跟踪加载）。
 */
declare function buildOembedUrl(tweetUrl: string): string;
/** 富化成功后的 provenance.note 键（i18n 键引用，禁止自由文本 W-B-53）。 */
declare const X_OEMBED_NOTE_KEY: "webstack.verticals.x.degraded-oembed";
/** 腿 1 直通（未经 oEmbed 富化）结果的 via 标注。 */
declare const VIA_SITE_SEARCH: "site-search";
/** 腿 2 富化结果的 via 标注（任务契约字面值）。 */
declare const VIA_OEMBED: "oembed";
/**
 * X 垂直频道（id `x-vertical`）。实例持有两级状态：
 * - `inflight`：主题级单飞锁（并发 run 共享同一 Promise，结算后释放）；
 * - `oembedCache`：URL → 富化文本缓存（空串 = 会话内已失败的终局标记，
 *   不再重试——「每 URL 一次」的会话纪律）。
 * 两级状态均为实例级会话生命周期，随装配层销毁一并丢弃。
 */
declare class XVerticalChannel implements VerticalChannel {
  readonly id = "x-vertical";
  private readonly inflight;
  private readonly oembedCache;
  /**
   * canHandle 判定矩阵（确定性、不打网）：
   * - hints.siteFilter 落在 x.com/twitter.com 及其子域 → 出手；
   * - hard/soft 片段含显式 `site:` 限域或站点指称（x.com/twitter.com）→ 出手；
   * - 其余（含空 hints）→ 不出手，交常规引擎。
   */
  canHandle(hints: SearchHints): boolean;
  /** 单飞入口：同主题并发共享一次执行；失败路径同样释放锁。 */
  run(req: VerticalSearchRequest, deps: VerticalDeps): Promise<NormalizedHit[]>;
  /** 全链执行：任一环节异常一律收敛为空数组（两腿全失败静默语义）。 */
  private runOnce;
  /** 单条结果富化：推文 + 出站可用才走腿 2；否则如实标注 site-search 直通。 */
  private enrich;
  /**
   * 调官方 oEmbed 端点并取纯文本：仅接受 2xx + 可解析 JSON + html 字段；
   * 非 2xx 是「数据」（如实降级），管道故障是异常但在此吞掉换空串。
   */
  private fetchOembedText;
  /** via 重标注：engine 缺失时兜底为本频道 id（W-B-16 出处可解释性）。 */
  private relabel;
}
//#endregion
export { type CordisContextLike, HitProvenance, NormalizedHit, OEMBED_ENDPOINT, OEMBED_MAX_BYTES, OutboundFetchLike, OutboundRequestLike, OutboundResponseLike, SearchHints, VIA_OEMBED, VIA_SITE_SEARCH, VerticalCaps, VerticalChannel, VerticalDeps, VerticalDescriptor, VerticalRegistry, VerticalSearchRequest, XVerticalChannel, type XVerticalConfig, type XVerticalService, X_OEMBED_NOTE_KEY, X_VERTICAL_DESCRIPTOR, X_VERTICAL_ID, apply, buildOembedUrl, buildXSearchQuery, extractTweetUrls, freezeDeep, inject, isTweetUrl, name };