/**
 * TC-B4-W4 锁⑤：RRF 融合正确性锁——kernel/fusion.ts 融合排序**确定性**
 * （同输入同输出）+ **同分稳定序**（并列项次序可复现）。
 *
 * 断言依据 = 亲读 kernel/fusion.ts 实际语义（禁臆测）：
 * - 纯函数无状态（fusion.ts:5 头注释 + 实现无模块级可变状态）；`now` 可注入
 *   固定时钟（fusion.ts:115），本锁全程注入 NOW，零 Date.now 依赖；
 * - 并列裁决规则两处：组分降序行走 `toSorted((a,b)=>b.score-a.score ||
 *   a.order-b.order)`（fusion.ts:156）与终排 `toSorted((a,b)=>b.final-a.final
 *   || a.position-b.position)`（fusion.ts:169）——并列一律保首见序派生位序；
 * - 组代表替换条件为**严格大于**（fusion.ts:145 `occurrence > existing.bestScore`）
 *   → 同分出现时代表保持首见命中（可复现）；
 * - 输入集合不被修改（fusion.ts:110-111 文档语义，冻结输入下运行即自证）。
 *
 * 负对照（本卡纪律，零改源）：坏语义孪生就地在测试内构造——
 * (a) 并列裁决反序（首见序降序）参照面在「稳定并列序」谓词下为假；
 * (b) 有状态融合（跨调用累计漂移）参照面在「确定性」谓词下为假。
 * 真实现同谓词全绿——红绿分布自证判别力，绝不恒绿。零真实网络（纯函数直调）。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_FUSION_PARAMS, fuse, RRF_K } from '../src/kernel/fusion.ts';
import type { FusionParams, NormalizedHit } from '../src/kernel/types.ts';

/** 固定时钟（epoch 毫秒）：确定性断言的注入参考点（fusion.ts:115）。 */
const NOW = 1_800_000_000_000;

function hit(
  url: string,
  engine: string,
  extra: { title?: string; publishedAt?: string } = {},
): NormalizedHit {
  return {
    url,
    title: extra.title ?? url,
    ...(extra.publishedAt === undefined ? {} : { publishedAt: extra.publishedAt }),
    provenance: { engine },
  };
}

function params(overrides: Partial<Omit<FusionParams, 'enabled'>> = {}): FusionParams {
  return { ...DEFAULT_FUSION_PARAMS, enabled: true, ...overrides };
}

/** 富输入工厂：跨集重复 URL + 权威域 + 时效衰减 + 折扣——每次调用产全新对象。 */
function buildRichSets(): NormalizedHit[][] {
  return [
    [
      hit('https://github.com/org/repo', 'ddg', { title: 'gh' }),
      hit('https://dup.example/page', 'ddg', {
        title: 'dup-stale',
        publishedAt: new Date(NOW - 48 * 3_600_000).toISOString(),
      }),
      hit('https://plain.example/a', 'ddg'),
    ],
    [
      hit('https://dup.example/page', 'bing-lite', { title: 'dup-fresh' }),
      hit('https://arxiv.org/abs/1', 'bing-lite'),
      hit('https://plain.example/b', 'bing-lite'),
    ],
  ];
}

// ---------------------------------------------------------------------------
// 性质谓词（绿腿/红腿共用同一判定——判别力自证的单一事实源）
// ---------------------------------------------------------------------------

/**
 * 确定性谓词：同一 thunk 多次调用产出 JSON 规范串逐位一致（输出为纯 JSON
 * 数据、键序由同一代码路径决定，串比较即深等比较）。
 */
function isDeterministic(thunk: () => unknown, times = 3): boolean {
  const first = JSON.stringify(thunk());
  for (let i = 1; i < times; i++) {
    if (JSON.stringify(thunk()) !== first) return false;
  }
  return true;
}

/** 并列组数据（谓词/孪生共用的最小面：组分 + 全局首见序）。 */
interface TieGroup {
  readonly url: string;
  readonly score: number;
  readonly order: number;
}

/**
 * 稳定并列序谓词：输出序 = 「分降序、并列保全局首见序升序」——
 * fusion.ts:156/169 亲读裁决规则的直译。
 */
