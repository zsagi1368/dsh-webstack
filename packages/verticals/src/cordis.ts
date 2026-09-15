/**
 * Cordis 装配入口（TC-B2-23C / §8-ADJ-5 分支二 / DESIGN §9.2 装载契约）。
 *
 * 背景：本包原为纯库 barrel——`lib/index.js` 只有具名导出、无 `default`、
 * 无 `apply`，cordis loader 经 `unwrapExports`（`exports.default ?? exports`）
 * 归一后拿到命名空间对象本身，registry 只接受「函数」或「带 `.apply` 的对象」
 * （M-F1，`vendor/cordis/src/registry.ts:225-226/:9/:319`），因此治理宿主
 * `loader.create({name:<factory fileURL>})` 必抛 `invalid plugin`（M-F6 实测）。
 * 修法落插件侧：本文件按 M-F1 判据补最小 `name/inject/apply` 具名出口，由
 * `src/index.ts` re-export 进同一 barrel（`service.factory='./lib/index.js'`
 * 不变，manifest 出口路径零变化）。
 *
 * 形状先例：仓内活先例 `packages/bridge/src/index.ts:37/40/108`（apply/inject/
 * name 落主 barrel）；结构化 ctx 条款承自 f4c `omnivision/src/cordis-adapter.ts`
 * 头注（"No cordis imports on purpose"）——本文件**刻意零 cordis import**，
 * ctx 以结构化类型声明，保证本包独立构建、依赖图不含 cordis（tsdown
 * `neverBundle` 纪律同步维持）。
 *
 * 装配语义 = 构造 + 注册 + provide，零网络零定时器零 FS：XVerticalChannel
 * 自身不触网（腿 1/腿 2 全部经 `VerticalDeps` 注入，缺席静默降级），deps 的
 * 实际接线（免费池聚合、内核 outboundFetch SSRF 闸）属装配层/批次 4，不在
 * mount 期发生——故 mount 成功仅代表「x-vertical 服务在位」，不代表功能腿已通。
 * 失败姿态：本 apply 内不吞编程错误（对齐 f4c loud-mount / §9.4：抛出由
 * 治理宿主执行器 per-item catch 转台账 failed，兄弟件不受累）。
 */

import type { SearchHints, VerticalChannel } from './framework.ts';
import { VerticalRegistry } from './framework.ts';
import { X_VERTICAL_ID, XVerticalChannel } from './x-search.ts';

/** Loader/registry 记录名（`registry.ts:322` 取 `plugin.name`）。 */
export const name = 'dsh-webstack-verticals';

/**
 * 无硬注入服务（对齐 f4c 判据「填 inject 即成硬依赖、缺服务装载即挂」）：
 * 频道两腿依赖全部经 `VerticalDeps` 在**调用期**显式注入（`run(req, deps)`），
 * mount 期不解析任何宿主服务；dsh-webstack peer 缺席也不影响挂载。
 */
export const inject: readonly string[] = [];

/**
 * 宿主 ctx 的结构化子集（刻意不 `import type { Context }`，理由见文件头注）。
 * 仅声明本入口实际用到的两面：`provide`（注册命名服务）与可选 `effect`
 * （随 fiber 卸载释放注册）。
 */
export interface CordisContextLike {
  /** cordis 服务注册面（f4c/bridge 同款调用：`ctx.provide(name, service)`）。 */
  provide(name: string, service: unknown): void;
  /** 可选 teardown 登记；裸 ctx（单测）缺位时静默跳过。 */
  effect?(teardown: () => unknown, label?: string): unknown;
}

/** `apply` 的可选配置。seed 通道今日不灌 config（§8-ADJ-3），缺省即挂载。 */
export interface XVerticalConfig {
  /** 显式关闭位：`false` 时不注册服务（默认关态纪律在 seed/设置面，非本闸）。 */
  enabled?: boolean;
}

/** `x-vertical` 服务的对外形状：注册表 + 频道实例 + 判定便捷面。 */
export interface XVerticalService {
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
export function apply(
  ctx: CordisContextLike,
  config: XVerticalConfig = {},
): XVerticalService | undefined {
  if ((config.enabled ?? true) === false) return undefined;

  const registry = new VerticalRegistry();
  const channel = new XVerticalChannel();
  const dispose = registry.register(channel);

  const service: XVerticalService = {
    registry,
    channel,
    canHandle: (hints) => registry.canRun(X_VERTICAL_ID, hints),
  };

  ctx.provide(X_VERTICAL_ID, service);
  // cordis `effect(fn)` 语义＝**立即执行 setup、其返回值才是随 fiber 卸载的
  // disposer**（probe 实证 + bridge 同款 `return () => server.stop()` 先例）。
  // 故此处传「返回 disposer 的 setup」，而非直接把 disposer 交给 effect——
  // 后者会被即刻调用、频道刚注册即被摘除（真装载探针曾抓到该错）。
  ctx.effect?.(() => dispose, 'x-vertical-dispose');
  return service;
}
