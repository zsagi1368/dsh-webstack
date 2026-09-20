import { Context } from "@deepseek-ai/cordis";
//#region src/kernel/types.d.ts
/**
 * WebStack 契约总纲（CONTRACT FREEZE · Wave 1 定稿，非 stub）。
 *
 * 本文件是 dsh-webstack 全部跨模块公共词汇的唯一事实源。并行工程师只允许
 * 「消费」这里的类型；需要新增或修改公共类型必须走首席架构师（见
 * docs/CONTRACTS.md 协作规则）。所有导出均为冻结契约，字段语义一经发布
 * 不做破坏性变更，只能加可选字段。
 *
 * 设计溯源 id（G:\000Github\DSH\PluginR&D\docs\web-search\81-design-inspiration.md）：
 * - W-B-05 结构镜像契约：HostSeams 在本文件内以独立 interface 重述平台 API，
 *   本包在 monorepo 外可编译、对宿主零 import 依赖（运行时仍走真实 seam）。
 * - W-B-93 双通道结果暴露：NormalizedHit 只含最小可移植字段集。
 * - W-B-35 / W-A-20：url 永远保留「原始首见」表示，身份归一只在缓存键内部发生。
 * - W-B-40：闭集错误码 union + 三分类（retryable/non-retryable/terminal）。
 * - W-B-95：截断权上交 seam——引擎/聚合器不做最终裁剪，truncated 只作可观测标志。
 *
 * @module webstack/kernel/types
 */
/** 路由层。`native` = 直接委托宿主内置 provider（不停用、不重写）。 */
type SearchLayer = 'native' | 'free' | 'api' | 'selfhosted' | 'mcp';
//#endregion
//#region src/client/draft-state.d.ts
/** 状态机五态。 */
type DraftPhase = 'clean' | 'dirty' | 'invalid' | 'saving' | 'failed';
/** 设置卡的扁平可编辑形状。 */
interface WebstackSettingsShape {
  enabled: boolean;
  layer: SearchLayer;
  autoFallback: boolean;
  maxResults: number;
  fusionEnabled: boolean;
  /** 时效半衰期（小时），整数 ≥1。 */
  timeDecayHalfLifeH: number;
  /** 权威域加成系数，0–10。 */
  authorityBoost: number;
  /** 同域重复折价系数，0–1。 */
  diversityDiscount: number;
  /** 抓取渲染字符上限，整数 [200, 8_000_000]（8 MiB 封顶）。 */
  maxContentChars: number;
  /** SSRF G2 豁免行编辑缓冲：每行一条 host:port。 */
  ssrfExemptsText: string;
}
/** 一次不可变状态快照：当前相 + 草稿 + 已提交基线。 */
interface DraftState {
  phase: DraftPhase;
  draft: WebstackSettingsShape;
  committed: WebstackSettingsShape;
}
//#endregion
//#region src/client/index.d.ts
/** 必需服务：槽注册表与字典服务。settingsScope 为软依赖（缺席降级），不入清单。 */
declare const inject: string[];
/**
 * `settings.plugin.item` 的结构性声明合并。权威声明在
 * @deepseek-ai/dsh-client-ui-settings-plugins/client（不在本仓库 devDeps，
 * 见模块注释的降级梯）；此处按调研到的真实形状（keyed、root、按命名空间
 * 寻址）本地声明，使 register 站点获得完整类型检查。
 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'settings.plugin.item': {
      kind: 'keyed';
      scope: 'root';
      keyProps: Record<'webstack', object>;
    };
  }
}
/**
 * 客户端组合入口：字典 + 设置卡 + 联网按钮。
 * @param ctx - 客户端根上下文。
 */
declare function apply(ctx: Context): void;
//#endregion
export { type DraftState, apply, inject };