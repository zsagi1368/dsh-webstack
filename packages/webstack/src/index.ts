/**
 * WebStack (网栈) — integrated web search + fetch kernel plugin for DeepSeek Harness.
 *
 * Host entry: registers the neutral aggregator as a search/fetch provider via
 * `ctx.web`. Coexist mode by default: the bundled cordis patch is an empty
 * list, so upstream selectors stay untouched unless the user opts into
 * takeover. All optional seams (settings/tools/systemPrompt/credentials/
 * storage) are capability-probed, never hard-injected (W-B-08).
 *
 * 装配顺序（W-B-08 降级梯）：能力探测 → 引擎接线 → 聚合器 → settings 配置节
 * （热生效 W-B-74）→ systemPrompt 守则+动态状态节 → tools 诊断工具 →
 * web seam 双面注册 → 加载标记日志（W-B-78）。命令系统：宿主未暴露命令
 * 注册 API，诊断经 web_backend_status 工具或对话请求触发（见 README）。
 *
 * @module dsh-webstack
 */

import type { Context } from '@deepseek-ai/cordis';
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-web';
import z from '@deepseek-ai/schemastery';
import { renderDoctor, runDoctor } from './diag/doctor.ts';
import { BingLiteEngine } from './engines/bing-lite.ts';
import { DdgEngine } from './engines/ddg.ts';
import { SEARXNG_DESCRIPTOR, SearxngEngine } from './engines/searxng.ts';
import { type AggregatorSnapshot, WebstackAggregator } from './kernel/aggregator.ts';
import { deriveTierMode, probeCapabilities } from './kernel/capability.ts';
import { EngineRegistry } from './kernel/registry.ts';
import { normalizeLayer } from './kernel/router.ts';
import type { CapabilityBitmap, SearchLayer, TierMode } from './kernel/types.ts';
import { charterSection, statusSection } from './prompt/sections.ts';

export { renderDoctor, runDoctor } from './diag/doctor.ts';
export { WebstackAggregator } from './kernel/aggregator.ts';
export { deriveTierMode, probeCapabilities } from './kernel/capability.ts';
export { EngineRegistry } from './kernel/registry.ts';
export { WEBSTACK_PROVIDER_ID } from './kernel/types.ts';
export { charterSection, statusSection } from './prompt/sections.ts';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'webstack';

/** Required seam: the web provider registry. Everything else is probed. */
export const inject = ['web'];

/** Public plugin configuration type. */
export type Config = PluginConfig;

export interface PluginConfig {
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
}

/** Plugin schema; omitted fields resolve to the frozen defaults. */
export const Config: z<PluginConfig> = z.object({
  enabled: z.boolean().default(true),
  layer: z.union(['native', 'free', 'api', 'selfhosted', 'mcp'] as const).default('free'),
  autoFallback: z.boolean().default(true),
  maxResults: z.number().default(8),
  complexityRouting: z.boolean().default(true),
  fusionEnabled: z.boolean().default(true),
  maxContentChars: z.number().default(12_000),
  ssrfExempts: z.array(z.string()).default([]),
  searxngBaseUrl: z.string().default(''),
});

/** 宿主 locale 未暴露探测 API——默认中文，TODO(W2-PLATFORM): 跟随宿主语言设置。 */
const HOST_LOCALE: 'zh' | 'en' = 'zh';

/** 设置命名空间（settings.yaml 的 `webstack:` 段）。 */
const SETTINGS_NS = settingsNamespace('webstack');

/** 组合入口配置 → 聚合器运行快照（操作起点一致性的唯一装配点）。 */
function settingsToSnapshot(config: PluginConfig): AggregatorSnapshot {
  return {
    enabled: config.enabled ?? true,
    layer: normalizeLayer(config.layer),
    autoFallback: config.autoFallback ?? true,
    maxResults: config.maxResults ?? 8,
    fusionEnabled: config.fusionEnabled ?? true,
    complexityRouting: config.complexityRouting ?? true,
    fetchMode: 'raw',
    maxContentChars: config.maxContentChars ?? 12_000,
    ssrfExempts: [...(config.ssrfExempts ?? [])],
    cacheEnabled: true,
  };
}

