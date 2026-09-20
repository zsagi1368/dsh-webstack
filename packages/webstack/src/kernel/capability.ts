/**
 * 宿主能力探测与降级梯（W-B-08 / F-013）：activate 时对宿主逐一探测耦合点，
 * 产出 CapabilityBitmap，据此选择运行档位 takeover → coexist → diagnostic。
 * 每个探测函数唯一归口本文件；位图变化写入加载标记日志（W-B-78）。
 * TODO(W2-PLATFORM): selectorPatchable/bridgeOnline 的运行期回读验证。
 * @module webstack/kernel/capability
 */

import type { CapabilityBitmap, TierMode } from './types.ts';

/** 全部位为 false 的空位图（诊断档基线）。 */
export function emptyBitmap(): CapabilityBitmap {
  return {
    webSeam: false,
    selectorPatchable: false,
    settingsSection: false,
    inputSlot: false,
    credentialsDomain: false,
    storageService: false,
    bridgeOnline: false,
  };
}

/**
 * 守卫式 seam 读（W1b2 扩面修，W3-F1 同根因处置；单源共用函数——index.ts
 * 的 peekService 自 W1b2 起收敛为本实现的薄封装）。
 *
 * 真 cordis context proxy 对未声明 inject 的服务做**属性读会抛错**而非返回
 * undefined（reflect.ts get trap：`cannot get property "…" without inject`），
 * 裸属性读+try/catch 吞错会让 settings/credentials/storage 诊断位在生产装载
 * 通道恒假阴性（审计面对真实宿主误报缺席）。修形=双通道：
 *
 * ① `ctx.get(key)` 优先——cordis 文档化逃生门「Read a service from the store
 *   without the inject requirement」（strict 缺省 true=只解析 ACTIVE fiber 的
 *   实现；返回 getTraceable 包装=注册面 fiber 托管随动，RA1d 结论不变）；
 * ② get 缺席或无值时属性读回退——保两类兼容面：plain-object mock ctx（无 get
 *   面，属性直读本就安全）与真 Context 上的属性赋值假面（自有属性经 get trap
 *   `Reflect.has` 放行、但对 ctx.get 的 store 查找不可见——实证）。
 *
 * 两通道各自 try/catch 吞错：任何异常=服务缺席=undefined（降级梯哲学不变，
 * 探测永不抛=W-B-47 缺失分支，逐项兜底）。
 */
export function peekServiceValue(ctx: unknown, key: string): unknown {
  if (typeof ctx !== 'object' || ctx === null) return undefined;
  const holder = ctx as Record<string, unknown>;
  // ① get 通道优先（真 cordis 宿主）；get 面自身异常同样吞掉，落回退通道。
  try {
    const get = holder.get;
    if (typeof get === 'function') {
      const viaGet = (get as (name: string) => unknown).call(holder, key);
      if (viaGet !== undefined) return viaGet;
    }
  } catch {
    // 异常 get 面（非常规宿主形）→ 与旧形制同语义，走属性读回退。
  }
  // ② 属性读回退（plain-object mock / 真 Context 属性赋值假面；门控属性读抛错吞成 undefined）。
  try {
    return holder[key];
  } catch {
    return undefined;
  }
}

/**
 * 对未知宿主上下文做结构探测。只做 `typeof === 'function'` 级廉价检查，
 * 不触发任何服务实例化或网络行为。服务读取经 peekServiceValue 守卫式 seam
 * （W1b2，W3-F1 同根因处置）——探测永不抛（W-B-47 缺失分支），逐项兜底。
 */
export function probeCapabilities(ctx: unknown): CapabilityBitmap {
  const bitmap = emptyBitmap();
  if (typeof ctx !== 'object' || ctx === null) return bitmap;
  const peek = (key: string): unknown => peekServiceValue(ctx, key);
  const web = peek('web') as Record<string, unknown> | undefined;
  bitmap.webSeam =
    typeof web?.registerSearchProvider === 'function' &&
    typeof web?.registerFetchProvider === 'function';
  const isObjectLike = (value: unknown): boolean => typeof value === 'object' && value !== null;
  bitmap.settingsSection = isObjectLike(peek('settings'));
  bitmap.credentialsDomain = isObjectLike(peek('credentials'));
  bitmap.storageService = isObjectLike(peek('storage'));
  return bitmap;
}

/**
 * 由能力位图推导运行档位：
 * - webSeam 且选择器可被 patch 指向 → 接管档；
 * - 仅 webSeam → 共存档（注册为可选 provider，用户手动选）;
 * - 其余 → 只读诊断档（仅命令与设置，提示升级）。
 */
export function deriveTierMode(bitmap: CapabilityBitmap): TierMode {
  if (bitmap.webSeam && bitmap.selectorPatchable) return 'takeover';
  if (bitmap.webSeam) return 'coexist';
  return 'diagnostic';
}
