/**
 * TC-B4-W5 锁组⑤：复杂度分带行为锁（PLAN:197「复杂度分带可后置」授权项，
 * 本卡定夺=**锁化优先**）。定夺理由：kernel/router.ts 是纯函数决策表
 * （无状态、无网络面、estimateBand/planSearch 全可注入），穷举网格可稳定
 * 单元锁——满足卡面「决策表可稳定单元锁则优先锁化」条件，不走登记文书。
 *
 * 断言依据 = 亲读实际语义（禁臆测）：
 * - estimateBand（router.ts:69-74）：trim 后 len≤16 且不含操作符
 *   （`\bsite:`|直/弯引号）→ simple；len≤48 → medium；其余 complex。
 *   `\b` 词边界语义：'megasite:x' 不命中操作符（边界不成立）。
 * - planSearch（router.ts:115-139）：width=simple 1 / medium 2 / complex
 *   全池；autoFallback=false → 恒 1；complexityRouting=false → 一律按
 *   medium 宽度；fusion=fusionEnabled && 终选数>1；层池 layerPools 覆盖、
 *   缺席回落 LAYER_ENGINE_POOL（api=KEYED_ENGINE_IDS 单一事实源）；
 *   vertical 加发仅当 autoFallback && 名单非空 && hints 命中触发矩阵，
 *   追加计划尾部（不动首选序）。
 * - normalizeLayer：五层词汇闭集内保留，未知/缺席回落 'free'。
 *
 * 负对照形制（零改源）：决策表本身=数据化冻结锁（逐行硬编码期望，任何宽度/
 * 融合/加发规则漂移即红）；另附「坏宽度孪生」（simple 降为 medium 宽度）
 * 在同表判定函数下失配行数 >0——同表红绿分布自证判别力，绝不恒绿。
 * 零真实网络：router 为纯函数层，本文件不安装任何 fetch 面（结构自证）。
 */
import { describe, expect, it } from 'vitest';
import { KEYED_ENGINE_IDS } from '../src/engines/engine.ts';
import {
  estimateBand,
  hintsTargetVerticalX,
  LAYER_ENGINE_POOL,
  normalizeLayer,
  planSearch,
  type RouterConfigSnapshot,
} from '../src/kernel/router.ts';
import type { ComplexityBand, SearchHints } from '../src/kernel/types.ts';

/** 无特征 hints（不触发垂直矩阵、不带操作符）。 */
const HINTS: SearchHints = { hard: [], soft: [] };
/** 命中垂直触发矩阵的 hints（router.ts:38「推特」词）。 */
const HINTS_X: SearchHints = { topic: '推特', hard: [], soft: [] };

function cfg(overrides: Partial<RouterConfigSnapshot> = {}): RouterConfigSnapshot {
  return {
    layer: 'api',
    autoFallback: true,
    fusionEnabled: true,
    complexityRouting: true,
    ...overrides,
  };
}

const SIX = [...KEYED_ENGINE_IDS]; // [tavily, brave, exa, jina, firecrawl, anysearch]

// ---------------------------------------------------------------------------
// estimateBand 分档边界穷举表（冻结规则直译）
// ---------------------------------------------------------------------------

const BAND_TABLE: readonly { name: string; query: string; expected: ComplexityBand }[] = [
  { name: '空串（trim 后 len 0）→ simple', query: '   ', expected: 'simple' },
  { name: '短词 → simple', query: 'cat', expected: 'simple' },
  { name: '恰好 16 字符 → simple（≤16 边界）', query: 'a'.repeat(16), expected: 'simple' },
  { name: '17 字符 → medium（16/17 边界对）', query: 'a'.repeat(17), expected: 'medium' },
  { name: '恰好 48 字符 → medium（48/49 边界对）', query: 'a'.repeat(48), expected: 'medium' },
  { name: '49 字符 → complex', query: 'a'.repeat(49), expected: 'complex' },
  { name: '两端空白 trim 后 ≤16 → simple', query: '  hello world  ', expected: 'simple' },
  {
    name: '≤16 但含 site: 操作符 → medium（长度让位操作符）',
    query: 'site:a.com',
    expected: 'medium',
  },
  { name: '≤16 但含直引号短语 → medium', query: '"deepseek"', expected: 'medium' },
  { name: '≤16 但含弯引号 → medium', query: '“深度求索”', expected: 'medium' },
  { name: '\\b 词边界：megasite: 不视为操作符 → simple', query: 'megasite:x', expected: 'simple' },
  { name: '词首 site: 命中 \\b → medium', query: 'site:x.com 深度', expected: 'medium' },
];

describe('W5 锁组⑤ · estimateBand 分档决策表（穷举边界）', () => {
  for (const row of BAND_TABLE) {
    it(row.name, () => {
      expect(estimateBand(row.query)).toBe(row.expected);
    });
  }
});

