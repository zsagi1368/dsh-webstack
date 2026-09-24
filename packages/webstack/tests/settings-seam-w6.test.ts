/**
 * TC-B4-W6 面①②：settings.register 命名空间锁 + 热生效链锁
 * （contract-webstack.md:36 §2#3 与 :105 契约匹配结论的锁化防回归）。
 *
 * 断言依据 = 亲读实际语义（禁臆测）：
 * - index.ts:170 SETTINGS_NS='webstack'（字面量）；:506-518 `ctx.inject(
 *   ['settings'])` → `settings.register(SETTINGS_NS, Config)`（真 schema 对象
 *   身份传递）→ `source=()=>scope.get()` → `scope.watch(cb)`，cb=
 *   「live=source() → rewriteInPlace(config,live) → refresh() →
 *   refreshStatusSection()」。
 * - 主线 ns 正则 `/^[a-z][a-z0-9-]*$/`：contract-webstack.md:36 §2#3 结论
 *   （主线 settings/settings/src/index.ts:419 实存证据，'webstack' 过）。
 * - rewriteInPlace（index.ts:713-718 亲读）：先 delete 目标全部旧键再
 *   Object.assign——目标对象**身份恒稳**、键集=文档键集（缺键即删除，
 *   回落 composeSnapshot 默认）。
 * - refresh（index.ts:492-500 亲读）：sessionOnline.setMode +
 *   aggregator.updateSnapshot(composeSnapshot(config, extras))；
 *   refreshStatusSection（:531-543）：dispose 旧 status 节 + 重注册新节。
 * - 服务缺席 → inject 回调不执行即降级（:504-505 注释语义）。
 * - cordis inject 触发机制（本地探针实测）：裸赋值不触发；`ctx.provide('settings')`
 *   声明后赋值 → 异步触发（测试 await 宏任务收敛）。
 *
 * mock 形制：settings 服务/scope/systemPrompt 全 class 基（this 忠实——真宿主
 * settings.register 与 SystemPrompt.section 均 class 方法，W1c 第五例+修点 1
 * 教训；bind 接收者路径被真实走通）。零真实网络（本文件无引擎执行面；
 * WebRuntime 装配为本地 cordis 插件，无出站）。
 *
 * 负对照：面①=正则判别对（坏 ns 五形全红）+服务缺席注册面零触达；面②=
 * before/after 同测试内红绿分布（链未触发快照不动 vs 触发后全链翻转）+
 * 缺席降级腿（链不存在，组合入口配置回落可用）。
 */
import { Context } from '@deepseek-ai/cordis';
import WebRuntime from '@deepseek-ai/dsh-web';
import { describe, expect, it } from 'vitest';
import { assembleWebstack, Config, type PluginConfig } from '../src/index.ts';
import type { SeamPromptSection } from '../src/kernel/types.ts';

const tick = (ms = 30): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** class 基假 settings scope（this 忠实）：get/watch 契约面 + 测试侧 emit 触发。 */
class FakeScope {
  readonly watchers: (() => void)[] = [];
  private doc: Record<string, unknown>;
  constructor(doc: Record<string, unknown>) {
    this.doc = doc;
  }
  get(): unknown {
    return this.doc;
  }
  watch(cb: () => void): () => void {
    this.watchers.push(cb);
    return () => {
      const at = this.watchers.indexOf(cb);
      if (at >= 0) this.watchers.splice(at, 1);
    };
  }
  setDocument(next: Record<string, unknown>): void {
    this.doc = next;
  }
  emit(): void {
    for (const cb of [...this.watchers]) cb();
  }
}

/** class 基假 settings 服务：register 捕获 (ns, schema)——注册形制观测点。 */
class FakeSettingsService {
  readonly registered: { ns: string; schema: unknown }[] = [];
  readonly scope: FakeScope;
  constructor(initialDoc: Record<string, unknown> = {}) {
    this.scope = new FakeScope(initialDoc);
  }
  register(ns: string, schema: unknown): FakeScope {
    this.registered.push({ ns, schema });
    return this.scope;
  }
}

