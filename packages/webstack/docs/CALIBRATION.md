# CALIBRATION — 平台校准事实（发布基线）

本文件记录 dsh-webstack 在 npm 发布与 DSH 平台集成上**已核实的事实**。所有结论
都来自实际安装/联调验证，不是文档推断；后续波次若推翻任何一条，须先改这里。

## 1. npm 生态事实

| # | 事实 | 依据与后果 |
| --- | --- | --- |
| N1 | registry = npmmirror（内网镜像源） | 安装/CI 全部走镜像；`pnpm publish` 前需确认目标 registry，避免把 rc 包发到错误源 |
| N2 | peer 策略：`>=0.1.0-rc.2 <0.2.0` | 六个 `@deepseek-ai/*` 平台包统一区间；rc 期内 API 仍可能破坏性演进，故封顶 `<0.2.0` 而非 `^` |
| N3 | `@deepseek-ai/dsh-invariants` 只有 next tag 提供 rc 版本，无 stable 匹配 | peer 区间无法命中 → 只能进 devDependencies 并**精确钉住**（当前 `0.1.2-alpha.4`），绝不写 `^`/`>=` |
| N4 | 其余平台包在 devDeps 中同样钉精确版本（如 `@deepseek-ai/dsh-web 0.1.2-alpha.4`） | 保证本地测试/类型断言针对的是与 peer 区间一致的确定快照 |

## 2. 平台（宿主）API 事实

以下均经真实 cordis Context + 真实 WebRuntime 联调验证
（见 tests/index-plugin.test.ts 的生命周期闭环）：

| # | 事实 | 对插件设计的约束 |
| --- | --- | --- |
| P1 | `ctx.web.registerSearchProvider` / `registerFetchProvider` **返回 disposer**，随调用方 fiber 释放 | 注册即绑定 fiber 生命周期；无需手工注销，dispose 后宿主自动回落内置语义 |
| P2 | provider 选择规则（六条）：①单一可用 provider 自动选中；②`available()` 必须廉价同步——禁止网络探针与纸面配置检查；③id 冲突拒绝（`WEB_DUPLICATE_PROVIDER`）；④seam 握有最终截断权；⑤provider 报不可用时 seam 回落其它 provider 或原生；⑥健康与否经失败时的可诊断错误表达，不由 provider 自证 | 聚合器 `available()` 只读快照布尔位；注册 id 恒为 `webstack`；`truncated` 恒如实上呈而不代 seam 裁剪 |
| P3 | 宿主 seam 相关错误码词汇为 `WEB_PROVIDER_*`（闭集）；provider 内部错误按原样透传 | 插件侧用自身 `EngineError` 闭集（10 码 + 三分类），不冒充/不重复宿主码 |
| P4 | **seam 不包装 provider 异常**：provider 抛什么，调用方收到什么 | 因此聚合器必须在抛出前自行完成 scrubText 脱敏（W-B-56 边界归我们，不归宿主） |
| P5 | `installSettingsSection(ctx, ns, schema, entry, { setSource, onChange })` 存在且形状稳定 | settings 面走该 API；`setSource(current)` 更新取值源头，`onChange()` 驱动热生效（重建快照 + 刷新 prompt 状态节）；服务缺席时整体不挂载 → 回落组合入口配置 |
| P6 | 宿主**无斜杠命令注册 API** | 不硬造 `/webstack doctor`；诊断经 `web_backend_status` 工具或对话请求触发 |
| P7 | 未装载的 cordis 服务属性**访问时抛错**而非返回 undefined | 一切探测必须 try/catch 兜底（见 GOTCHAS.md G1） |

## 3. 工程决策

| # | 决策 | 理由 |
| --- | --- | --- |
| E1 | 零原生模块 | Fork allowBuilds 白名单约束；也换来任意环境可安装。DNS 用 `node:dns/promises`，XML 解析手写正则，HTML 抽取手写启发式 |
| E2 | 缓存 L0 进程内 Map-LRU + `PersistenceAdapter` 接口占位 | MVP 不依赖平台 storage 服务即可工作；接口冻结后接入 storage/snapshot 或 node:sqlite 即得 L1 write-through，不改调用方 |
| E3 | MCP SDK 未实装 | `mcp` 层词汇与池位已冻结进契约（`LAYER_ENGINE_POOL.mcp = []`），引擎接入属后续波次；避免提前引入未稳定的 SDK 依赖 |
| E4 | 共享签名用本地结构类型 + 动态导入探测（engine.ts / pipeline.ts 先例） | 并行开发期不互相阻塞；打包器可静态分析字面量动态导入；模块缺失统一抛「未接线」transport 错误而非崩溃 |
| E5 | 默认共存档（cordis patch 为空表） | patch 语义（key-level merge vs whole-row replacement）未实证前，接管块保持禁用；能力梯自动降级到 coexist |

## 4. 全组织 overrides 覆写映射（W10b 定版）

**来龙去脉（事实链）：**

1. 上游 `@deepseek-ai/*` monorepo 的包间依赖在 npm 侧大量以 **peer** 形态
   发布，且其内部区间形如 `>=0.1.1 <0.2.0-0`——**stable 渠道没有任何满足该
   区间的版本**：rc 预发布只挂在 `next` dist-tag 上（与 N3 同源，非孤例而是
   全组织面）。
2. 一旦开启 peer 自动安装（`autoInstallPeers: true`），pnpm 必须为这些 peer
   找到满足区间的实体版本；不覆写时要么解析直接失败、要么逐包各自漂移到
   不可复现的快照。
3. 本仓的解法是「一处覆写、全组织生效」：仓库根 `pnpm-workspace.yaml` 的
   `overrides` 把全部 `@deepseek-ai/*` 条目整体钉到同一基线快照（当前
   `0.1.2-alpha.4`）。overrides 的优先级高于任何 manifest 内的 semver 表达
   （含 devDependencies 的精确钉），peer 自动安装一次到位。
4. 与 N2/N4 的关系：peer 区间（`>=0.1.0-rc.2 <0.2.0`）是本包**对外承诺的
   兼容窗口**；overrides 基线是**开发与测试实际对齐的确定快照**。不变式：
   基线 ∈ 区间。升级时两者同步推进，禁止只改一边。

**升级基线操作步骤：**

1. `pnpm view @deepseek-ai/dsh-web dist-tags --json` 读出 next tag 当前解析
   版本（全组织条目同源同版，读一个即可代表整批）；
2. 整体替换 `pnpm-workspace.yaml` overrides 映射中的旧版本号——全部条目
   同一版本，不做逐包混搭；packages/*/package.json 的 devDeps 精确钉同步
   替换（虽然会被 overrides 覆盖，保持一致避免阅读误导）；
3. 确认新版本仍落在本包 peer 区间内；越界即先按契约流程改 N2 区间再升；
4. `pnpm install --no-frozen-lockfile` 刷新锁文件，本地跑
   `pnpm -r run check && pnpm lint`；
5. CI 的 `upgrade-smoke` job 是这条流水线的自动化哨兵：以
   `DSH_BASELINE=next` 动态解析 dist-tag 并临时 sed 替换映射后重装，只跑
   webstack typecheck + `kernel-types.test.ts` 契约结构断言；红 = 上游漂移
   警报（不阻塞主矩阵，但升级前必须先看它）。
