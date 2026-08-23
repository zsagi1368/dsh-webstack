/**
 * 中性聚合器：WebStack 注册进宿主 seam 的唯一 provider 实现（决策一）。
 * 运行时路由（native/free/api/selfhosted/mcp）全部是其内部决策，永不重新打补丁。
 *
 * search 全管线（W-B-74 操作起点快照）：
 * enabled 检查 → extractHints → estimateBand → planSearch → resolveCreds（指纹）
 * → 缓存查询（命中直接回）→ miss 则 singleFlight 包裹：registry.runWithFallback
 * → 多引擎 RRF 轻量融合 → 截断 → 写缓存原文 → 映射 SeamWebSearchResult。
 *
 * fetch 管线：预算从快照派生（canonical = min(maxContentChars×4, 8MiB)）→
 * fetchPipeline（SSRF 四道闸 + 回退链已有实现）→ 映射 SeamWebFetchResult；
 * 目标站 4xx/5xx 是数据如实上呈；管道故障（含 ssrf-blocked）经 scrub 后抛出。
 *
 * @module webstack/kernel/aggregator
 */

import { keyFor, SearchCache, singleFlight } from '../cache/store.ts';
import { credFingerprint, resolveCreds } from '../creds/resolve.ts';
import { fetchPipeline } from '../fetch/pipeline.ts';
import { scrubText } from '../safety/scrub.ts';
import { type EngineError, engineError, normalizeThrown } from './errors.ts';
import { extractHints } from './hints.ts';
import { EngineRegistry } from './registry.ts';
import { estimateBand, planSearch } from './router.ts';
import type {
  ContentBudgets,
  EngineTier,
  FetchMode,
  FetchRequest,
  FetchResult,
  NormalizedHit,
  SeamWebFetchProvider,
  SeamWebFetchRequest,
  SeamWebFetchResult,
  SeamWebSearchProvider,
  SeamWebSearchRequest,
  SeamWebSearchResult,
  SearchLayer,
} from './types.ts';
import { WEBSTACK_PROVIDER_ID } from './types.ts';

/** G4 出站纪律的硬上限：canonical 字节预算封顶 8 MiB。 */
const MAX_BYTES_CAP = 8 * 1024 * 1024;

/** 错误体字符预算（进入上下文前再经 injection 截断转义）。 */
const ERROR_CHARS = 2000;

/** 聚合器运行快照（W-B-74 起点）：操作起点解析，配置保存即时生效于下一次操作。 */
export interface AggregatorSnapshot {
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
}

/** 构造依赖：注册表与缓存可注入（测试假引擎注入点）；缺省自建空实例。 */
export interface AggregatorDeps {
  readonly snapshot: AggregatorSnapshot;
  readonly registry?: EngineRegistry;
  readonly cache?: SearchCache;
}

/** 层 → 计费档位映射（缓存键 tier 维度）。 */
const TIER_OF_LAYER: Readonly<Record<SearchLayer, EngineTier>> = Object.freeze({
  native: 'native',
  free: 'free',
  api: 'keyed',
  selfhosted: 'selfhosted',
  mcp: 'mcp',
});

/**
 * WebStack 聚合器。同一实例同时实现搜索与抓取两个 seam 面注册
 * （id 相同、能力种类不同，宿主两本注册簿互不冲突）。
 */
export class WebstackAggregator implements SeamWebSearchProvider, SeamWebFetchProvider {
  readonly id = WEBSTACK_PROVIDER_ID;

  private snapshot: AggregatorSnapshot;
  readonly registry: EngineRegistry;
  readonly cache: SearchCache;

  constructor(deps: AggregatorDeps) {
    this.snapshot = deps.snapshot;
    this.registry = deps.registry ?? new EngineRegistry();
    this.cache = deps.cache ?? new SearchCache();
  }

  /**
   * 操作起点刷新快照（settings watch / 配置变化都走到这里）。整对象替换：
   * 快照字段在操作内必须一致（W-B-74），禁止部分更新造成混合态。
   */
  updateSnapshot(snapshot: AggregatorSnapshot): void {
    this.snapshot = snapshot;
  }

  /**
   * 廉价同步可用性检查（W-B-97）：只读本地状态，绝不发网络探针。
   * 引擎级健康由 registry 失败冷却表达，不在此处。
   */
  available(): boolean {
    return this.snapshot.enabled;
  }

