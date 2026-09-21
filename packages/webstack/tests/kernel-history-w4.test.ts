/**
 * TC-B4-W4 锁④：web_history 记录/查询锁——record 写入 + 查询读出 + 边界
 * （空史/容量语义按实际实现）。覆盖 kernel HistoryStore 与 buildHistoryTool
 * 工具层 execute 的完整回环。
 *
 * 断言依据 = 亲读 kernel/history.ts 与 tools/web-tools.ts 实际语义（禁臆测）：
 * - 记录写入：record 入环尾、超容丢环首（history.ts:69-78）；非法条目被
 *   isHistoryEntry 形状守卫静默拒收（不抛、不入环）；有适配器时 write-behind
 *   宏任务去抖刷写（record 只动内存，history.ts:126-139），快照键
 *   HISTORY_STORE_KEY、TTL 30 天（history.ts:23/26 亲读，私有常量经适配器
 *   set 入参可观测）。
 * - 查询读出：list 最新在前防御拷贝（history.ts:81-91）；工具层 action=list
 *   映射条目——statusCode/truncated 仅在有值时写键（web-tools.ts:220-231）；
 *   action=clear 先 size() 后 clear()，count=被清除条数（web-tools.ts:211-215）。
 * - 边界：空史 list → count 0 / entries []（空态非错误）；limit<=0 → 空；
 *   limit 超环长 → 钳全部；容量环满丢最旧。
 *
 * 负对照（本卡纪律）：乱序参照面（最旧在前的坏 list）在「最新在前」性质谓词下
 * 为假、真实现为真——红绿分布自证判别力；垃圾条目拒收腿锁「写入面不放任污染」。
 * mock 形制：持久层适配器一律 class 基（this 语义忠实，W1c 第五例教训）。
 * 零真实网络（本地内存环 + 内存 Map 适配器）。
 */
import { describe, expect, it } from 'vitest';
import { HISTORY_STORE_KEY, HistoryStore } from '../src/kernel/history.ts';
import type { HistoryEntry, PersistenceAdapter } from '../src/kernel/types.ts';
import { buildHistoryTool } from '../src/tools/web-tools.ts';

/** class 基假持久层（this 忠实）：内存 Map + 调用计数 + 最近 TTL 观测。 */
class FakeAdapter implements PersistenceAdapter {
  readonly domain = 'all' as const;
  readonly store = new Map<string, { readonly value: unknown; readonly storedAt: number }>();
  setCalls = 0;
  lastTtlMs: number | undefined;

