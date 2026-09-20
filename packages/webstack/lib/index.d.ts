import z from "@deepseek-ai/schemastery";
import { Context } from "@deepseek-ai/cordis";
//#region src/kernel/types.d.ts
/**
 * WebStack 契约总纲（CONTRACT FREEZE · Wave 1 定稿，非 stub）。
 *
 * 本文件是 dsh-webstack 全部跨模块公共词汇的唯一事实源。并行工程师只允许
 * 「消费」这里的类型；需要新增或修改公共类型必须走首席架构师（见
 * docs/CONTRACTS.md 协作规则）。所有导出均为冻结契约，字段语义一经发布
 * 不做破坏性变更，只能加可选字段。
 *
 * 设计溯源 id（G:\000Github\DSH\PluginR&D\docs\web-search\81-design-inspiration.md）：
 * - W-B-05 结构镜像契约：HostSeams 在本文件内以独立 interface 重述平台 API，
 *   本包在 monorepo 外可编译、对宿主零 import 依赖（运行时仍走真实 seam）。
 * - W-B-93 双通道结果暴露：NormalizedHit 只含最小可移植字段集。
 * - W-B-35 / W-A-20：url 永远保留「原始首见」表示，身份归一只在缓存键内部发生。
 * - W-B-40：闭集错误码 union + 三分类（retryable/non-retryable/terminal）。
 * - W-B-95：截断权上交 seam——引擎/聚合器不做最终裁剪，truncated 只作可观测标志。
 *
 * @module webstack/kernel/types
 */
/** 路由层。`native` = 直接委托宿主内置 provider（不停用、不重写）。 */
type SearchLayer = 'native' | 'free' | 'api' | 'selfhosted' | 'mcp';
/** 引擎计费档位。`free` 引擎结构性禁止要求凭据（W-B-12）。 */
type EngineTier = 'native' | 'free' | 'keyed' | 'selfhosted' | 'mcp';
/** 引擎能力面：一个适配器可以只搜、只取、或两者兼备。 */
type EngineKind = 'search' | 'fetch' | 'both';
/** 复杂度分档（W-B-14）：路由器按查询特征估算，决定引擎集合与并发预算。 */
type ComplexityBand = 'simple' | 'medium' | 'complex';
/** 抓取偏好模式（F-004 回退链 raw→fit→citations→HTML 兜底）。 */
type FetchMode = 'raw' | 'fit' | 'citations';
/** 会话联网模式（W-B-94）：Host-owned 状态机的三态词汇。 */
type SessionOnlineMode = 'off' | 'on' | 'ask';
/** WebStack 注册进宿主 seam 的 provider id（补丁选择器的唯一指向目标）。 */
declare const WEBSTACK_PROVIDER_ID = "webstack";
/** 引擎能力徽章位（全部可选；缺省 = 不支持，路由器不得假设其存在）。 */
interface EngineCaps {
  /** 支持新闻/时效垂直检索（软新鲜度 hints 仅对该类引擎生效，W-B-15）。 */
  readonly news?: boolean;
  /** 支持 `site:` 限域过滤。 */
  readonly siteFilter?: boolean;
  /** 支持时间范围参数。 */
  readonly freshness?: boolean;
  /** 支持区域/语言参数。 */
  readonly locale?: boolean;
  /** 垂直定制源（仅卫星包供给，内核恒缺省）。 */
  readonly vertical?: boolean;
}
/** 引擎成本画像：keyed 引擎 keysRequired ≥ 1；免费池恒为 0。 */
interface EngineCost {
  readonly keysRequired: number;
  /** 额度提示。无权威数据一律 `unknown`，展示层禁伪造百分比（W-B-98）。 */
  readonly quotaHint?: 'unknown' | 'paid' | 'free';
}
/**
 * 引擎描述符：注册表的静态名片。探针状态（健康/冷却）是运行时数据，
 * 存放在 registry，绝不混入描述符。
 */
interface EngineDescriptor {
  /** 稳定唯一 id；同时是设置面 `engines.<id>` 配置键与缓存键维度。 */
  readonly id: string;
  readonly kind: EngineKind;
  readonly tier: EngineTier;
  readonly caps: EngineCaps;
  readonly cost: EngineCost;
  /** 单次尝试的延迟预算（毫秒）；registry 据此做双态超时的 attempt 态。 */
  readonly latencyBudgetMs: number;
}
/**
 * 确定性意图层产物（W-B-15）：纯正则双语词表从 query 提取。
 * `hard` 是必须下推到引擎的约束片段（如 `site:`），`soft` 是尽力偏好。
 */
interface SearchHints {
  /** 归并后的主题词（去掉了已提取的操作符）。 */
  readonly topic?: string;
  /** 时效窗口；软新鲜度只对 caps.news 引擎生效。 */
  readonly freshness?: 'day' | 'week' | 'month' | 'year';
  /** 限域 host 后缀（自 `site:` 提取，硬约束）。 */
  readonly siteFilter?: string;
  /** BCP-47 语言提示（软偏好）。 */
  readonly locale?: string;
  /** 未结构化但必须满足的硬约束原文片段。 */
  readonly hard: readonly string[];
  /** 软偏好原文片段（引擎可忽略）。 */
  readonly soft: readonly string[];
}
/**
 * 引擎层搜索请求。由 router 从工具层请求装配；`tier`/`layer` 是操作起点
 * 快照的一部分（W-B-74）：一次操作内一致，配置保存即时生效于下一次操作。
 */
interface EngineSearchRequest {
  readonly query: string;
  readonly hints: SearchHints;
  /** 期望结果条数上限；最终截断权上交 seam（W-B-95），引擎只做成本优化。 */
  readonly count: number;
  readonly layer: SearchLayer;
  readonly band: ComplexityBand;
  /** 取消信号：caller-abort 必须真取消底层请求（W-B-42）。 */
  readonly signal?: AbortSignal;
  /**
   * 聚合器从凭据快照注入的明文键值（键 = 引擎约定字段名，值 = 明文密钥）。
   * 仅限本次请求生命周期，随请求对象一同消亡；**禁止日志化、禁止序列化进
   * 缓存/快照/模型上下文、禁止拼入 URL query（只允许经请求头下发）**
   * （W-B-55 密钥不出 Host 进程的请求内延伸）。keyed 引擎适配器可自主选择
   * 消费本通道或走内部 KeyPool；缺席 = 由引擎自取（W-B-41）。
   */
  readonly credentials?: Readonly<Record<string, string>>;
}
/**
 * 结果出处元组（W-B-16 可解释性）：每条命中都能回答「谁给的、多可信、
 * 经什么路径」。`score` 为融合排序归一化分数（单引擎直出时可省略）。
 */
