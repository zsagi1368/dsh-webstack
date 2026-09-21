/**
 * TC-B4-W4 锁①②③：web_batch_search / batchSearch 的〔源〕侧语义锁——
 * 保序、逐项隔离（含与主线 fan-out「一损俱损」的 C4 语义差对照）、≤10 上限。
 *
 * 断言依据 = 亲读 kernel/batch.ts 与 tools/web-tools.ts 实际语义（禁臆测）：
 * - 保序：`items[index] = …` 定位写（batch.ts:64/67），结果下标恒等于输入下标，
 *   与完成顺序无关；ok 项 `attempts` 恒空数组（batch.ts:64）。
 * - 隔离：单项 catch 转 `{index, query, ok:false, code, message:scrubText(…)}`
 *   结构化条目（batch.ts:65-74）；batchSearch 本体只在「批次非法」（超上限）时抛。
 * - 上限：`queries.length > BATCH_MAX_QUERIES(10)` 整体拒绝（EngineError
 *   `unrepresentable` / detail=`batch.limit-exceeded`，batch.ts:43-49），检查先于
 *   任何 fan-out（run 零触达）；恰好 10 放行；工具层 execute 同款双闸
 *   （web-tools.ts:108-114）。
 *
 * 负对照形制（本卡纪律，零改源）：三反例（乱序应答/单引擎抛错/超限 N+1）
 * 分别喂给真实现（绿腿=锁语义成立）与测试内「坏语义孪生参照面」（红腿=同一
 * 性质谓词立即为假）——红绿分布自证谓词判别力，绝不恒绿。坏孪生全部就地构造，
 * 不 import 主线代码、不重做主线并发机制（A.1 条 2 铁律）。
 *
 * mock 形制：class 基假引擎（this 语义忠实，W1c 第五例教训）——实例直接满足
 * `BatchSearchDeps`/`BatchSearchToolDeps` 结构面（kernel 实际接口形制 = `{ run }`），
 * 以接收者身份传入，run 内部读写 this 状态。零真实网络（全部 canned 命中）。
 */
import { describe, expect, it } from 'vitest';
import { BATCH_MAX_QUERIES, batchSearch } from '../src/kernel/batch.ts';
import { engineError } from '../src/kernel/errors.ts';
import type { NormalizedHit } from '../src/kernel/types.ts';
import { buildBatchSearchTool } from '../src/tools/web-tools.ts';

type BatchItem = Awaited<ReturnType<typeof batchSearch>>[number];

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const hitFor = (query: string): NormalizedHit => ({
  url: `https://w4.example/${query}`,
  title: `W4 ${query}`,
  provenance: { engine: 'fake-w4' },
});

/**
 * class 基假引擎：按 `delaysMs[query]` 延迟应答、`failOn` 集合内抛 EngineError。
 * 实例即 deps（this 忠实）；`calls` 记录启动序、`completed` 记录完成序——
 * 「反例条件确实成立」（乱序真实发生）由 completed 断言自证，非想象反例。
 */
class FakeEngine {
  readonly calls: string[] = [];
  readonly completed: string[] = [];
  constructor(
    private readonly delaysMs: Readonly<Record<string, number>> = {},
    private readonly failOn: ReadonlySet<string> = new Set<string>(),
  ) {}
  async run(query: string): Promise<NormalizedHit[]> {
    this.calls.push(query);
    await sleep(this.delaysMs[query] ?? 1);
    if (this.failOn.has(query)) {
      this.completed.push(query);
      throw engineError('rate-limited', `engine blew up on ${query}`, {});
    }
    this.completed.push(query);
    return [hitFor(query)];
  }
}

// ---------------------------------------------------------------------------
// 性质谓词（绿腿/红腿共用同一判定——判别力自证的单一事实源）
// ---------------------------------------------------------------------------

/** 锁①谓词：结果位置逐项对应输入（位置 i 的条目 index===i 且 query===queries[i]）。 */
function isOrderPreserved(items: readonly BatchItem[], queries: readonly string[]): boolean {
  return (
    items.length === queries.length &&
    items.every((item, i) => item.index === i && item.query === queries[i])
  );
}