// ---------------------------------------------------------------------------
// planSearch 规划决策表（数据化冻结锁：逐行硬编码期望）
// ---------------------------------------------------------------------------

interface PlanRow {
  readonly name: string;
  readonly config: RouterConfigSnapshot;
  readonly hints: SearchHints;
  readonly band: ComplexityBand;
  readonly expectedIds: readonly string[];
  readonly expectedFusion: boolean;
}

const PLAN_TABLE: readonly PlanRow[] = [
  // ---- api 层（六家池：宽度 1/2/6 全可辨）--------------------------------
  {
    name: 'api·simple → 池首 1 家，不融合',
    config: cfg(),
    hints: HINTS,
    band: 'simple',
    expectedIds: ['tavily'],
    expectedFusion: false,
  },
  {
    name: 'api·medium → 前 2 家 + 融合',
    config: cfg(),
    hints: HINTS,
    band: 'medium',
    expectedIds: ['tavily', 'brave'],
    expectedFusion: true,
  },
  {
    name: 'api·complex → 全池 6 家 + 融合',
    config: cfg(),
    hints: HINTS,
    band: 'complex',
    expectedIds: SIX,
    expectedFusion: true,
  },
  {
    name: 'autoFallback=false：complex 也只首选 1 家、不融合（纪律行）',
    config: cfg({ autoFallback: false }),
    hints: HINTS,
    band: 'complex',
    expectedIds: ['tavily'],
    expectedFusion: false,
  },
  {
    name: 'autoFallback=false：medium 同样收敛 1 家',
    config: cfg({ autoFallback: false }),
    hints: HINTS,
    band: 'medium',
    expectedIds: ['tavily'],
    expectedFusion: false,
  },
  {
    name: 'complexityRouting=false：complex 一律按 medium 宽度（2 家）',
    config: cfg({ complexityRouting: false }),
    hints: HINTS,
    band: 'complex',
    expectedIds: ['tavily', 'brave'],
    expectedFusion: true,
  },
  {
    name: 'complexityRouting=false：simple 也按 medium 宽度（不自适应）',
    config: cfg({ complexityRouting: false }),
    hints: HINTS,
    band: 'simple',
    expectedIds: ['tavily', 'brave'],
    expectedFusion: true,
  },
  {
    name: 'fusionEnabled=false：complex 多引擎也不融合',
    config: cfg({ fusionEnabled: false }),
    hints: HINTS,
    band: 'complex',
    expectedIds: SIX,
    expectedFusion: false,
  },
  {
    name: 'fusionEnabled=false：medium 不融合',
    config: cfg({ fusionEnabled: false }),
    hints: HINTS,
    band: 'medium',
    expectedIds: ['tavily', 'brave'],
    expectedFusion: false,
  },
  // ---- free 层（两家池：complex=全池与 medium 等宽）-----------------------
  {
    name: 'free·simple → [ddg] 单发',
    config: cfg({ layer: 'free' }),
    hints: HINTS,
    band: 'simple',
    expectedIds: ['ddg'],
    expectedFusion: false,
  },
  {
    name: 'free·complex → 全池两家 + 融合（池宽即上限）',
    config: cfg({ layer: 'free' }),
    hints: HINTS,
    band: 'complex',
    expectedIds: ['ddg', 'bing-lite'],
    expectedFusion: true,
  },
  // ---- native/selfhosted/mcp 层池语义 --------------------------------------
  {
    name: 'native·complex → 单引擎池，融合恒假',
    config: cfg({ layer: 'native' }),
    hints: HINTS,
    band: 'complex',
    expectedIds: ['native'],
    expectedFusion: false,
  },
  {
    name: 'mcp 静态池为空：无 layerPools 覆盖 → 空计划（负例行）',
    config: cfg({ layer: 'mcp' }),
    hints: HINTS,
    band: 'complex',
    expectedIds: [],
    expectedFusion: false,
  },
  {
    name: 'mcp 动态池经 layerPools 注入：complex 全池 + 融合',
    config: cfg({ layer: 'mcp', layerPools: { mcp: ['mcp-a', 'mcp-b'] } }),
    hints: HINTS,
    band: 'complex',
    expectedIds: ['mcp-a', 'mcp-b'],
    expectedFusion: true,
  },
  {
    name: 'layerPools 覆盖 api 池：simple 取覆盖池首',
    config: cfg({ layerPools: { api: ['exa', 'tavily'] } }),
    hints: HINTS,
    band: 'simple',
    expectedIds: ['exa'],
    expectedFusion: false,
  },
  // ---- 垂直加发腿（触发矩阵 × autoFallback 纪律）--------------------------
  {
    name: '垂直命中（推特）：complex 六家尾部加发 x-vertical（首选序不动）',
    config: cfg({ verticalEngineIds: ['x-vertical'] }),
    hints: HINTS_X,
    band: 'complex',
    expectedIds: [...SIX, 'x-vertical'],
    expectedFusion: true,
  },
  {
    name: '垂直命中但 autoFallback=false：尊重单引擎纪律不加发',
    config: cfg({ autoFallback: false, verticalEngineIds: ['x-vertical'] }),
    hints: HINTS_X,
    band: 'complex',
    expectedIds: ['tavily'],
    expectedFusion: false,
  },
  {
    name: '垂直名单在位但 hints 未命中：不加发（触发矩阵负例）',
    config: cfg({ verticalEngineIds: ['x-vertical'] }),
    hints: HINTS,
    band: 'complex',
    expectedIds: SIX,
    expectedFusion: true,
  },
];