interface HitProvenance {
  /** 产出该命中的引擎 id。 */
  readonly engine: string;
  /** 融合分数（0–1）；单引擎直出可省略。 */
  readonly score?: number;
  /** 降级/中转标注（如 "bridge"、"oEmbed-fallback"）。 */
  readonly via?: string;
  /** 面向用户的补充说明键（i18n 键，不是自由文本——防注入 W-B-53）。 */
  readonly note?: string;
}
/**
 * 归一化命中（最小可移植字段集，W-B-93 通用通道）。
 *
 * 不变量（冻结）：
 * - `url` 是「原始首见」字符串，禁止任何规范化改写（W-B-35/W-A-20）；
 *   URL 身份归一只发生在缓存指纹内部。
 * - 缺失字段保持缺失（undefined），禁止编造占位值让 seam 说谎。
 */
interface NormalizedHit {
  readonly url: string;
  readonly title: string;
  readonly snippet?: string;
  /** ISO-8601 发布/抓取时间戳，引擎未提供则缺省。 */
  readonly publishedAt?: string;
  readonly provenance: HitProvenance;
}
/**
 * 单次引擎尝试的审计轨迹条目（F-010/F-011 的 attempts 回显来源）。
 * `outcome` 为 `ok` 或触发的错误码；不含任何敏感文本（过 scrubber 后才有文本）。
 */
interface AttemptRecord {
  readonly engineId: string;
  /** epoch 毫秒起点。 */
  readonly startedAt: number;
  readonly durationMs: number;
  readonly outcome: 'ok' | EngineErrorCode;
}
/** 引擎层搜索响应。`attempts` 允许空（缓存直出时由上层补写来源）。 */
interface EngineSearchResponse {
  readonly hits: readonly NormalizedHit[];
  readonly attempts: readonly AttemptRecord[];
  /** 非致命警告的 i18n 键列表（如「某引擎冷却跳过」）。 */
  readonly warnings?: readonly string[];
}
/**
 * 闭集错误码。冻结清单（新增码 = 契约变更，须走架构师）：
 *
 * | code             | 三分类        | 语义与处置 |
 * |------------------|---------------|------------|
 * | transport        | retryable     | 网络层失败（DNS/TCP/TLS/超时）。退避后同引擎可重试。 |
 * | http-upstream    | retryable     | 上游返回 5xx/异常状态。瞬态概率高，退避重试；附 httpStatus。 |
 * | unrepresentable  | non-retryable | 响应合法但无法表达为 NormalizedHit 最小字段集。重试无意义。 |
 * | aborted          | terminal      | caller-abort（W-B-42 双态之一）。整场操作立即结算，不再 fallback。 |
 * | auth             | non-retryable | 凭据无效/过期。换键池职责（W-B-41），当前尝试不可重试。 |
 * | quota            | non-retryable | 配额耗尽（账户级）。冷却整个 provider，禁止换键硬闯。 |
 * | cooldown         | non-retryable | 引擎处于冷却期被路由器拒绝。换下一个候选即可。 |
 * | ssrf-blocked     | terminal      | SSRF 任一闸拒绝（含重定向目标被拒）。安全 refusal 不做 fallback 绕行。 |
 * | narrow-failed    | retryable     | 窄化层校验失败（上游 schema 漂移/垃圾载荷）。新尝试可能不同。 |
 * | rate-limited     | retryable     | 429 类限频。尊重 retryAfterMs 退避；provider 级冷却。 |
 */
declare const ENGINE_ERROR_CODES: readonly ["transport", "http-upstream", "unrepresentable", "aborted", "auth", "quota", "cooldown", "ssrf-blocked", "narrow-failed", "rate-limited"];
/** 闭集错误码类型（由 tuple 推导，永不手写重复）。 */
type EngineErrorCode = (typeof ENGINE_ERROR_CODES)[number];
/** SSRF 纵深四道闸标识（W-B-50）。顺序即执行顺序，豁免机制永不跳过 G1/G3/G4。 */
type SafetyGate = 'G1-static' | 'G2-dns' | 'G3-redirect' | 'G4-body-bound';
/** 拒绝原因闭集（i18n 与 doctor 处方按此键派生）。 */
type SsrfRejectReason = 'scheme-disallowed' | 'userinfo-present' | 'nonstandard-port' | 'loopback' | 'private-range' | 'link-local' | 'reserved-range' | 'redirect-cross-origin-auth' | 'redirect-to-blocked' | 'body-over-bound';
/**
 * 安全裁决结果：放行 = `{ allowed: true }`；拒绝必须携带闸位与原因码，
 * 并由调用方映射为 `ssrf-blocked` 错误（terminal）。
 */
interface SafetyVerdict {
  readonly allowed: boolean;
  readonly gate?: SafetyGate;
  readonly reasonCode?: SsrfRejectReason;
  /** 面向诊断的补充说明；进入上下文前过 scrubber。 */
  readonly detail?: string;
}
/** 缓存域：分域 TTL 表与联合失效的最小分区单位。 */
type CacheDomain = 'search' | 'fetch' | 'vertical';
/**
 * 持久层适配器（L1 占位接口）：MVP 只带内存 LRU 实现；接入平台 storage /
 * snapshot 服务或未来 node:sqlite 时实现本接口即可，禁止引入原生模块
 * （Fork allowBuilds 白名单约束）。`clearAll()` 是联合失效入口
 * （W-B-31：先设计失效路径再分层），必须同时清空 L0+L1 全部域。
 */