  async search(request: SeamWebSearchRequest, signal?: AbortSignal): Promise<SeamWebSearchResult> {
    if (!this.snapshot.enabled) {
      throw this.scrubbed(
        engineError('transport', 'webstack provider is disabled', {
          detail: 'disabled',
        }),
      );
    }
    const hints = extractHints(request.query);
    const band = estimateBand(request.query);
    const plan = planSearch(
      {
        layer: this.snapshot.layer,
        autoFallback: this.snapshot.autoFallback,
        fusionEnabled: this.snapshot.fusionEnabled,
        complexityRouting: this.snapshot.complexityRouting,
      },
      hints,
      band,
    );
    const count = request.maxResults ?? this.snapshot.maxResults;

    // 计划引擎集与注册表求交：配置池 id 与实际接线一致时即计划本身；
    // 全部计划 id 未接线时按层回落已注册候选（降级梯，绝不空转）。
    const engineSet = this.wiredEngineIds(plan);

    // 凭据快照：操作起点解析一次（W-B-74）；免费池通常全 absent → 稳定键 'none'。
    const creds = await resolveCreds(engineSet);
    const cacheKey = keyFor({
      layer: plan.layer,
      engineSet,
      count,
      hints,
      tier: TIER_OF_LAYER[plan.layer],
      credFingerprint: credFingerprint(creds),
    });

    const cached = await this.readCache(cacheKey);
    if (cached !== undefined) {
      return toSeamResult(cached);
    }

    try {
      const hits = await singleFlight(`search:${cacheKey}`, async () => {
        // 在飞合并后的二次确认：并发同键调用共享首个 miss 的执行结果。
        const again = await this.readCache(cacheKey);
        if (again !== undefined) return again;
        const req = {
          query: hints.topic ?? request.query,
          hints,
          count,
          layer: plan.layer,
          band,
          ...(signal === undefined ? {} : { signal }),
        };
        const response = await this.registry.runWithFallback(req, engineSet);
        const fused = fuseHits(response.hits, plan.fusion);
        const trimmed = fused.slice(0, Math.max(0, count));
        if (this.snapshot.cacheEnabled && trimmed.length > 0) {
          await this.cache.set('search', cacheKey, trimmed);
        }
        return trimmed;
      });
      return toSeamResult(hits);
    } catch (thrown) {
      throw this.scrubbed(thrown);
    }
  }

  async fetch(request: SeamWebFetchRequest, signal?: AbortSignal): Promise<SeamWebFetchResult> {
    if (!this.snapshot.enabled) {
      throw this.scrubbed(
        engineError('transport', 'webstack provider is disabled', {
          detail: 'disabled',
        }),
      );
    }
    // 三层预算（F-005）：canonical 由渲染预算 ×4 派生并封顶 8 MiB；各层独立不挤占。
    const budgets: ContentBudgets = {
      canonicalChars: Math.min(this.snapshot.maxContentChars * 4, MAX_BYTES_CAP),
      renderedChars: this.snapshot.maxContentChars,
      errorChars: ERROR_CHARS,
    };
    const req: FetchRequest = {
      url: request.url,
      mode: this.snapshot.fetchMode,
      budgets,
      ...(signal === undefined ? {} : { signal }),
    };
    let result: FetchResult;
    try {
      result = await fetchPipeline(req, {
        exemptions: [...this.snapshot.ssrfExempts],
      });
    } catch (thrown) {
      // SSRF 任一闸拒绝映射为 ssrf-blocked 并原样透传（terminal，不做 fallback 绕行）。
      throw this.scrubbed(thrown);
    }
    return {
      url: result.url,
      statusCode: result.statusCode,
      body: { kind: 'text', content: result.content },
      truncated: result.truncated,
    };
  }

  // -------------------------------------------------------------------------
  // 内部机制
  // -------------------------------------------------------------------------

  /** 计划引擎集 ∩ 注册表；交集为空时按层回落全部已注册候选（保序）。 */
  private wiredEngineIds(plan: {
    readonly layer: SearchLayer;
    readonly engineIds: readonly string[];
  }): string[] {
    const planned = plan.engineIds.filter((id) => this.registry.describe(id) !== undefined);
    if (planned.length > 0) return [...planned];
    return this.registry.candidates(plan.layer).map((engine) => engine.descriptor.id);
  }

  /** 读缓存并做形状校验：宁可 miss 不可错 hit（W-B-30），坏条目按 miss 处理。 */
  private async readCache(key: string): Promise<NormalizedHit[] | undefined> {
    if (!this.snapshot.cacheEnabled) return undefined;
    const value: unknown = await this.cache.get('search', key);
    return isNormalizedHitArray(value) ? value : undefined;
  }