/** 锁②谓词：failedIdx 项为结构化失败位，其余兄弟项全部 ok 且在原位携带命中。 */
function siblingsIntact(
  items: readonly BatchItem[],
  queries: readonly string[],
  failedIdx: number,
): boolean {
  return (
    items.length === queries.length &&
    items.every((item, i) => {
      if (item.index !== i || item.query !== queries[i]) return false;
      if (i === failedIdx) {
        return item.ok === false && item.code === 'rate-limited';
      }
      return item.ok === true && item.hits.length === 1;
    })
  );
}

/** 锁③谓词：N+1 输入被显式拒绝（reject），而非静默少做（resolve）。 */
async function rejectsOnOverflow(
  fn: (queries: readonly string[]) => Promise<unknown>,
  queries: readonly string[],
): Promise<boolean> {
  try {
    await fn(queries);
    return false;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// 坏语义孪生参照面（负对照红腿专用；测试内构造，零改源、零主线代码）
// ---------------------------------------------------------------------------

/** 坏孪生·乱序：完成序 push（不定位写）——保序谓词在乱序反例下立即为假。 */
async function completionOrderFanout(
  engine: FakeEngine,
  queries: readonly string[],
): Promise<BatchItem[]> {
  const out: BatchItem[] = [];
  await Promise.all(
    queries.map(async (query, index) => {
      const hits = await engine.run(query);
      out.push({ index, query, ok: true, hits, attempts: [] });
    }),
  );
  return out;
}

/**
 * 坏孪生·传染：单项失败即整批尽失（返回 undefined = 无任何兄弟结果）。
 * 这是主线多查询 fan-out「一损俱损」语义（R2-plugin-surface.md:39 C4）的
 * 最小参照面——以原生 Promise.all 表达其语义契约（一项 reject → 整体 reject，
 * 兄弟结果零留存），**非主线并发机制复刻**（A.1 条 2：不重做主线并发）。
 */
async function abortingFanout(
  engine: FakeEngine,
  queries: readonly string[],
): Promise<BatchItem[] | undefined> {
  try {
    return await Promise.all(
      queries.map(async (query, index) => {
        const hits = await engine.run(query);
        return { index, query, ok: true as const, hits, attempts: [] };
      }),
    );
  } catch {
    return undefined;
  }
}

/** 坏孪生·静默截断：N+1 被悄悄砍到 10 条执行（batch.ts 头注释明令杜绝的形制）。 */
function silentlyTruncate(queries: readonly string[]): readonly string[] {
  return queries.slice(0, BATCH_MAX_QUERIES);
}

// ---------------------------------------------------------------------------
// 锁①：batch 保序
// ---------------------------------------------------------------------------

describe('W4 锁① · batch 保序（结果下标=输入下标，与完成序无关）', () => {
  /** 反例条件：0 号最慢、末号最快——完成序与输入序完全颠倒。 */
  const REVERSED_DELAYS: Readonly<Record<string, number>> = {
    q0: 120,
    q1: 90,
    q2: 60,
    q3: 30,
    q4: 15,
  };
  const QUERIES = ['q0', 'q1', 'q2', 'q3', 'q4'];

  it('正例（绿腿）：乱序引擎应答（后发先至）下结果仍逐项对应输入', async () => {
    const engine = new FakeEngine(REVERSED_DELAYS);
    const items = await batchSearch(engine, QUERIES);
    // 反例条件确实成立：启动序=输入序，完成序=完全颠倒（非想象乱序）。
    expect(engine.calls).toEqual(QUERIES);
    expect(engine.completed).toEqual(['q4', 'q3', 'q2', 'q1', 'q0']);
    // 锁语义：位置对应 + 命中随位 + ok 项 attempts 恒空（batch.ts:64 亲读）。
    expect(isOrderPreserved(items, QUERIES)).toBe(true);
    items.forEach((item, i) => {
      if (!item.ok) throw new Error('all items should succeed');
      expect(item.hits[0]?.url).toBe(`https://w4.example/q${i}`);
      expect(item.attempts).toEqual([]);
    });
  });

  it('负对照（红腿·判别力自证）：同一乱序反例使完成序参照面保序谓词为假', async () => {
    const engine = new FakeEngine(REVERSED_DELAYS);
    const broken = await completionOrderFanout(engine, QUERIES);
    expect(engine.completed).toEqual(['q4', 'q3', 'q2', 'q1', 'q0']); // 同款反例条件
    expect(broken).toHaveLength(QUERIES.length); // 条目在场但乱序——
    expect(isOrderPreserved(broken, QUERIES)).toBe(false); // 同一谓词立即红
    expect(broken[0]?.query).toBe('q4'); // 完成序首位=最快项，非输入首位
  });

  it('正例：10 条交错延迟（并发钳到 5）仍全保序——宽反例面复验', async () => {
    const ten = Array.from({ length: 10 }, (_, i) => `t${i}`);
    const delays: Record<string, number> = {};
    for (const [i, ms] of [75, 65, 55, 45, 35, 30, 25, 15, 8, 2].entries()) delays[`t${i}`] = ms;
    const engine = new FakeEngine(delays);
    const items = await batchSearch(engine, ten, 10); // 传 10 也被钳到 5（既有锁面，此处仅造乱）
    expect(isOrderPreserved(items, ten)).toBe(true);
    expect(items.every((item) => item.ok)).toBe(true);
    expect(new Set(engine.completed)).toHaveLength(10);
    expect(engine.completed[0]).not.toBe('t0'); // 完成序确被打乱
  });
});

// ---------------------------------------------------------------------------
// 锁②：逐项隔离 + C4 语义差对照
// ---------------------------------------------------------------------------

describe('W4 锁② · 逐项隔离（单项失败不 abort 兄弟项）+ C4 语义差对照', () => {
  const QUERIES = ['a', 'bad', 'c'];

  it('正例（绿腿·单引擎抛错反例）：失败项按语义进结果位，兄弟项完整在场', async () => {
    const engine = new FakeEngine({}, new Set(['bad']));
    const items = await batchSearch(engine, QUERIES); // 本体 resolve，绝不因单项 reject
    expect(siblingsIntact(items, QUERIES, 1)).toBe(true);
    const failed = items[1];
    if (failed === undefined || failed.ok) throw new Error('expected structured failure item');
    // 错误占位形制（batch.ts:66-73 亲读）：闭集码 + 过 scrubber 的 message + 原位 index/query。
    expect(failed.code).toBe('rate-limited');
    expect(failed.message).toContain('engine blew up on bad');
    expect(failed.index).toBe(1);
    expect(failed.query).toBe('bad');
    const first = items[0];
    if (first === undefined || !first.ok) throw new Error('sibling a must be intact');
    expect(first.hits[0]?.url).toBe('https://w4.example/a');
  });

  it('对照（C4 语义差锁）：同失败集下主线式 fan-out「一损俱损」红、batchSearch 隔离绿', async () => {
    // R2-plugin-surface.md:39 C4：主线多查询 fan-out=一损俱损（失败 abort siblings）；
    // web_batch_search=逐项隔离。锁对象=语义差本身；参照面=原生 Promise.all
    // （不 import 主线代码、不重做主线并发机制——A.1 条 2）。
    const fanoutEngine = new FakeEngine({}, new Set(['bad']));
    const fanout = await abortingFanout(fanoutEngine, QUERIES);
    expect(fanout).toBeUndefined(); // 红腿：一项失败 → 整批尽失，兄弟结果零留存

    const batchEngine = new FakeEngine({}, new Set(['bad']));
    const items = await batchSearch(batchEngine, QUERIES);
    expect(siblingsIntact(items, QUERIES, 1)).toBe(true); // 绿腿：兄弟项 a/c 完整在场
    expect(items.filter((item) => item.ok)).toHaveLength(2);
  });

  it('正例：多项失败各进各位互不掩盖；全失败也结构化返回不抛', async () => {
    const some = new FakeEngine({}, new Set(['a', 'c']));
    const items = await batchSearch(some, QUERIES);
    expect(items.map((item) => item.ok)).toEqual([false, true, false]);
    expect(items[0]?.ok === false && items[0].index === 0).toBe(true);
    expect(items[2]?.ok === false && items[2].index === 2).toBe(true);

    const all = new FakeEngine({}, new Set(['a', 'bad', 'c']));
    const doomed = await batchSearch(all, QUERIES);
    expect(doomed.every((item) => !item.ok)).toBe(true); // 全失败仍 resolve——隔离语义的极限面
    expect(isOrderPreserved(doomed, QUERIES)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 锁③：≤10 上限（显式拒绝，非静默截断）
// ---------------------------------------------------------------------------

describe('W4 锁③ · ≤10 上限（N+1 整体拒绝，拒绝先于任何执行）', () => {
  const ELEVEN = Array.from({ length: BATCH_MAX_QUERIES + 1 }, (_, i) => `q${i}`);
  const TEN = Array.from({ length: BATCH_MAX_QUERIES }, (_, i) => `q${i}`);

  it('常量锁：BATCH_MAX_QUERIES === 10（卡面「≤10」的源侧单一事实源）', () => {
    expect(BATCH_MAX_QUERIES).toBe(10);
  });

  it('正例（边界绿腿）：恰好 10 条放行且全部执行', async () => {
    const engine = new FakeEngine();
    const items = await batchSearch(engine, TEN);
    expect(items).toHaveLength(10);
    expect(items.every((item) => item.ok)).toBe(true);
    expect(engine.calls).toHaveLength(10);
  });

  it('负对照（红腿·超限 N+1）：11 条整体拒绝（unrepresentable/batch.limit-exceeded）且 run 零触达', async () => {
    const engine = new FakeEngine();
    await expect(batchSearch(engine, ELEVEN)).rejects.toMatchObject({
      name: 'EngineError',
      code: 'unrepresentable',
      detail: 'batch.limit-exceeded',
    });
    // 亲读语义（batch.ts:43-49）：上限检查先于 worker 启动——拒绝时零执行发生。
    expect(engine.calls).toHaveLength(0);
    expect(await rejectsOnOverflow((qs) => batchSearch(new FakeEngine(), qs), ELEVEN)).toBe(true);
  });

  it('负对照（判别力自证）：静默截断参照面在同输入下不拒绝——「显式拒绝」谓词红绿分明', async () => {
    // 坏孪生：悄悄砍到 10 条（宁可显式失败不可悄悄少做——batch.ts 头注释原文语义）。
    expect(silentlyTruncate(ELEVEN)).toHaveLength(10); // 少做 1 条且零报错
    expect(await rejectsOnOverflow(async (qs) => silentlyTruncate(qs), ELEVEN)).toBe(false); // 同一谓词在坏孪生下为假（红）
    expect(await rejectsOnOverflow((qs) => batchSearch(new FakeEngine(), qs), ELEVEN)).toBe(true); // 真实现为真（绿）
  });

  it('工具层双闸：buildBatchSearchTool execute 11 条同款拒绝、run 零触达；10 条放行', async () => {
    const engine = new FakeEngine();
    const tool = buildBatchSearchTool(engine) as unknown as {
      execute: (args: unknown) => Promise<unknown>;
    };
    await expect(tool.execute({ queries: ELEVEN })).rejects.toMatchObject({
      code: 'unrepresentable',
      detail: 'batch.limit-exceeded',
    });
    expect(engine.calls).toHaveLength(0); // web-tools.ts:108-114 亲读：execute 自检先于 batchSearch

    const value = (await tool.execute({ queries: TEN })) as { total: number; okCount: number };
    expect(value.total).toBe(10);
    expect(value.okCount).toBe(10);
  });
});
