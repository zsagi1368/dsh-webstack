import { Context } from "@deepseek-ai/cordis";
//#region src/server.d.ts
/** ticket 工厂签名（装配层注入；默认 crypto 随机 base64url）。 */
type TicketIssuer = () => string;
interface BridgeServerOptions {
  /** 一次性 ticket 生成器（由装配层注入，便于审计与测试替身）。 */
  readonly issueTicket: TicketIssuer;
  /** 监听地址；默认且建议保持 127.0.0.1。 */
  readonly host?: string;
  readonly ticketTtlMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly pongTimeoutMs?: number;
}
type RenderResult = {
  content: string;
  statusCode: number;
};
/**
 * 回环桥接服务器。生命周期：`start()` → 扩展 pair/auth → `requestRender()`
 * 往返 → `stop()`。断连语义：已认证连接关闭时，在途渲染全部以 undefined
 * 结算并触发 onDisconnect（内核据此降级 site: 搜索）。
 */
declare class BridgeServer {
  private readonly opts;
  /** 仅在 start() 后赋值；TS-private 保持运行时可枚举以便测试深扫描存储面。 */
  private httpServer;
  private readonly wss;
  /** ticket 只存 sha256(ticket) → 记录；消费即删除。 */
  private readonly tickets;
  /** 已配对长期键的唯一哈希；重新配对即轮换（旧 key 立即失效）。 */
  private pairedKeyHash;
  private readonly socketStates;
  private readonly readySockets;
  private readonly pendingRenders;
  private outboundId;
  private readonly readyListeners;
  private readonly disconnectListeners;
  private started;
  private stopped;
  constructor(options: BridgeServerOptions);
  /** 监听 127.0.0.1 随机端口（listen(0)，由内核分配避免冲突）。 */
  start(): Promise<void>;
  /** 幂等停止：断连接、结算在途渲染、清票据与定时器、释放端口。 */
  stop(): Promise<void>;
  /** 随机端口；未启动或已停止后为 undefined。 */
  getPort(): number | undefined;
  /** 当前是否存在已配对（ready）连接。 */
  isConnected(): boolean;
  /**
   * 签发一次性 ticket：明文经返回值交给装配层（apply 里打进日志），服务端
   * 只落 sha256 哈希与过期时间。
   */
  issueTicket(): string;
  /** 连接就绪（pair 或 auth 成功）回调；返回注销函数。 */
  onReady(listener: () => void): () => void;
  /** 已认证连接断开回调（内核降级信号）；返回注销函数。 */
  onDisconnect(listener: () => void): () => void;
  /**
   * 向当前 ready 连接发 render-req 并等待 render-res；无连接、发送失败、
   * 超时、对端 ok=false、连接中断一律 resolve undefined（调用方降级），
   * 绝不抛错——桥的不可用是「数据」不是异常。
   */
  requestRender(url: string, timeoutMs: number): Promise<RenderResult | undefined>;
  private handleUpgrade;
  private handleConnection;
  private heartbeatTick;
  private handleClose;
  private handleMessage;
  /** 握手态：只认 pair / auth，其余立即断（不重连提示见 protocol.ts 关闭码注释）。 */
  private handleHandshake;
  /** 就绪态：只认 render-res；id 不匹配视为迟到包静默忽略。 */
  private handleReadyFrame;
  /** 单次消费校验：存在、未过期、未消费 → 标记消费并从存储删除（哈希不留痕）。 */
  private consumeTicket;
  private markReady;
  private pickReadySocket;
  private sendJson;
  private closeWith;
  private clearHeartbeat;
  private clearPendingTimer;
}
//#endregion
//#region src/render.d.ts
/**
 * 结构镜像（W-B-05 同款手法）：与 dsh-webstack `SeamBridgeRuntime.render`
 * 契约同形——本包不 import webstack 类型也能编译（结构兼容由装配层与
 * webstack 侧的契约测试共同锁死）。
 */