interface PersistenceAdapter {
  readonly domain: CacheDomain | 'all';
  get(key: string): Promise<{
    readonly value: unknown;
    readonly storedAt: number;
  } | undefined>;
  set(key: string, value: unknown, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
  clearAll(): Promise<void>;
}
/**
 * 宿主能力探测结果位图。每个位对应一个耦合点（分册 06 §2 清单），探测
 * 函数唯一归口 kernel/capability.ts；位图变化写入加载标记日志（W-B-78）。
 */
interface CapabilityBitmap {
  /** ctx.web.registerSearchProvider/registerFetchProvider 存在且为函数。 */
  webSeam: boolean;
  /** cordis patch 可将选择器指向 webstack（启动后回读验证）。 */
  selectorPatchable: boolean;
  /** installSettingsSection / settings 服务可用。 */
  settingsSection: boolean;
  /** 输入区 `conversation.input.left` keyed slot 可用。 */
  inputSlot: boolean;
  /** credentials 域 credentialRef 服务可用。 */
  credentialsDomain: boolean;
  /**
   * ctx.storage 对象样在场（仅诊断位，进加载标记日志；装配层不消费 storage
   * ——主线 storage=hub/forms 无 KV 面，R-5 处置 TC-B4-W1③）。
   */
  storageService: boolean;
  /** 浏览器桥接卫星在线且已配对。 */
  bridgeOnline: boolean;
}
/** 运行档位：接管（fork/新版）→ 共存（官方旧版）→ 只读诊断（API 缺失）。 */
type TierMode = 'takeover' | 'coexist' | 'diagnostic';
/** 宿主 seam 的搜索请求（镜像 dsh-web WebSearchRequest）。 */
interface SeamWebSearchRequest {
  readonly query: string;
  readonly maxResults?: number;
}
/** 宿主 seam 的单条引用源（镜像 WebSearchSource）。 */
interface SeamWebSearchSource {
  readonly url: string;
  readonly title?: string;
  readonly snippet?: string;
  readonly publishedAt?: string;
}
/** 宿主 seam 的搜索结果（镜像 WebSearchResult；截断由 seam 裁决 W-B-95）。 */
interface SeamWebSearchResult {
  readonly content?: string;
  readonly sources: readonly SeamWebSearchSource[];
  readonly truncated: boolean;
}
/** 宿主 seam 的抓取请求（镜像 WebFetchRequest）。 */
interface SeamWebFetchRequest {
  readonly url: string;
}
/** 抓取体封闭判别 union（镜像 WebFetchBody；kind 增项是宿主协同变更）。 */
type SeamWebFetchBody = {
  readonly kind: 'html';
  readonly content: string;
} | {
  readonly kind: 'text';
  readonly content: string;
};
/** 宿主 seam 的抓取结果（镜像 WebFetchResult）。 */
interface SeamWebFetchResult {
  readonly url: string;
  readonly statusCode: number;
  readonly body: SeamWebFetchBody;
  readonly truncated: boolean;
}
/**
 * 我们注册进 `ctx.web` 的 provider 形状（镜像 WebSearchProvider /
 * WebFetchProvider）。`available()` 必须**廉价同步**：禁止网络探针、禁止
 * 纸面配置检查（W-B-97/W-A-05）；健康与否经失败时的可诊断错误表达。
 */
interface SeamWebSearchProvider {
  readonly id: string;
  available(): boolean;
  search(request: SeamWebSearchRequest, signal?: AbortSignal): Promise<SeamWebSearchResult>;
}
interface SeamWebFetchProvider {
  readonly id: string;
  available(): boolean;
  fetch(request: SeamWebFetchRequest, signal?: AbortSignal): Promise<SeamWebFetchResult>;
}
/** prompt 节形状（镜像 ctx.systemPrompt.section 的入参子集）。order 必须有限。 */
interface SeamPromptSection {
  readonly name: string;
  readonly order: number;
  readonly text: string;
}
/**
 * 宿主 credentials 域单条解析产物（主线 ResolvedCredential 镜像：主仓
 * packages/credentials/credentials/src/index.ts:118-123 @9da7f7371d；
 * 0.1.2-rc.1 与现世代形状一致。R-4：插件旧约按裸 string 消费导致命中即
 * TypeError，解包归口 creds/resolve.ts unwrapResolvedCredential）。
 */
interface SeamResolvedCredential {
  /** 非空明文密钥。 */
  value: string;
  /** 提供方定义的来源层 id（主线 local provider：env/file/project-env/user-env）。 */
  source: string;
}
/**
 * 凭据解析面（镜像 credentials 域 resolve；每操作起点解析快照 W-B-74）。
 * 主线签名 `resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined>`；
 * 裸 string 为本插件历史契约形状，消费点兼容解包（TC-B4-W1②）。
 */
interface SeamCredentialsRuntime {
  resolve(ref: string): Promise<SeamResolvedCredential | string | undefined>;
}
/** 融合参数（F-104/W-B-16）：与 settings schema 的 fusion 段一一对应。 */
interface FusionParams {
  readonly enabled: boolean;
  /** 时效半衰期（小时）；0 = 关闭时效衰减。 */
  readonly timeDecayHalfLifeH: number;
  /** 权威域加权系数（≥0，1 = 不加权）。 */
  readonly authorityBoost: number;
  /** 同域/单源多样性软折扣（0–1，1 = 不折扣）。 */
  readonly diversityDiscount: number;
}
/** MCP 服务器条目（F-108）：预设目录承载样板、用户条目只存差异（W-B-72）。 */
interface McpServerEntry {
  readonly id: string;
  readonly transport: 'stdio' | 'http';
  /** stdio 启动命令；必须含 `@version` 锁定形态，裸 npx 在校验层拒绝（W-A-02）。 */
  readonly command?: string;
  readonly args?: readonly string[];
  readonly url?: string;
  /** 凭据引用名列表（经 credentials 域每操作解析，绝不存明文）。 */
  readonly credentialRefs?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}
/** 历史回放条目（F-205/pro B-13）：搜索回放来源列表、抓取回放状态与截断标志。 */
interface HistoryEntry {
  readonly kind: 'search' | 'fetch';
  readonly at: number;
  readonly input: string;
  readonly layer?: SearchLayer;
  readonly statusCode?: number;
  readonly sources: readonly {
    url: string;
    title?: string;
  }[];
  readonly truncated?: boolean;
}
/**
 * 浏览器桥接消费面（F-201，卫星包供给）：内核只依赖此接口，配对/WS/心跳等
 * 协议细节全部留在卫星（W-B-05 消费侧解耦）。返回 undefined = 桥当前不可用。
 */
interface SeamBridgeRuntime {
  render(url: string, timeoutMs: number): Promise<{
    content: string;
    statusCode: number;
  } | undefined>;
}
//#endregion
//#region src/engines/engine.d.ts
/**
 * 引擎适配器最小接口（内部契约，区别于宿主 Seam 面）：
 * 所有具体引擎都必须实现 `search(req): Promise<EngineSearchResponse>`。
 */
interface EngineLike {
  readonly descriptor: EngineDescriptor;
  search(req: EngineSearchRequest): Promise<EngineSearchResponse>;
}
//#endregion
//#region src/engines/native-delegate.d.ts
/** 可注入的委托句柄集合：search/fetch 任一缺席即该能力不可用。 */
interface NativeDelegates {
  readonly search?: SeamWebSearchProvider['search'];
  readonly fetch?: SeamWebFetchProvider['fetch'];
}
//#endregion
//#region src/engines/vertical-x.d.ts
/** 卫星包动态导入的最小结构视图（framework + x-search 的消费子集）。 */
interface VerticalHit {
  url: string;
  title: string;
  snippet?: string;
  publishedAt?: string;
  provenance: {
    engine: string;
    via?: string;
    note?: string;
  };
}
interface VerticalRequestView {
  query: string;
  hints: {
    topic?: string;
    siteFilter?: string;
    hard: readonly string[];
    soft: readonly string[];
  };
  count: number;
  signal?: AbortSignal;
}
interface VerticalDepsView {
  search(req: VerticalRequestView): Promise<VerticalHit[]>;
  outboundFetch?: ((req: {
    url: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
    timeoutMs?: number;
    maxBytes: number;
  }) => Promise<{
    status: number;
    text(): Promise<string>;
  }>) | undefined;
}
interface VerticalChannelView {
  readonly id: string;
  run(req: VerticalRequestView, deps: VerticalDepsView): Promise<VerticalHit[]>;
}
interface VerticalPackView {
  XVerticalChannel: new () => VerticalChannelView;
}
/** 免费池搜索回调签名（装配层注入；只跑免费池 id，防垂类递归）。 */
type FreePoolSearchFn = (req: EngineSearchRequest) => Promise<EngineSearchResponse>;
//#endregion
//#region src/cache/store.d.ts
/** 命中/未命中运行统计（`stats()` 返回形状）。 */
interface CacheStats {
  hits: number;
  misses: number;
  size: number;
}
/**
 * 搜索/抓取结果缓存。L0 是按访问序刷新的 Map-LRU；可选注入
 * {@link PersistenceAdapter} 作为 L1：set/delete write-through，
 * get 先查 L0、miss 后回源 L1 并回填 L0。
 */
declare class SearchCache {
  private readonly l0;
  private readonly capacity;
  private readonly ttlTable;
  private readonly adapter;
  private hits;
  private misses;
  constructor(options?: {
    /** L0 容量上限；超限按最久未访问顺序淘汰。默认 {@link L0_MAX_ENTRIES}。 */
    capacity?: number;
    /** 分域 TTL 覆盖表；未覆盖的域回落 {@link DEFAULT_TTL_MS}。 */
    ttlOverrides?: Partial<Record<CacheDomain, number>>;
    /** 可选持久层适配器（L1）。缺省 = 纯内存缓存。 */
    adapter?: PersistenceAdapter;
  });
  /**
   * 读取一个条目。命中即刷新 LRU 访问序；发现已过期则惰性清除
   * （含 L1 侧的过期残留）并计一次 miss。L0 miss 时尝试 L1 回填。
   */
  get(domain: CacheDomain, key: string): Promise<unknown>;
  /**
   * 写入一个条目（值**原样存放**，W-B-32）。L0 同步生效；
   * 注入了 adapter 时 write-through 到 L1。`ttlMs` 缺省用分域默认表。
   */
  set(domain: CacheDomain, key: string, value: unknown, ttlMs?: number): Promise<void>;
  /** 删除一个条目：L0 与 L1 双层同删（幂等）。 */
  delete(domain: CacheDomain, key: string): Promise<void>;
  /**
   * 联合失效入口（W-B-31）：一次性清空全部域的 L0 与 L1。
   * 引擎配置变更/凭据轮换/用户手动清理都走这里。
   */
  clearAll(): Promise<void>;
  /** 运行统计：命中数 / 未命中数 / 当前 L0 条目数。计数器只增不清（诊断用）。 */
  stats(): CacheStats;
  /** 域的有效 TTL（毫秒）：覆盖表优先，否则默认表。 */
  private effectiveTtl;
  /** 分域命名空间：同键字符串跨域互不串扰（宁可 miss 不可错 hit）。 */
  private scopedKey;
  /** 放入 L0 并在超容时按插入序（最久未访问）淘汰头部。 */
  private admit;
}
//#endregion
//#region src/kernel/history.d.ts
/** 构造选项。 */
interface HistoryStoreOptions {
  /** 环形容量上限；超限丢最旧。默认 {@link HISTORY_CAPACITY_DEFAULT}。 */
  readonly capacity?: number;
  /** 可选持久层适配器；缺省 = 纯内存环形。 */
  readonly adapter?: PersistenceAdapter;
}
/**
 * 历史 store：内存环形 + 可选 write-behind 持久层。全部公开方法对调用方
 * 不抛错；`list` 返回最新在前的新数组（防御性拷贝）。
 */
declare class HistoryStore {
  private entries;
  private readonly capacity;
  private readonly adapter;
  private flushScheduled;
  constructor(options?: HistoryStoreOptions);
  /**
   * 记录一条历史：入环尾（最新在尾），超容丢环首；有适配器时调度
   * write-behind 刷写。绝不抛错——非法入参按「未记录」处理。
   */
  record(entry: HistoryEntry): void;
  /** 最新在前返回至多 `limit` 条（缺省全部）；`limit<=0` 返回空。 */
  list(limit?: number): HistoryEntry[];
  /** 当前环内条数（诊断用）。 */
  size(): number;
  /** 清空内存环；有适配器时异步删除持久快照（失败静默）。绝不抛错。 */
  clear(): void;
  /**
   * 回放：从适配器读取上次持久化的快照，形状校验后按 `at` 升序重灌环
   * （超容丢最旧）。无适配器/读失败/垃圾载荷 → 原地不动，绝不抛错。
   */
  load(): Promise<void>;
  /** write-behind 调度：宏任务去抖合并同轮多次 record 为一次全量刷写。 */
  private scheduleFlush;
  private flush;
}
//#endregion
//#region src/kernel/registry.d.ts
/** statusSnapshot 单条目形状（W-B-113/114 的数据源）。 */
interface EngineStatusEntry {
  readonly state: 'ok' | 'cooldown' | 'unwired';
  /** 冷却截止 epoch 毫秒；仅 cooldown 态携带。 */
  readonly cooldownUntil?: number;
  /** 最近一次失败的错误码；仅失败过且未恢复时携带。 */
  readonly lastCode?: string;
}
/**
 * 有序引擎注册表。注册顺序即 fallback 候选顺序（W-B-11）；重复注册按契约
 * 拒绝（镜像宿主 WEB_DUPLICATE_PROVIDER 语义）。
 */
declare class EngineRegistry {
  #private;
  /** 注册引擎实例；返回随 fiber 释放的 disposer。id 冲突按契约拒绝。 */
  register(engine: EngineLike): () => void;
  /** 全部已注册引擎 id（注册序）。 */
  listIds(): string[];
  /** 引擎静态名片；未注册为 undefined。 */
  describe(id: string): EngineDescriptor | undefined;
  /** 按层过滤候选引擎（native→native 档；free→免费池；selfhosted→自托管…注册序）。 */
  candidates(layer: SearchLayer): EngineLike[];
  /**
   * 带 fallback 的顺序执行：`ids` 显式给定候选顺序（未知 id 安全跳过），
   * 缺省回落 candidates(req.layer)。冷却中的候选剔除并记 warning。
   * 终态语义：候选清单为空 → transport/no-candidates；全部候选冷却中 →
   * cooldown/all-cooling；尝试过但无一成功 → 抛最后一个错误；
   * terminal 错误（aborted/ssrf-blocked）随时立即整场终止。
   */
  runWithFallback(req: EngineSearchRequest, ids?: readonly string[]): Promise<EngineSearchResponse>;
  /** 最近一次尝试轨迹导出（doctor 与设置卡「测试」按钮的审计回显来源，最新在前）。 */
  recentAttempts(engineId: string): readonly AttemptRecord[];
  /**
   * 运行状态快照（web_backend_status / doctor / prompt 状态节的数据源）。
   * 只读本地计时与错误码，绝不发探针（W-B-97 纪律对诊断面同样适用）。
   */
  statusSnapshot(): Record<string, EngineStatusEntry>;
  /** 引擎是否处于冷却期。 */
  inCooldown(id: string): boolean;
  private resolveOrder;
  /** 单候选执行：retryable 同候选最多重试 1 次；rate-limited/quota 入冷却。 */
  private runSingle;
  private enterCooldown;
  private markFailure;
  private clearFailure;
  /** 审计轨迹入环形缓冲（超限丢最旧）。 */
  private record;
  /** 失败回显的 i18n warning 键（闭集词表内映射，缺映射则不产生键——W-B-53）。 */
  private warningKeyFor;
}
//#endregion
//#region src/kernel/aggregator.d.ts
/** 聚合器运行快照（W-B-74 起点）：操作起点解析，配置保存即时生效于下一次操作。 */
interface AggregatorSnapshot {
  /** 总开关；false 时 available()=false，seam 自动回落其它 provider 或原生。 */
  enabled: boolean;
  /** 默认路由层。 */
  layer: SearchLayer;
  /** 候选展开开关；false 只用首选单引擎。 */
  autoFallback: boolean;
  /** 结果条数上限（请求未带 maxResults 时生效）。 */
  maxResults: number;
  /** 多引擎 RRF 融合总开关。 */
  fusionEnabled: boolean;
  /** 复杂度分档路由开关。 */
  complexityRouting: boolean;
  /** 抓取回退链首选模式。 */
  fetchMode: FetchMode;
  /** 渲染视图字符上限（canonical 预算由此 ×4 派生并封顶 8 MiB）。 */
  maxContentChars: number;
  /** SSRF G2 豁免清单（host:port 与 CIDR；永不影响 G1/G3/G4）。 */
  ssrfExempts: readonly string[];
  /** 搜索缓存开关。 */
  cacheEnabled: boolean;
  /**
   * 会话联网强制在线（W-B94/W9）：true = 本轮聚合器跳过缓存读（强制
   * fresh），由设置 `mode.sessionOnline === 'on'` 驱动；缺省 false。
   */
  forceFresh?: boolean;
  /**
   * 层候选池覆盖（W9）：mcp 层等动态池经此注入 planSearch；缺席层回落
   * router.LAYER_ENGINE_POOL。
   */
  readonly layerPools?: Partial<Record<SearchLayer, readonly string[]>>;
  /**
   * 垂直腿引擎 id（W9 实验性）：非空且 hints 命中 X/Twitter 触发矩阵时加发
   * 该腿（见 router.hintsTargetVerticalX）。
   */
  readonly verticalEngineIds?: readonly string[];
  /**
   * 融合细参覆盖（半衰期/权威乘子/多样性折扣）；缺席字段回落
   * {@link DEFAULT_FUSION_PARAMS}（与 settings schema `search.fusion.*`
   * 默认值对齐）。
   */
  readonly fusionParams?: Partial<Omit<FusionParams, 'enabled'>>;
  /** 复杂度档预算覆盖（毫秒）；缺席档位回落 {@link BAND_BUDGET_MS}。 */
  readonly bandBudgetMs?: Partial<Record<ComplexityBand, number>>;
}
/** 凭据解析输入视图（装配层提供，操作起点消费；W-B54/74）。 */
interface CredsSourceView {
  /** 设置面遗留字面值表（`engines.<id>.key` / 兼容 `.apiKey`）。 */
  readonly configValues?: Readonly<Record<string, string | undefined>>;
  /** 设置面 credentialRef 表。 */
  readonly credentialsRef?: Readonly<Record<string, string | undefined>>;
  /** 宿主接缝（目前仅消费 credentials.resolve）。 */
  readonly seams?: {
    credentials?: SeamCredentialsRuntime;
  };
}
/** 凭据源回调：每次搜索起点调用一次，返回当时的配置快照视图。 */
type CredsSourceFn = () => CredsSourceView;
/** 构造依赖：注册表与缓存可注入（测试假引擎注入点）；缺省自建空实例。 */
interface AggregatorDeps {
  readonly snapshot: AggregatorSnapshot;
  readonly registry?: EngineRegistry;
  readonly cache?: SearchCache;
  /** 浏览器桥接兜底通道（T3，可选卫星）：fetch 管道失败/内容过短时单次渲染。 */
  readonly bridge?: SeamBridgeRuntime;
  /** 历史环形账本（P1/F-205）：search/fetch 结果回放来源；缺席 = 不记账。 */
  readonly history?: HistoryStore;
  /**
   * 凭据源回调（W9 凭据流贯通）：操作起点解析全部计划引擎的凭据；
   * 缺席 = 全 absent 快照（免费池语义不变）。
   */
  readonly credsSource?: CredsSourceFn;
}
/**
 * WebStack 聚合器。同一实例同时实现搜索与抓取两个 seam 面注册
 * （id 相同、能力种类不同，宿主两本注册簿互不冲突）。
 */
declare class WebstackAggregator implements SeamWebSearchProvider, SeamWebFetchProvider {
  readonly id = "webstack";
  private snapshotField;
  readonly registry: EngineRegistry;
  private cacheField;
  private readonly bridge;
  private readonly historyStore;
  private readonly credsSource;
  /** 最近一次 fetch 的 via 标注（lastFetchVia 只读访问器的后备字段）。 */
  private lastFetchViaField;
  /** 当前缓存实例（attachCache 可热替换，读面经此转发）。 */
  get cache(): SearchCache;
  constructor(deps: AggregatorDeps);
  /**
   * 热替换缓存实例（W9：`cache.persist` 热生效——memory↔durable 切换时由
   * 装配层重建 SearchCache 并经此挂载；旧实例就地废弃，无迁移语义）。
   */
  attachCache(cache: SearchCache): void;
  /**
   * 操作起点刷新快照（settings watch / 配置变化都走到这里）。整对象替换：
   * 快照字段在操作内必须一致（W-B-74），禁止部分更新造成混合态。
   */
  updateSnapshot(snapshot: AggregatorSnapshot): void;
  /** 当前运行快照只读视图（诊断/测试观测点；操作起点一致性 W-B-74）。 */
  get snapshot(): AggregatorSnapshot;
  /**
   * 廉价同步可用性检查（W-B-97）：只读本地状态，绝不发网络探针。
   * 引擎级健康由 registry 失败冷却表达，不在此处。
   */
  available(): boolean;
  search(request: SeamWebSearchRequest, signal?: AbortSignal): Promise<SeamWebSearchResult>;
  /**
   * 归一化命中直出面（W9：web_batch_search 工具与垂类免费池回调共用同一条
   * 聚合管线——凭据解析/缓存/融合/fallback 全一致）；search() 是其 seam 映射。
   */
  searchHits(request: SeamWebSearchRequest, signal?: AbortSignal): Promise<readonly NormalizedHit[]>;
  /**
   * 最近一次 fetch 的出处标注（W-B-16 可解释性在抓取面的延伸）：
   * `'pipeline'` = 静态抓取管线直出；`'bridge'` = T3 桥接兜底产出；
   * 尚未执行过为 undefined。FetchResult 契约无 provenance 位（types 冻结），
   * 该标注经本只读访问器与 `statusCode === 0`（非 HTTP 通道约定）共同表达。
   */
  get lastFetchVia(): string | undefined;
  fetch(request: SeamWebFetchRequest, signal?: AbortSignal): Promise<SeamWebFetchResult>;
  /**
   * T3 桥接兜底（F-201）：桥缺席/渲染失败/超时一律返回 undefined（降级梯，
   * 绝不致命）；成功返回引擎层 FetchResult 形态——statusCode 透传桥值，
   * 桥未给状态码时记 0（types 契约：0 = 经桥接等非 HTTP 通道取得）。
   */
  private bridgeRender;
  /** 引擎层抓取结果 → seam 面 + via 标注记账。 */
  private seamFetchResult;
  /** 计划引擎集 ∩ 注册表；交集为空时按层回落全部已注册候选（保序）。 */
  private wiredEngineIds;
  /** 读缓存并做形状校验：宁可 miss 不可错 hit（W-B-30），坏条目按 miss 处理。 */
  private readCache;
  /** 历史记账（尽力而为）：HistoryStore.record 内部绝不抛错，此处再兜一层。 */
  private recordHistory;
  /** 抛出前统一脱敏：message 经 scrubText，错误码/分类语义原样保留（W-B-56）。 */
  private scrubbed;
  /**
   * 操作起点融合参数：快照覆盖 → 缺省对齐（schema `search.fusion.*` 默认值）；
   * `enabled` 以快照总开关为准（router 已据此决定 plan.fusion）。
   */
  private fusionParamsSnapshot;
  /**
   * 并发跑全部计划引擎（每腿独立 runWithFallback 单候选链），共享一个
   * 复杂度档整体预算：预算到点未归的慢腿记 attempts 'aborted' 被裁掉，
   * 已返回的部分结果照常参与融合（allSettled 语义 + AbortSignal 真取消——
   * 预算信号经 AbortSignal.any 下推进引擎请求，真取消底层外呼）。
   *
   * 结算语义：
   * - caller signal 中止 → 抛 aborted（terminal，整场立即结算，W-B-42）；
   * - 全部腿零命中且存在失败 → 抛首个失败错误（错误如实上呈）；
   * - 全部腿零命中且全部成功 → 返回空结果集（合法空页 ≠ 故障）；
   * - 其余 → 部分结果 + 裁腿审计。
   */
  private runFusedLegs;
  /**
   * 单条融合腿：预算到点仍未归即以 aborted 结算该腿（底层 promise 的迟到
   * 结算被吞掉，绝不产生 unhandled rejection）；caller-abort 由引擎自然抛出、
   * 经 normalizeThrown 归一为闭集码。
   */
  private runLeg;
}
//#endregion
//#region src/mode/online.d.ts
/**
 * Host-owned 会话联网状态机实例（每会话一个）。模式是会话级持久态，
 * 轮次标志是轮级瞬态；两者读写全部收敛在此，禁止旁路缓存。
 */
declare class SessionOnlineState {
  private mode;
  private readonly turnFlags;
  /** 切换会话联网模式；任意时刻可切，立即影响后续判定。 */
  setMode(mode: SessionOnlineMode): void;
  /** 读当前模式（瘦读端：输入区按钮回显用）。 */
  getMode(): SessionOnlineMode;
  /**
   * 开启一轮：为 turnId 建立全新空白标志（覆盖同 id 残留，防串轮）。
   * `ask` 模式的「先征求用户」交互发生在更上层，这里只管状态记账。
   */
  beginTurn(turnId: string): void;
  /**
   * 标记本轮已发起过搜索调用。无论该次调用成败都置位——宽松满足语义
   * （F-107）：模型已经尝试联网，就不必在本轮再强制一次。
   */
  markSearched(turnId: string): void;
  /**
   * 是否应强制走在线路径：`mode === 'on'`（会话级强制）或本轮已搜过
   * （宽松满足）。`off` 且未搜过 → false；`ask` 由上层征询后落点同上。
   */
  shouldForceOnline(turnId: string): boolean;
  /** 结束一轮：回收轮级标志，防长会话内存累积与跨轮误判。 */
  endTurn(turnId: string): void;
}
//#endregion
//#region src/settings/schema.d.ts
/** 单引擎设置节点（`engines.<id>`）。缺字段 = 用全局默认。 */
interface EngineNodeSettings {
  /** 引擎总开关（缺省 true，随注册表默认）。 */
  enabled?: boolean;
  /**
   * 遗留字面值密钥（三级解析链第 1 级；占位符保存时阻断）。
   * `key` 是规范键位；`apiKey` 为历史别名，读取侧 `key ?? apiKey` 兼容。
   */
  key?: string;
  /** 历史别名字面值密钥（与 `key` 同层；新配置一律写 `key`）。 */
  apiKey?: string;
  /** 宿主 credentials 域引用名（三级解析链第 2 级）。 */
  credentialRef?: string;
}
//#endregion
//#region src/i18n/index.d.ts
type Locale = 'zh' | 'en';
//#endregion
//#region src/diag/doctor.d.ts
/** 报告中的单引擎条目（与 registry.EngineStatusEntry 对齐 + 剩余冷却毫秒）。 */
interface DoctorEngineEntry {
  readonly id: string;
  readonly state: 'ok' | 'cooldown' | 'unwired';
  /** 冷却剩余毫秒（cooldown 态必带；其余缺席）。 */
  readonly cooldownRemainingMs?: number;
  /** 最近一次失败错误码（失败过且未恢复时携带）。 */
  readonly lastCode?: string;
}
/** 桥接卫星在报告中的三态词汇（W9：在线 / 离线；缺席 = 不输出该节）。 */
type DoctorBridgeState = 'online' | 'offline';
/** 垂直频道在报告中的三态词汇（W9）：开 / 关 / 开但卫星包缺失。 */
type DoctorVerticalState = 'on' | 'off' | 'pack-missing';
/** 机器可读体检报告（web_backend_status 的 canonical 值同形）。 */
interface DoctorReport {
  readonly tier: TierMode;
  readonly engines: readonly DoctorEngineEntry[];
  readonly cache: {
    readonly hits: number;
    readonly misses: number;
    readonly size: number;
  };
  /** 浏览器桥接卫星状态（W9 加法式增补；缺席 = 装配层未上报，不渲染该行）。 */
  readonly bridge?: DoctorBridgeState;
  /** 垂直频道状态（W9 加法式增补；缺席 = 不渲染该行）。 */
  readonly vertical?: DoctorVerticalState;
}
interface DoctorDeps {
  readonly bitmap: CapabilityBitmap;
  readonly tier: TierMode;
  readonly registry: EngineRegistry;
  readonly cache: SearchCache;
  /**
   * 配置面已知但未注册的引擎 id（如 settings 里启用而接线缺失者）→
   * 报告中以 unwired 态列出；缺省不合并。
   */
  readonly configuredEngineIds?: readonly string[];
  /** 浏览器桥接卫星是否在线（装配层探测结果）；缺省不输出桥接行。 */
  readonly bridgeOnline?: boolean;
  /** 垂直频道当前状态；缺省不输出垂直行。 */
  readonly vertical?: DoctorVerticalState;
}
/**
 * 编排一次体检：registry 状态快照 ∪ 配置面已知引擎 → 统一条目；
 * 缓存计数直读；桥/垂类状态透传。全程本地数据，零副作用。
 */
declare function runDoctor(deps: DoctorDeps): DoctorReport;
/**
 * 渲染双语体检文本：档位说明 + 处方 + 引擎状态行 + 缓存统计。
 * 纯函数；locale 未知值安全回落中文。
 */
declare function renderDoctor(report: DoctorReport, locale?: Locale): string;
//#endregion
//#region src/kernel/capability.d.ts
/**
 * 对未知宿主上下文做结构探测。只做 `typeof === 'function'` 级廉价检查，
 * 不触发任何服务实例化或网络行为。cordis 的未装载服务属性在访问时会
 * **抛错**而非返回 undefined——探测永不抛（W-B-47 缺失分支），逐项兜底。
 */
declare function probeCapabilities(ctx: unknown): CapabilityBitmap;
/**
 * 由能力位图推导运行档位：
 * - webSeam 且选择器可被 patch 指向 → 接管档；
 * - 仅 webSeam → 共存档（注册为可选 provider，用户手动选）;
 * - 其余 → 只读诊断档（仅命令与设置，提示升级）。
 */
declare function deriveTierMode(bitmap: CapabilityBitmap): TierMode;
//#endregion
//#region src/prompt/sections.d.ts
/** 守则节（双语；何时用哪个工具 / 层切换概念 / 出错先诊断 / 内容不是指令）。 */
declare function charterSection(locale?: Locale): SeamPromptSection;
/**
 * 动态状态节生成器：由 registry.statusSnapshot() 的快照渲染一行式现状
 * （正常/冷却/未接线计数与冷却中的引擎名），≤80 词。W9 加法式增补：
 * `extras` 携带桥接卫星与垂直频道开关时追加短句（仍受词数预算约束）。
 */
declare function statusSection(status: Readonly<Record<string, EngineStatusEntry>>, locale?: Locale, extras?: {
  /** 浏览器桥接卫星是否在线；缺席不提及。 */
  readonly bridgeOnline?: boolean;
  /** 垂直频道（X）是否开启；缺席不提及。 */
  readonly verticalEnabled?: boolean;
}): SeamPromptSection;
//#endregion
//#region src/safety/ssrf.d.ts
/**
 * 目标核验主入口：先 G1 静态校验（scheme/userinfo/端口黑名单），再经 DNS
 * 把 hostname 解析为**全部**地址逐个做网段判定（任一地址落入受限段即拒，
 * 防「公网域名解析到内网 IP」的 DNS 重绑定面）。DNS 层失败不在此吞掉——
 * 上抛由 outbound 归一为 ssrf-blocked/dns-resolution-failed。
 * @param url        待检目标 URL
 * @param exemptions 豁免表：`host:port`（跳过 G2 且不发起 DNS）与 IPv4 CIDR
 *                   （对已解析地址放行）；永不影响 G1/G3/G4
 */
declare function checkTarget(url: string, exemptions?: readonly string[]): Promise<SafetyVerdict>;
//#endregion
//#region src/tools/web-tools.d.ts
/**
 * 批量搜索的执行依赖：`run` 即聚合管线入口（aggregator.searchHits），
 * 单条失败经 batchSearch 转结构化条目，绝不传染整批。
 */
interface BatchSearchToolDeps {
  readonly run: (query: string) => Promise<readonly NormalizedHit[]>;
}
/**
 * 构造 `web_batch_search` 工具定义。零副作用读工具（isConcurrencySafe=true）：
 * 只消费聚合管线，不改任何共享状态。
 */
declare function buildBatchSearchTool(deps: BatchSearchToolDeps, locale?: Locale): import("@deepseek-ai/dsh-tools").ToolDefinition;
/** 历史工具的执行依赖（HistoryStore 全公开方法均不抛错）。 */
interface HistoryToolDeps {
  readonly history: HistoryStore;
}
/**
 * 构造 `web_history` 工具定义。`clear` 是唯一写路径（不做并发安全申报，
 * 缺省即独占执行）；`list` 只读本地环形账本，零网络零凭据。
 */
declare function buildHistoryTool(deps: HistoryToolDeps, locale?: Locale): import("@deepseek-ai/dsh-tools").ToolDefinition;
//#endregion
//#region src/index.d.ts
/** Cordis plugin name used by loader diagnostics. */
declare const name = "webstack";
/** Required seam: the web provider registry. Everything else is probed. */
declare const inject: string[];
/** Public plugin configuration type. */
type Config = PluginConfig;
interface PluginConfig {
  /** 总开关；false 时聚合器 available()=false，行为等价回落原生。 */
  enabled?: boolean;
  /** 默认路由层（开箱 `free`：免 Key 引擎池）。 */
  layer?: SearchLayer;
  /** 候选展开开关；false 只用首选单引擎。 */
  autoFallback?: boolean;
  /** 结果条数上限（seam 仍握有最终截断权 W-B-95）。 */
  maxResults?: number;
  /** 查询复杂度分档路由开关。 */
  complexityRouting?: boolean;
  /** 多引擎 RRF 融合总开关。 */
  fusionEnabled?: boolean;
  /** 抓取渲染视图字符上限（canonical 预算 ×4 派生封顶 8 MiB）。 */
  maxContentChars?: number;
  /** SSRF G2 豁免清单（host:port / CIDR；永不影响 G1/G3/G4）。 */
  ssrfExempts?: string[];
  /** 自托管 SearXNG 实例根地址；空串 = 未配置（不注册该引擎）。 */
  searxngBaseUrl?: string;
  /** 会话联网模式（mode.sessionOnline）：`on` 时搜索强制 fresh 跳缓存读。 */
  sessionOnline?: SessionOnlineMode;
  /**
   * 缓存持久层档位（cache.persist）：`durable` 启用 L1——恒为文件适配器
   * （`<home>/.webstack/cache`）。主线 storage 是 hub/forms 架构（全树无
   * getItem/setItem），storage seam 幻影接线已显式放弃（R-5，TC-B4-W1③）。
   */
  cachePersist?: 'memory' | 'durable';
  /**
   * Windows 系统代理兜底（advanced.winProxyFallback，默认 false）：开启时
   * activate 早期探测系统代理并注入 HTTPS_PROXY/HTTP_PROXY（尽力而为层）。
   */
  winProxyFallback?: boolean;
  /** 引擎级配置节点（engines.<id>.key / credentialRef / enabled）。 */
  engines?: Record<string, EngineNodeSettings>;
  /** MCP 服务器条目；过 validateMcpEntry 的才注册为 McpSearchEngine。 */
  mcpServers?: McpServerEntry[];
  /** 垂直卫星包总闸（实验性；默认 false）。 */
  verticalsPackEnabled?: boolean;
  /** X 垂直频道开关键（受 verticalsPackEnabled 约束；默认 false）。 */
  verticalsChannelX?: boolean;
}
/** Plugin schema; omitted fields resolve to the frozen defaults. */
declare const Config: z<PluginConfig>;
/**
 * 组合入口配置 → 聚合器运行快照（操作起点一致性的唯一装配点）。
 * W9：`sessionOnline === 'on'` 映射 forceFresh（跳缓存读）；`layerPools` /
 * `verticalEngineIds` 由调用方按注册矩阵注入（结构动态，静态配置无法表达）。
 */
declare function composeSnapshot(config: PluginConfig, extras?: {
  readonly layerPools?: Partial<Record<SearchLayer, readonly string[]>>;
  readonly verticalEngineIds?: readonly string[];
}): AggregatorSnapshot;
/**
 * 凭据源视图（W9 凭据流贯通）：从组合入口配置抽取 keyed 六家的
 * `engines.<id>.key`（历史别名 `.apiKey` 兼容）与 `credentialRef`，加上宿主
 * credentials seam。每次搜索起点由聚合器调用一次（操作内一致 W-B-74）。
 */
declare function credsSourceViewFrom(config: PluginConfig, seams?: {
  credentials?: SeamCredentialsRuntime;
}): CredsSourceView;
/** 引擎接线的可选钩子（native 句柄捕获与垂类假体注入均为测试接缝）。 */
interface RegistryBuildHooks {
  /** 原生委托句柄（宿主捕获后注入；缺省 = 无委托，search 报 unrepresentable）。 */
  readonly nativeDelegates?: NativeDelegates;
  /** 垂直腿构造钩子（packEnabled&&channels.x 时必填 freePoolSearch）。 */
  readonly vertical?: {
    readonly loadPack?: () => Promise<VerticalPackView | undefined>;
    readonly freePoolSearch: FreePoolSearchFn;
    readonly outboundFetch?: VerticalDepsView['outboundFetch'];
  };
}
/** 注册矩阵构建结果：注册表 + MCP 接线清单 + 垂直腿标记。 */
interface RegistryBuildResult {
  readonly registry: EngineRegistry;
  /** 过 validateMcpEntry 并已注册的 MCP 引擎 id（`mcp-<entryId>`）。 */
  readonly mcpEngineIds: readonly string[];
  /** 配置了但校验失败的 MCP 条目 id（doctor 以 unwired 态列出）。 */
  readonly invalidMcpIds: readonly string[];
  /** 已注册的垂直腿引擎 id；未启用为 undefined。 */
  readonly verticalLegId?: string;
}
/**
 * 引擎注册矩阵（W9 全量）：免费池（ddg/bing-lite）→ 自托管（显式 baseUrl 才
 * 注册）→ keyed 六家（无键即 auth 结构化失败，交 fallback 换候选）→ 原生委托
 * （句柄缺位时同样可诊断地失败）→ MCP（逐条 validateMcpEntry，拒绝项静默跳过
 * 并回传清单供诊断）→ 垂直腿（显式开启才装配）。注册序即 fallback 候选序。
 */
declare function buildEngineRegistry(config: PluginConfig, hooks?: RegistryBuildHooks): RegistryBuildResult;
/** 组装产物（测试与上层诊断的直接观测点；apply 本体只消费不返回）。 */
interface WebstackAssembly {
  readonly capabilities: CapabilityBitmap;
  readonly tier: TierMode;
  readonly registry: EngineRegistry;
  readonly aggregator: WebstackAggregator;
  readonly history: HistoryStore;
  readonly sessionOnline: SessionOnlineState;
  readonly mcpEngineIds: readonly string[];
  readonly invalidMcpIds: readonly string[];
  readonly verticalLegId?: string;
  readonly bridgeOnline: boolean;
  /** 以当前配置刷新聚合器快照 / 会话联网模式 / 缓存栈（settings onChange 复用）。 */
  refresh(): void;
}
/**
 * Register the aggregator into the host web seam when the seam is present;
 * otherwise log the diagnostic tier and stay inert on the data path while the
 * diagnostics seams still come up (capability ladder, F-013).
 */
declare function apply(ctx: Context, config?: PluginConfig): void;
/**
 * 全量装配（W9）：apply 的实体。独立导出以便回归测试直接观测注册矩阵、
 * 凭据流、缓存栈与会话联网状态机，而不必穿透 cordis 生命周期。
 */
declare function assembleWebstack(ctx: Context, config?: PluginConfig): WebstackAssembly;
//#endregion
export { Config, EngineRegistry, PluginConfig, RegistryBuildHooks, RegistryBuildResult, SessionOnlineState, WEBSTACK_PROVIDER_ID, WebstackAggregator, WebstackAssembly, apply, assembleWebstack, buildBatchSearchTool, buildEngineRegistry, buildHistoryTool, charterSection, checkTarget, composeSnapshot, credsSourceViewFrom, deriveTierMode, inject, name, probeCapabilities, renderDoctor, runDoctor, statusSection };