function isStableTieOrder(urls: readonly string[], groups: readonly TieGroup[]): boolean {
  const expected = [...groups]
    .toSorted((a, b) => b.score - a.score || a.order - b.order)
    .map((group) => group.url);
  return urls.length === expected.length && urls.every((url, i) => url === expected[i]);
}

// ---------------------------------------------------------------------------
// 坏语义孪生参照面（负对照红腿专用；测试内构造，零改源）
// ---------------------------------------------------------------------------

/** 坏孪生·并列反序：同组数据、并列裁决改为首见序**降序**——稳定序谓词立即红。 */
function brokenTieSort(groups: readonly TieGroup[]): string[] {
  return [...groups]
    .toSorted((a, b) => b.score - a.score || b.order - a.order)
    .map((group) => group.url);
}

/** 坏孪生·有状态融合：跨调用累计漂移（建模「非纯函数」缺陷面）——确定性谓词红。 */
class StatefulFusion {
  private drift = 0;
  run(sets: readonly NormalizedHit[][], fusionParams: FusionParams, now: number): NormalizedHit[] {
    this.drift += 1;
    return fuse(sets, fusionParams, now).map((entry) => ({
      ...entry,
      provenance: { ...entry.provenance, score: (entry.provenance.score ?? 0) + this.drift / 1000 },
    }));
  }
}

// ---------------------------------------------------------------------------
// 锁⑤-A：融合确定性（同输入同输出）
// ---------------------------------------------------------------------------

describe('W4 锁⑤ · RRF 融合确定性（同输入同输出，纯函数）', () => {
  it('正例（绿腿）：富输入固定 now 下三次调用输出逐次深等', () => {
    const sets = buildRichSets();
    const p = params({ timeDecayHalfLifeH: 24, authorityBoost: 1.5, diversityDiscount: 0.85 });
    const out1 = fuse(sets, p, NOW);
    const out2 = fuse(sets, p, NOW);
    const out3 = fuse(sets, p, NOW);
    expect(out2).toEqual(out1);
    expect(out3).toEqual(out1);
    expect(out1.length).toBeGreaterThan(1); // 非平凡输出（防恒空恒绿）
    expect(isDeterministic(() => fuse(sets, p, NOW))).toBe(true);
  });

  it('正例：值相同而对象身份不同的输入 → 输出深等（值决定论，非引用决定论）', () => {
    const p = params();
    const outA = fuse(buildRichSets(), p, NOW);
    const outB = fuse(buildRichSets(), p, NOW); // 全新对象图、同值
    expect(outB).toEqual(outA);
  });

  it('正例：冻结命中对象下运行不抛（输入零改写自证）且输出为全新对象', () => {
    const sets = buildRichSets();
    for (const set of sets) {
      for (const entry of set) Object.freeze(entry); // ESM 严格模式：改写冻结对象必抛
    }
    const snapshot = JSON.stringify(sets);
    const out = fuse(sets, params({ authorityBoost: 1.5 }), NOW);
    expect(out.length).toBeGreaterThan(0); // 若 fuse 改写任一输入命中，此处早已 TypeError
    expect(JSON.stringify(sets)).toBe(snapshot); // 数组/条目内容零漂移（fusion.ts:110-111）
    // 输出条目是新对象（spread 拷贝，fusion.ts:175-183 亲读），不共享输入引用。
    const inputRefs = new Set<NormalizedHit>(sets.flat());
    expect(out.every((entry) => !inputRefs.has(entry) && !Object.isFrozen(entry))).toBe(true);
  });

  it('负对照（红腿·判别力自证）：有状态融合孪生在同一确定性谓词下为假', () => {
    const sets = buildRichSets();
    const stateful = new StatefulFusion();
    expect(isDeterministic(() => stateful.run(sets, params(), NOW))).toBe(false); // 漂移即红
    expect(isDeterministic(() => fuse(sets, params(), NOW))).toBe(true); // 真实现同谓词绿
  });
});

// ---------------------------------------------------------------------------
// 锁⑤-B：同分稳定序（并列项次序可复现）
// ---------------------------------------------------------------------------