  async get(
    key: string,
  ): Promise<{ readonly value: unknown; readonly storedAt: number } | undefined> {
    return this.store.get(key);
  }
  async set(key: string, value: unknown, ttlMs: number): Promise<void> {
    this.setCalls++;
    this.lastTtlMs = ttlMs;
    this.store.set(key, { value, storedAt: Date.now() });
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
  async clearAll(): Promise<void> {
    this.store.clear();
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));

function searchEntry(n: number, at = n): HistoryEntry {
  return {
    kind: 'search',
    at,
    input: `q${n}`,
    sources: [{ url: `https://h4.example/${n}`, title: `t${n}` }],
  };
}

type ToolExec = { execute: (args: unknown) => Promise<unknown> };

/** 工具层查询读出（action=list 的 canonical 值形状）。 */
async function listVia(
  tool: ToolExec,
  limit?: number,
): Promise<{
  action: string;
  count: number;
  entries: { kind: string; at: number; input: string; statusCode?: number; truncated?: boolean }[];
}> {
  const value = (await tool.execute(
    limit === undefined ? { action: 'list' } : { action: 'list', limit },
  )) as never;
  return value;
}

/** 性质谓词：list 输出「最新在前」（at 单调不增）。 */
function isNewestFirst(entries: readonly { at: number }[]): boolean {
  return entries.every((entry, i) => i === 0 || entries[i - 1]!.at >= entry.at);
}

describe('W4 锁④ · web_history 记录写入 → 查询读出回环', () => {
  it('正例：record 写入后工具读回，最新在前且条目形状完整（可选键仅在位才写）', async () => {
    const history = new HistoryStore();
    history.record(searchEntry(1, 100));
    history.record({
      kind: 'fetch',
      at: 200,
      input: 'https://f4.example/page',
      statusCode: 404,
      truncated: false, // 显式 false ≠ undefined → 键必须在场（web-tools.ts:225 亲读）
      sources: [],
    });
    history.record(searchEntry(3, 300));
    const report = await listVia(buildHistoryTool({ history }) as unknown as ToolExec);
    expect(report.action).toBe('list');
    expect(report.count).toBe(3);
    expect(report.entries.map((entry) => entry.input)).toEqual([
      'q3',
      'https://f4.example/page',
      'q1',
    ]);
    // fetch 条目：statusCode/truncated 在位；search 条目：两键均缺省不写。
    expect(report.entries[0]).not.toHaveProperty('statusCode');
    expect(report.entries[0]).not.toHaveProperty('truncated');
    expect(report.entries[1]).toMatchObject({ kind: 'fetch', statusCode: 404, truncated: false });
    // sources 映射形 {url, title?}（title 缺省不写键）。
    const value = report as unknown as { entries: { sources: Record<string, unknown>[] }[] };
    expect(value.entries[0]!.sources).toEqual([{ url: 'https://h4.example/3', title: 't3' }]);
    expect(value.entries[1]!.sources).toEqual([]);
  });

  it('边界：空史查询 → count 0 / entries []（空态非错误、不抛）', async () => {
    const tool = buildHistoryTool({ history: new HistoryStore() }) as unknown as ToolExec;
    const report = await listVia(tool);
    expect(report).toEqual({ action: 'list', count: 0, entries: [] });
  });

  it('边界：容量语义按实际实现——capacity=3 记 5 条丢最旧，工具读出与环一致', async () => {
    const history = new HistoryStore({ capacity: 3 });
    for (const n of [0, 1, 2, 3, 4]) history.record(searchEntry(n));
    expect(history.size()).toBe(3);
    const tool = buildHistoryTool({ history }) as unknown as ToolExec;
    const all = await listVia(tool);
    expect(all.entries.map((entry) => entry.input)).toEqual(['q4', 'q3', 'q2']); // q0/q1 已挤出环
    expect((await listVia(tool, 2)).entries.map((entry) => entry.input)).toEqual(['q4', 'q3']);
    expect((await listVia(tool, 0)).entries).toEqual([]); // limit<=0 → 空（history.ts:83-86 亲读）
    expect((await listVia(tool, 99)).count).toBe(3); // limit 超环长钳全部
  });

  it('clear 语义：count 回报=被清除条数、环清空；二次 clear 回报 0；清后可再记录', async () => {
    const history = new HistoryStore();
    history.record(searchEntry(1));
    history.record(searchEntry(2));
    const tool = buildHistoryTool({ history }) as unknown as ToolExec;
    const cleared = (await tool.execute({ action: 'clear' })) as {
      action: string;
      count: number;
      entries: unknown[];
    };
    expect(cleared).toEqual({ action: 'clear', count: 2, entries: [] }); // 先 size() 后 clear()
    const again = (await tool.execute({ action: 'clear' })) as { count: number };
    expect(again.count).toBe(0);
    history.record(searchEntry(9));
    expect((await listVia(tool)).entries.map((entry) => entry.input)).toEqual(['q9']);
  });
});

describe('W4 锁④ · 记录写入面纪律（write-behind / 垃圾拒收）', () => {
  it('write-behind：record 只动内存，宏任务后快照落适配器（键/TTL/内容三锁）', async () => {
    const adapter = new FakeAdapter();
    const history = new HistoryStore({ adapter });
    history.record(searchEntry(1));
    history.record(searchEntry(2));
    expect(adapter.setCalls).toBe(0); // record 热路径零阻塞（亲读：仅调度 setTimeout(0)）
    await tick();
    expect(adapter.setCalls).toBe(1); // 同轮多次 record 去抖合并为一次全量刷写
    expect(adapter.lastTtlMs).toBe(30 * 24 * 60 * 60_000); // 快照 TTL 30 天（history.ts:26）
    const snapshot = adapter.store.get(HISTORY_STORE_KEY)?.value as HistoryEntry[];
    expect(snapshot.map((entry) => entry.input)).toEqual(['q1', 'q2']); // 环序原样（旧→新）
    // 工具查询读内存环，与持久层解耦（零网络自明）。
    const report = await listVia(buildHistoryTool({ history }) as unknown as ToolExec);
    expect(report.count).toBe(2);
  });

  it('负对照（写入面红腿）：非法条目被形状守卫静默拒收——环零污染、绝不抛错', () => {
    const history = new HistoryStore();
    expect(() =>
      history.record({
        kind: 'nonsense',
        at: 1,
        input: 'x',
        sources: [],
      } as unknown as HistoryEntry),
    ).not.toThrow();
    expect(() => history.record(null as unknown as HistoryEntry)).not.toThrow();
    expect(() =>
      history.record({ kind: 'search', at: Number.NaN, input: 'x', sources: [] }),
    ).not.toThrow(); // at 非有限 → 守卫拒收（history.ts:43 亲读）
    expect(history.size()).toBe(0); // 垃圾进不来——「记录写入」面不放任污染
    history.record(searchEntry(1)); // 合法条目照常
    expect(history.size()).toBe(1);
  });
});

describe('W4 锁④ · 负对照（判别力自证）：查询读出「最新在前」谓词红绿分明', () => {
  it('乱序参照面（最旧在前）在同一谓词下为假，真 list 为真', () => {
    const history = new HistoryStore();
    for (const n of [1, 2, 3]) history.record(searchEntry(n, n * 100));
    const listed = history.list();
    expect(isNewestFirst(listed)).toBe(true); // 绿腿：真实现 at 降序（300/200/100）
    const brokenTwin = [...listed].reverse(); // 坏孪生：不反转的环序直出（最旧在前）
    expect(brokenTwin.map((entry) => entry.at)).toEqual([100, 200, 300]);
    expect(isNewestFirst(brokenTwin)).toBe(false); // 红腿：同一谓词立即为假
    // 防御性拷贝：工具/调用方改写返回数组不得回染内存环（history.ts:87 亲读）。
    listed.length = 0;
    expect(history.size()).toBe(3);
  });
});