/** class 基假 systemPrompt（真宿主 section 是 class 方法，bind 接收者路径实走）。 */
class FakeSystemPrompt {
  readonly sections: SeamPromptSection[] = [];
  disposed = 0;
  section(section: SeamPromptSection): () => void {
    this.sections.push(section);
    return () => {
      this.disposed++;
    };
  }
}

async function assembleWithSettings(
  cfg: PluginConfig,
  opts: { withSettings: boolean; doc?: Record<string, unknown> },
): Promise<{
  assembly: ReturnType<typeof assembleWebstack>;
  settings: FakeSettingsService;
  prompt: FakeSystemPrompt;
}> {
  const ctx = new Context();
  await ctx.plugin(WebRuntime, {}); // 先例形制（index-seam-guard.test.ts:248）：fork 落定后再装配，能力探测不依赖调度时机
  const settings = new FakeSettingsService(opts.doc ?? {});
  const prompt = new FakeSystemPrompt();
  // systemPrompt 走同步 peek（index.ts:521）——直接赋值即被探测。
  (ctx as unknown as Record<string, unknown>).systemPrompt = prompt;
  if (opts.withSettings) {
    // cordis inject 触发形制（探针实测）：provide 声明 + 赋值 → 异步触发回调。
    ctx.provide('settings');
    (ctx as unknown as Record<string, unknown>).settings = settings;
  }
  const assembly = assembleWebstack(ctx, cfg);
  await tick(); // inject 回调收敛（register/watch 接线完成）
  return { assembly, settings, prompt };
}

// ---------------------------------------------------------------------------
// 面①：settings.register 命名空间锁
// ---------------------------------------------------------------------------

describe('W6 面① · settings.register 命名空间锁（ns=webstack + Config 真 schema 形制）', () => {
  it('正例：真装配注册恰一次，ns="webstack"，schema===Config 真对象身份传递', async () => {
    const { assembly, settings } = await assembleWithSettings({}, { withSettings: true });
    expect(assembly.capabilities.settingsSection).toBe(true); // 能力位（同步 peek 面）
    expect(settings.registered).toHaveLength(1); // 恰一次注册（无重复 ns）
    expect(settings.registered[0]!.ns).toBe('webstack'); // SETTINGS_NS 字面量（index.ts:170）
    expect(settings.registered[0]!.schema).toBe(Config); // 身份锁：真 schema 对象非副本
  });

  it('主线正则判别对：webstack 绿；大小写/下划线/数字开头/连字符开头/空格/空串六坏形全红', () => {
    // 主线 settings register 的 ns 校验正则（contract-webstack.md:36 §2#3，
    // 主线 settings/settings/src/index.ts:419 实存证据转录）。
    const NS_RE = /^[a-z][a-z0-9-]*$/;
    expect(NS_RE.test('webstack')).toBe(true); // 绿腿：本插件 ns 过关
    for (const bad of ['WebStack', 'web_stack', '9webstack', '-webstack', 'web stack', '']) {
      expect(NS_RE.test(bad), `bad ns ${JSON.stringify(bad)}`).toBe(false); // 红腿：判别力自证
    }
  });

  it('负对照：settings 服务缺席 → 注册面零触达（回调不执行即降级，装配不报错）', async () => {
    const { assembly, settings } = await assembleWithSettings({}, { withSettings: false });
    expect(settings.registered).toHaveLength(0); // inject 回调未执行（index.ts:504-505 语义）
    expect(assembly.capabilities.settingsSection).toBe(false); // 能力位诚实（W1b2 锁⑥同源）
    expect(assembly.aggregator).toBeDefined(); // 降级不报错：装配产物完好
  });
});

// ---------------------------------------------------------------------------
// 面②：热生效链锁（scope.watch → rewriteInPlace → refresh → refreshStatusSection）
// ---------------------------------------------------------------------------