/** 安全读取可能未装载的 cordis 服务（访问未装载服务属性会抛错而非 undefined）。 */
function peekService(ctx: unknown, key: string): Record<string, unknown> | undefined {
  if (typeof ctx !== 'object' || ctx === null) return undefined;
  try {
    const value = (ctx as Record<string, unknown>)[key];
    return typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Register the aggregator into the host web seam when the seam is present;
 * otherwise log the diagnostic tier and stay inert on the data path while the
 * diagnostics seams still come up (capability ladder, F-013). Provider
 * registrations are disposed with the calling fiber.
 */
export function apply(ctx: Context, config: PluginConfig = {}): void {
  const capabilities: CapabilityBitmap = probeCapabilities(ctx);
  const tier: TierMode = deriveTierMode(capabilities);

  // ---- 引擎接线（注册序即 fallback 候选序）--------------------------------
  // 免费池结构性零凭据开箱（W-B-12）；selfhosted 仅在显式配置 baseUrl 时注册；
  // TODO(W2-PLATFORM): native delegate 句柄捕获与 api/keyed/mcp 引擎接入。
  const registry = new EngineRegistry();
  registry.register(new DdgEngine());
  registry.register(new BingLiteEngine());
  const baseUrl = config.searxngBaseUrl?.trim() ?? '';
  if (/^https?:\/\//i.test(baseUrl)) {
    registry.register(new SearxngEngine(SEARXNG_DESCRIPTOR, baseUrl));
  }

  const aggregator = new WebstackAggregator({
    snapshot: settingsToSnapshot(config),
    registry,
  });

  // ---- settings seam：配置节安装 + 热生效（W-B-74/75）---------------------
  // installSettingsSection 内部 ctx.inject(['settings'])，服务缺席时整体不挂载，
  // 回落组合入口配置——能力缺失降级而非报错。
  let source: () => PluginConfig = () => ({ ...config });
  let refreshStatusSection: () => void = () => {};
  installSettingsSection(ctx, SETTINGS_NS, Config, config, {
    setSource: (current) => {
      source = () => current() as PluginConfig;
    },
    onChange: () => {
      aggregator.updateSnapshot(settingsToSnapshot(source()));
      refreshStatusSection();
    },
  });

  // ---- systemPrompt seam：守则节 + 动态状态节（W-B-90~92）-----------------
  const systemPrompt = peekService(ctx, 'systemPrompt');
  if (typeof systemPrompt?.section === 'function') {
    const sectionFn = systemPrompt.section as (s: ReturnType<typeof charterSection>) => () => void;
    sectionFn(charterSection(HOST_LOCALE));
    let statusDisposer: (() => void) | undefined;
    refreshStatusSection = () => {
      statusDisposer?.();
      statusDisposer = sectionFn(statusSection(registry.statusSnapshot(), HOST_LOCALE));
    };
    refreshStatusSection();
  }

  // ---- tools seam：web_backend_status 诊断工具（W-B-113/114）--------------
  const tools = peekService(ctx, 'tools');
  if (typeof tools?.register === 'function') {
    const registerFn = tools.register as (definition: Record<string, unknown>) => () => void;
    registerFn(
      // SeamToolsRuntime 契约面是 Record<string, unknown>（结构镜像）；
      // defineTool 返回的 ToolDefinition 缺索引签名，此处收窄为注册面形状。
      defineTool({
        name: 'web_backend_status',
        description:
          'Side-effect-free WebStack diagnostics: tier mode, per-engine state with cooldowns and last error code, and cache hit statistics. Makes no search requests and exposes no credentials.',
        parameters: {},
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              tier: { type: 'string', required: true },
              engines: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string', required: true },
                    state: { type: 'string', required: true },
                    cooldownRemainingMs: { type: 'number' },
                    lastCode: { type: 'string' },
                  },
                },
              },
              cache: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  hits: { type: 'number', required: true },
                  misses: { type: 'number', required: true },
                  size: { type: 'number', required: true },
                },
              },
            },
            required: ['tier', 'engines', 'cache'],
          },
          render: (_args, value) => {
            const report = value as Parameters<typeof renderDoctor>[0];
            return [{ type: 'text', text: renderDoctor(report, HOST_LOCALE) }];
          },
        },
        timeoutMs: 10_000,
        isConcurrencySafe: () => true,
        async execute() {
          const report = runDoctor({
            bitmap: capabilities,
            tier,
            registry,
            cache: aggregator.cache,
          });
          // 显式展开为 schema 推导形状（readonly 报告数组 → 可变 canonical 值）。
          return {
            tier: report.tier,
            engines: report.engines.map((engine) => ({
              id: engine.id,
              state: engine.state,
              ...(engine.cooldownRemainingMs === undefined
                ? {}
                : { cooldownRemainingMs: engine.cooldownRemainingMs }),
              ...(engine.lastCode === undefined ? {} : { lastCode: engine.lastCode }),
            })),
            cache: {
              hits: report.cache.hits,
              misses: report.cache.misses,
              size: report.cache.size,
            },
          };
        },
      }) as unknown as Record<string, unknown>,
    );
  }
  // TODO(W2-PLATFORM): 宿主命令系统 API 未确认——`/webstack doctor` 等对话命令
  // 不硬造；诊断经 web_backend_status 工具或对话请求触发（README 说明）。

  // ---- web seam：聚合器双面注册（search + fetch）---------------------------
  if (capabilities.webSeam) {
    ctx.web.registerSearchProvider(aggregator);
    ctx.web.registerFetchProvider(aggregator);
  }

  // ---- 加载标记一行日志（W-B-78）：tier + 能力位图 + 引擎表 ----------------
  const logger = peekService(ctx, 'logger');
  const logInfo = logger?.info;
  const marker = [
    `tier=${tier}`,
    `web=${capabilities.webSeam}`,
    `settings=${capabilities.settingsSection}`,
    `credentials=${capabilities.credentialsDomain}`,
    `storage=${capabilities.storageService}`,
    `engines=[${registry.listIds().join(',')}]`,
  ].join(' ');
  if (typeof logInfo === 'function') {
    (logInfo as (message: string) => void).call(logger, `[webstack] loaded ${marker}`);
  } else if (typeof ctx.logger === 'function') {
    ctx.logger(name).info(`[webstack] loaded ${marker}`);
  } else {
    console.info(`[webstack] loaded ${marker}`);
  }
}
