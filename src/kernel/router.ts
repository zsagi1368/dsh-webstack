/**
 * 层级路由与复杂度分档（W-B-12/14）：native/free/api/selfhosted/mcp 选层 +
 * simple/medium/complex 分档定引擎集合宽度与是否融合。
 * 纯函数、无状态：同一 (config, hints, band) 输入永远得到同一计划——
 * 计划进入缓存键维度（engineSet），确定性是缓存正确性的前提。
 *
 * @module webstack/kernel/router
 */

// hints 参数位为契约签名保留（W-B-15 软偏好下推属后续波次）；下划线前缀即弃用标记。
import type { ComplexityBand, SearchHints, SearchLayer } from './types.ts';
import { SEARCH_LAYERS } from './types.ts';

/** 层词汇守卫：未知配置值安全回落 `free`（开箱默认层）。 */
export function normalizeLayer(value: string | undefined): SearchLayer {
  return (SEARCH_LAYERS as readonly string[]).includes(value ?? '')
    ? (value as SearchLayer)
    : 'free';
}

/** 各层的候选引擎 id 池（注册序即优先序；api/mcp 本期池为空）。 */
export const LAYER_ENGINE_POOL: Readonly<Record<SearchLayer, readonly string[]>> = Object.freeze({
  native: ['native'],
  free: ['ddg', 'bing-lite'],
  api: [],
  selfhosted: ['searxng'],
  mcp: [],
});

/** 查询操作符字形（`site:` 与引号短语）——带操作符的查询不再视为 simple。 */
const OPERATOR_HINT = /\bsite:|["“”]/;

/**
 * 查询特征 → 复杂度分档（冻结规则）：
 * - 长度 ≤16 且不含操作符 → simple；
 * - 长度 ≤48 → medium；
 * - 其余 → complex。
 */
export function estimateBand(query: string): ComplexityBand {
  const q = query.trim();
  if (q.length <= 16 && !OPERATOR_HINT.test(q)) return 'simple';
  if (q.length <= 48) return 'medium';
  return 'complex';
}

/** 路由器消费的配置快照（操作起点固定，W-B-74）。 */
export interface RouterConfigSnapshot {
  /** 默认路由层。 */
  readonly layer: SearchLayer;
  /** false = 只用首选单引擎，不做候选展开。 */
  readonly autoFallback: boolean;
  /** 多引擎结果的 RRF 融合总开关。 */
  readonly fusionEnabled: boolean;
  /** 复杂度分档路由开关；关闭时按 medium 固定宽度取池。 */
  readonly complexityRouting: boolean;
}

/** 一次搜索的执行计划（aggregator 与缓存键的共同输入）。 */
export interface SearchPlan {
  readonly layer: SearchLayer;
  /** 参与本次的引擎 id（顺序即 fallback 候选顺序）。 */
  readonly engineIds: readonly string[];
  /** 是否对多引擎结果做 RRF 轻量融合。 */
  readonly fusion: boolean;
}

/**
 * 由配置快照 + 分档产出执行计划：
 * - simple → 池首 1 个；medium → 前 2 个；complex → 全池 + fusion；
 * - autoFallback=false → 无论分档，只返回首选单引擎；
 * - complexityRouting=false → 一律按 medium 宽度取池（不自适应）；
 * - fusion 仅在多引擎且 fusionEnabled 时开启。
 */
export function planSearch(
  config: RouterConfigSnapshot,
  _hints: SearchHints,
  band: ComplexityBand,
): SearchPlan {
  const pool = LAYER_ENGINE_POOL[config.layer] ?? [];
  const effectiveBand: ComplexityBand = config.complexityRouting ? band : 'medium';
  let width = effectiveBand === 'simple' ? 1 : effectiveBand === 'medium' ? 2 : pool.length;
  if (!config.autoFallback) width = 1;
  const engineIds = pool.slice(0, Math.max(0, Math.min(width, pool.length)));
  return {
    layer: config.layer,
    engineIds,
    fusion: config.fusionEnabled && engineIds.length > 1,
  };
}