interface SeamBridgeRuntimeShape {
  render(url: string, timeoutMs: number): Promise<RenderResult | undefined>;
}
/** checkTarget 注入签名：webstack 的 `checkTarget(url, exemptions?)` 的子集像。 */
type CheckTargetFn = (url: string) => Promise<SafetyVerdictLike>;
/** SSRF 裁决最小像。 */
interface SafetyVerdictLike {
  readonly allowed: boolean;
}
interface BridgeRendererDeps {
  /** 底层通道（BridgeServer 的结构子集；测试可注入替身）。 */
  readonly server: {
    requestRender(url: string, timeoutMs: number): Promise<RenderResult | undefined>;
    onDisconnect(listener: () => void): () => void;
    isConnected(): boolean;
  };
  /** SSRF G1+G2 校验器；缺席 = fail-closed（见模块头）。 */
  readonly checkTarget?: CheckTargetFn;
}
declare class BridgeRenderer implements SeamBridgeRuntimeShape {
  private deps;
  private queueTail;
  constructor(deps: BridgeRendererDeps);
  /** 装配层后置注入 SSRF 校验器（如 peer 动态加载成功后的回填）。 */
  setTargetChecker(checkTarget: CheckTargetFn): void;
  get online(): boolean;
  /** 断连回调直通底层通道（内核降级 site: 搜索的触发点）。 */
  onDisconnect(listener: () => void): () => void;
  /**
   * 串行渲染：并发调用按到达顺序排队；单个任务的超时/失败不传染后续。
   * 返回 undefined = 本次桥接不可用（含 SSRF 拒绝），调用方走降级链。
   */
  render(url: string, timeoutMs: number): Promise<RenderResult | undefined>;
  private runOnce;
}
//#endregion
//#region src/protocol.d.ts
/** 一次性配对 ticket 有效期（毫秒）。 */
declare const DEFAULT_TICKET_TTL_MS = 60000;
/** 心跳 ping 间隔（毫秒）。 */
declare const DEFAULT_HEARTBEAT_INTERVAL_MS = 20000;
/** 连续无 pong 判死窗口（毫秒）；实际断开最迟滞后一个心跳周期。 */
declare const DEFAULT_PONG_TIMEOUT_MS = 60000;
/**
 * 关闭码闭集（扩展侧据此决定是否重连提示）：
 * - 4001 配对被拒（ticket 缺失/过期/重复消费/格式非法）——不可重连；
 * - 4002 协议违规（非 JSON / id 缺失 / 握手前杂讯 / 未知类型）——不可重连；
 * - 4003 认证失败（key 与已配对哈希不符，或尚无已配对键）——不可重连。
 * 三者均为「配置或凭据问题」，自动重连只会反复撞墙，故统一要求人工介入。
 */
declare const CLOSE_PAIR_REJECTED = 4001;
declare const CLOSE_PROTOCOL_VIOLATION = 4002;
declare const CLOSE_AUTH_FAILED = 4003;
//#endregion
//#region src/index.d.ts
/** Cordis plugin name used by loader diagnostics (service name = `bridge`). */
declare const name = "bridge";
/** 无强依赖接缝：web seam / logger 均为可选探测（能力缺失即静默降级）。 */
declare const inject: readonly string[];
/** Public plugin configuration type. */
type Config = PluginConfig;
interface PluginConfig {
  /** 总开关；false 时本卫星完全不启动（不占端口、不提供服务）。 */
  enabled?: boolean;
}
/**
 * 配置 schema（Standard Schema V1 最小实现）。刻意不依赖 schemastery：
 * 本包唯一的运行时依赖预算给了 ws（Node 无内置 WS 服务端），而配置面只有
 * 一个布尔开关——字面校验器足够，且让本包保持「monorepo 外可编译、零
 * 深路径耦合」的 W-B-05 姿态。
 */
declare const Config: Readonly<{
  '~standard': {
    version: number;
    validate(value: unknown): {
      value: PluginConfig;
    } | {
      issues: {
        message: string;
      }[];
    };
  };
}>;
/**
 * Assemble the bridge satellite: start the loopback server, provide the named
 * `bridge` service, and emit the one-time pairing ticket through the logger.
 * Everything is registered on the calling fiber — disposal stops the server.
 */
declare function apply(ctx: Context, config?: PluginConfig): void;
//#endregion
export { BridgeRenderer, BridgeServer, CLOSE_AUTH_FAILED, CLOSE_PAIR_REJECTED, CLOSE_PROTOCOL_VIOLATION, Config, DEFAULT_HEARTBEAT_INTERVAL_MS, DEFAULT_PONG_TIMEOUT_MS, DEFAULT_TICKET_TTL_MS, PluginConfig, apply, inject, name };