/** 表判定函数：返回失配行数（真实现期望 0；坏孪生期望 >0——判别力自证）。 */
function tableMismatches(planFn: typeof planSearch): number {
  let mismatches = 0;
  for (const row of PLAN_TABLE) {
    const plan = planFn(row.config, row.hints, row.band);
    const idsOk =
      plan.engineIds.length === row.expectedIds.length &&
      plan.engineIds.every((id, i) => id === row.expectedIds[i]);
    if (!idsOk || plan.fusion !== row.expectedFusion || plan.layer !== row.config.layer) {
      mismatches++;
    }
  }
  return mismatches;
}

describe('W5 锁组⑤ · planSearch 规划决策表（数据化冻结锁）', () => {
  for (const row of PLAN_TABLE) {
    it(row.name, () => {
      const plan = planSearch(row.config, row.hints, row.band);
      expect(plan.layer).toBe(row.config.layer);
      expect([...plan.engineIds]).toEqual([...row.expectedIds]);
      expect(plan.fusion).toBe(row.expectedFusion);
    });
  }

  it('全表判定：真实现 0 失配；坏宽度孪生（simple→medium 降格）>0 失配——判别力自证', () => {
    expect(tableMismatches(planSearch)).toBe(0); // 绿腿：决策表全行通过
    const brokenPlan: typeof planSearch = (config, hints, band) =>
      planSearch(config, hints, band === 'simple' ? 'medium' : band); // 宽度变异孪生
    expect(tableMismatches(brokenPlan)).toBeGreaterThan(0); // 红腿：同表立即失配
  });

  it('确定性锁：同 (config,hints,band) 两次规划深等（纯函数=缓存键前提）', () => {
    const a = planSearch(cfg(), HINTS_X, 'complex');
    const b = planSearch(cfg(), HINTS_X, 'complex');
    expect(b).toEqual(a);
  });
});

// ---------------------------------------------------------------------------
// 层池常量与守卫（决策表的锚定面）
// ---------------------------------------------------------------------------

describe('W5 锁组⑤ · 层池常量与 normalizeLayer 守卫', () => {
  it('LAYER_ENGINE_POOL 冻结表：api 池=KEYED_ENGINE_IDS 单一事实源；mcp 静态池空', () => {
    expect(LAYER_ENGINE_POOL.free).toEqual(['ddg', 'bing-lite']);
    expect(LAYER_ENGINE_POOL.api).toEqual([...KEYED_ENGINE_IDS]);
    expect(LAYER_ENGINE_POOL.selfhosted).toEqual(['searxng']);
    expect(LAYER_ENGINE_POOL.native).toEqual(['native']);
    expect(LAYER_ENGINE_POOL.mcp).toEqual([]); // 动态池只能经 layerPools 注入
    expect(Object.isFrozen(LAYER_ENGINE_POOL)).toBe(true);
  });

  it('normalizeLayer：五层词汇保留；未知/缺席回落 free（负对照行内红绿）', () => {
    for (const layer of ['native', 'free', 'api', 'selfhosted', 'mcp'] as const) {
      expect(normalizeLayer(layer)).toBe(layer); // 绿腿：闭集内原样
    }
    expect(normalizeLayer('cloud')).toBe('free'); // 红腿：未知值安全回落
    expect(normalizeLayer('')).toBe('free');
    expect(normalizeLayer(undefined)).toBe('free');
  });

  it('hintsTargetVerticalX 触发矩阵：站点指称/推特词/独立 X 命中；xbox 类连写不命中', () => {
    expect(hintsTargetVerticalX({ ...HINTS, siteFilter: 'x.com' })).toBe(true);
    expect(hintsTargetVerticalX({ ...HINTS, siteFilter: 'sub.twitter.com' })).toBe(true);
    expect(hintsTargetVerticalX(HINTS_X)).toBe(true); // 「推特」主题词
    expect(hintsTargetVerticalX({ ...HINTS, hard: ['check X out'] })).toBe(true); // 独立词 X
    expect(hintsTargetVerticalX({ ...HINTS, topic: 'xbox 攻略' })).toBe(false); // 连写不命中
    expect(hintsTargetVerticalX(HINTS)).toBe(false); // 无特征不命中
  });
});