describe('W4 锁⑤ · 同分稳定序（并列保首见序，次序可复现）', () => {
  /**
   * 跨集同 rank 并列构造：A/B 各为所在集 rank1（组分同 = 1/61），X/Y 各为
   * rank2（同 = 1/62）；四 host 互异 → 多样性折扣不介入（首条 discount^0=1）。
   * 全局首见序：A(0) X(1) B(2) Y(3) → 锁定义望输出 [A, B, X, Y]。
   */
  const A = 'https://tie-a.example/1';
  const X = 'https://tie-x.example/2';
  const B = 'https://tie-b.example/1';
  const Y = 'https://tie-y.example/2';
  const TIE_GROUPS: readonly TieGroup[] = [
    { url: A, score: 1 / (RRF_K + 1), order: 0 },
    { url: X, score: 1 / (RRF_K + 2), order: 1 },
    { url: B, score: 1 / (RRF_K + 1), order: 2 },
    { url: Y, score: 1 / (RRF_K + 2), order: 3 },
  ];
  const TIE_SETS = (): NormalizedHit[][] => [
    [hit(A, 'ddg'), hit(X, 'ddg')],
    [hit(B, 'bing-lite'), hit(Y, 'bing-lite')],
  ];

  it('正例（绿腿）：同分并列按全局首见序输出，归一分并列可辨，重复调用序不变', () => {
    const out1 = fuse(TIE_SETS(), params(), NOW);
    expect(out1.map((entry) => entry.url)).toEqual([A, B, X, Y]);
    expect(
      isStableTieOrder(
        out1.map((entry) => entry.url),
        TIE_GROUPS,
      ),
    ).toBe(true);
    // 并列分锁：A/B 同为最高组分 → 归一分同为 1；X/Y 同为 61/62。
    const expectedXY = Number((1 / (RRF_K + 2) / (1 / (RRF_K + 1))).toFixed(6));
    expect(out1.map((entry) => entry.provenance.score)).toEqual([1, 1, expectedXY, expectedXY]);
    // 可复现：二次调用（全新输入对象）序与分逐位一致。
    const out2 = fuse(TIE_SETS(), params(), NOW);
    expect(out2).toEqual(out1);
  });

  it('正例：三集单命中全并列（同 rank1）→ 输出=集序首见，全分归一为 1', () => {
    const u1 = 'https://tri-1.example/x';
    const u2 = 'https://tri-2.example/x';
    const u3 = 'https://tri-3.example/x';
    const out = fuse(
      [[hit(u1, 'ddg')], [hit(u2, 'bing-lite')], [hit(u3, 'searxng')]],
      params(),
      NOW,
    );
    expect(out.map((entry) => entry.url)).toEqual([u1, u2, u3]);
    expect(out.map((entry) => entry.provenance.score)).toEqual([1, 1, 1]);
  });

  it('正例：同 URL 跨集同分出现——代表命中保持首见（严格大于才替换），via 合并可复现', () => {
    const dup = 'https://rep.example/tie';
    const sets = (): NormalizedHit[][] => [
      [hit(dup, 'ddg', { title: 'first' })],
      [hit(dup, 'bing-lite', { title: 'second' })],
    ];
    const out = fuse(sets(), params(), NOW);
    expect(out).toHaveLength(1);
    // fusion.ts:145 亲读：occurrence > bestScore 才换代表——同分（1/61 = 1/61）不换。
    expect(out[0]?.title).toBe('first');
    expect(out[0]?.url).toBe(dup);
    expect(out[0]?.provenance.via).toBe('ddg+bing-lite');
    expect(out[0]?.provenance.score).toBe(1); // 组分 2/61 归一化到自身
    expect(fuse(sets(), params(), NOW)).toEqual(out); // 重复调用逐位一致
  });

  it('负对照（红腿·判别力自证）：并列反序孪生在同一稳定序谓词下为假', () => {
    const broken = brokenTieSort(TIE_GROUPS);
    expect(broken).toEqual([B, A, Y, X]); // 并列段整体反序——同数据可辨差异
    expect(isStableTieOrder(broken, TIE_GROUPS)).toBe(false); // 同一谓词立即红
    const real = fuse(TIE_SETS(), params(), NOW).map((entry) => entry.url);
    expect(isStableTieOrder(real, TIE_GROUPS)).toBe(true); // 真实现同谓词绿
  });
});