  /** 抛出前统一脱敏：message 经 scrubText，错误码/分类语义原样保留（W-B-56）。 */
  private scrubbed(thrown: unknown): EngineError {
    const err = normalizeThrown(thrown);
    const message = scrubText(err.message);
    if (message === err.message) return err;
    return engineError(err.code, message, {
      ...(err.engineId === undefined ? {} : { engineId: err.engineId }),
      ...(err.httpStatus === undefined ? {} : { httpStatus: err.httpStatus }),
      ...(err.retryAfterMs === undefined ? {} : { retryAfterMs: err.retryAfterMs }),
      ...(err.detail === undefined ? {} : { detail: err.detail }),
    });
  }
}

// ---------------------------------------------------------------------------
// 融合与映射辅助（纯函数）
// ---------------------------------------------------------------------------

/** RRF 常数 k：排名倒数加权的平滑项（轻量融合固定值）。 */
export const RRF_K = 60;

/**
 * RRF 轻量融合：每引擎排名倒数加权 Σ 1/(k+rank)。同 URL 去重——保留组内
 * 排名最高者的 title/snippet/publishedAt/provenance，但 `url` 字段恒取首见
 * 原样字符串（W-B-35：身份归一只发生在比较内部，不改写表示）。
 * 单来源引擎直出时原样返回，不写归一化分；多来源时 provenance.score 写
 * 归一化分（组最高分为 1）。
 */
export function fuseHits(hits: readonly NormalizedHit[], fusion: boolean): NormalizedHit[] {
  if (!fusion || hits.length <= 1) return [...hits];
  const engines = new Set(hits.map((hit) => hit.provenance.engine));
  if (engines.size <= 1) return [...hits];

  interface Group {
    firstUrl: string;
    best: NormalizedHit;
    bestRank: number;
    score: number;
    order: number;
  }
  const groups = new Map<string, Group>();
  const perEngineRank = new Map<string, number>();
  for (let index = 0; index < hits.length; index++) {
    const hit = hits[index] as NormalizedHit;
    const engineId = hit.provenance.engine;
    const rank = (perEngineRank.get(engineId) ?? 0) + 1;
    perEngineRank.set(engineId, rank);
    const contribution = 1 / (RRF_K + rank);
    const identity = identityOf(hit.url);
    const existing = groups.get(identity);
    if (existing !== undefined) {
      existing.score += contribution;
      if (rank < existing.bestRank) {
        existing.best = hit;
        existing.bestRank = rank;
      }
      continue;
    }
    groups.set(identity, {
      firstUrl: hit.url,
      best: hit,
      bestRank: rank,
      score: contribution,
      order: index,
    });
  }

  const ordered = [...groups.values()].toSorted((a, b) => b.score - a.score || a.order - b.order);
  const maxScore = ordered[0]?.score ?? 1;
  return ordered.map((group) => {
    const normalized = maxScore > 0 ? group.score / maxScore : group.score;
    const base = group.best;
    return {
      ...base,
      url: group.firstUrl,
      provenance: { ...base.provenance, score: Number(normalized.toFixed(6)) },
    };
  });
}

/** URL 身份键：可解析则用规范化 href 比较，不可解析退回原样字符串。 */
function identityOf(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

/** NormalizedHit[] 形状守卫（缓存读出的 unknown 收窄）。 */
function isNormalizedHitArray(value: unknown): value is NormalizedHit[] {
  if (!Array.isArray(value)) return false;
  return value.every((entry) => {
    if (typeof entry !== 'object' || entry === null) return false;
    const record = entry as Record<string, unknown>;
    return (
      typeof record.url === 'string' &&
      typeof record.title === 'string' &&
      typeof record.provenance === 'object' &&
      record.provenance !== null
    );
  });
}

/** 引擎命中 → 宿主 seam 引用源（缺失字段保持缺失，不编造占位值 W-B-93）。 */
function toSeamResult(hits: readonly NormalizedHit[]): SeamWebSearchResult {
  return {
    sources: hits.map((hit) => ({
      url: hit.url,
      title: hit.title,
      ...(hit.snippet === undefined ? {} : { snippet: hit.snippet }),
      ...(hit.publishedAt === undefined ? {} : { publishedAt: hit.publishedAt }),
    })),
    truncated: false,
  };
}
