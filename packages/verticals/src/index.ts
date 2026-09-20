/**
 * WebStack Verticals (网栈·垂) — 实验性垂直频道卫星包入口。
 *
 * 库面 + 最小 cordis 装配入口：包主体仍是纯库（具名导出供装配层/测试直接
 * import）；自 TC-B2-23C 起 barrel 追加 `name/inject/apply` 三具名出口
 * （见 cordis.ts），使治理宿主 `loader.create({name:<lib/index.js fileURL>})`
 * 能通过 cordis registry 校验（M-F1 判据），并以 `x-vertical` 服务名注册
 * 默认频道。装配语义 = 构造 + 注册 + provide，零网络零定时器。默认关闭纪律
 * 由 seed 的 `enabledAtBoot`（生产恒 false，fix9/RA-2 终态；可挂性由 gate-p
 * P5 沙箱强制 mount 证明）与 webstack 设置面
 * （verticals.packEnabled / channels.x）承载；频道两腿依赖仍由装配层经
 * `VerticalDeps` 注入（缺席静默降级，本包永不直接触网）。既有具名导出
 * 零破坏——`verticals-x` 测试与 peer dsh-webstack 的动态 import 面不变。
 *
 * @module dsh-webstack-verticals
 */

export type { CordisContextLike, XVerticalConfig, XVerticalService } from './cordis.ts';
export { apply, inject, name } from './cordis.ts';
export * from './framework.ts';
export * from './x-search.ts';