describe('W6 面② · 热生效链锁（contract-webstack.md:105 契约匹配结论锁化防回归）', () => {
  it('正例：watch 回调触发 → config 原位改写+快照/状态机/状态节全链热翻转（before/after 判别对）', async () => {
    const cfg: PluginConfig = { sessionOnline: 'off', layer: 'free', maxResults: 8 };
    const { assembly, settings, prompt } = await assembleWithSettings(cfg, {
      withSettings: true,
      doc: { sessionOnline: 'off', layer: 'free', maxResults: 8 },
    });
    // 链入口在位：scope.watch 恰一次注册；初始 prompt 节=charter+status 两节。
    expect(settings.scope.watchers).toHaveLength(1);
    expect(prompt.sections).toHaveLength(2);

    // before（红腿面：链未触发，快照=组合入口初始值）。
    expect(assembly.aggregator.snapshot.layer).toBe('free');
    expect(assembly.aggregator.snapshot.maxResults).toBe(8);
    expect(assembly.aggregator.snapshot.forceFresh).toBe(false);
    expect(assembly.sessionOnline.getMode()).toBe('off');

    // 设置文档变更（真宿主 settings onChange 语义：get() 换文档 + watch 回调）。
    settings.scope.setDocument({
      enabled: true,
      layer: 'api',
      sessionOnline: 'on',
      maxResults: 12,
    });
    settings.scope.emit();

    // after（绿腿）：refresh 全链可观测翻转。
    expect(assembly.aggregator.snapshot.layer).toBe('api');
    expect(assembly.aggregator.snapshot.maxResults).toBe(12);
    expect(assembly.aggregator.snapshot.forceFresh).toBe(true); // sessionOnline 'on' → forceFresh
    expect(assembly.sessionOnline.getMode()).toBe('on');
    // rewriteInPlace delete+assign 语义（index.ts:713-718 亲读）：
    // cfg 对象身份恒稳、键集=文档键集（旧键被删、新键全量赋值）。
    expect(Object.keys(cfg).sort()).toEqual(['enabled', 'layer', 'maxResults', 'sessionOnline']);
    expect(cfg.layer).toBe('api');
    // refreshStatusSection：旧 status 节 dispose + 新节重注册（链第三步可观测）。
    expect(prompt.disposed).toBe(1);
    expect(prompt.sections).toHaveLength(3);
  });

  it('双轮热循环：第二轮空文档 → 全键回落 composeSnapshot 默认——链可重复生效非一次性', async () => {
    const cfg: PluginConfig = { layer: 'free' };
    const { assembly, settings, prompt } = await assembleWithSettings(cfg, {
      withSettings: true,
      doc: { layer: 'free' },
    });
    settings.scope.setDocument({ layer: 'selfhosted', sessionOnline: 'on' });
    settings.scope.emit();
    expect(assembly.aggregator.snapshot.layer).toBe('selfhosted');
    expect(assembly.aggregator.snapshot.forceFresh).toBe(true);

    // 第二轮：空文档——rewriteInPlace 删净旧键，缺省位回落默认（非残留旧值）。
    settings.scope.setDocument({});
    settings.scope.emit();
    expect(Object.keys(cfg)).toEqual([]); // delete+assign 后零键（身份仍稳）
    expect(assembly.aggregator.snapshot.layer).toBe('free'); // normalizeLayer(undefined)→free
    expect(assembly.aggregator.snapshot.maxResults).toBe(8); // 默认回落
    expect(assembly.aggregator.snapshot.forceFresh).toBe(false); // sessionOnline 缺席→off
    expect(assembly.sessionOnline.getMode()).toBe('off');
    expect(prompt.disposed).toBe(2); // 每轮 status 节换新
    expect(prompt.sections).toHaveLength(4);
  });

  it('负对照：服务缺席 → 热生效链不存在；显式 refresh 走组合入口配置回落面（降级可用）', async () => {
    const cfg: PluginConfig = { layer: 'free' };
    const { assembly, settings, prompt } = await assembleWithSettings(cfg, { withSettings: false });
    expect(settings.scope.watchers).toHaveLength(0); // 链未接线（回调不执行即降级）
    expect(prompt.sections).toHaveLength(2); // 初始两节后无新增触发源

    // 组合入口回落：source 恒 () => ({...config})——显式 refresh 仍读同一 cfg 对象。
    Object.assign(cfg, { layer: 'api', sessionOnline: 'on' });
    assembly.refresh();
    expect(assembly.aggregator.snapshot.layer).toBe('api');
    expect(assembly.aggregator.snapshot.forceFresh).toBe(true);
    expect(assembly.sessionOnline.getMode()).toBe('on');
  });
});
