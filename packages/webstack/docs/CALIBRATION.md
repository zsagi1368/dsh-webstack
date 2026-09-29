# CALIBRATION — 平台校准事实（发布基线）

本文件记录 dsh-webstack 在 npm 发布与 DSH 平台集成上**已核实的事实**。所有结论
都来自实际安装/联调验证，不是文档推断；后续波次若推翻任何一条，须先改这里。

## 1. npm 生态事实

| # | 事实 | 依据与后果 |
| --- | --- | --- |
| N1 | registry = npmmirror（内网镜像源） | 安装/CI 全部走镜像；`pnpm publish` 前需确认目标 registry，避免把 rc 包发到错误源 |
| N2 | peer 策略：`>=0.1.0-rc.2 <0.2.0` | 六个 `@deepseek-ai/*` 平台包统一区间；rc 期内 API 仍可能破坏性演进，故封顶 `<0.2.0` 而非 `^` |
| N3 | `@deepseek-ai/dsh-invariants` 只有 next tag 提供 rc 版本，无 stable 匹配 | peer 区间无法命中 → 只能进 devDependencies 并**精确钉住**（当前 `0.1.7-rc.2`），绝不写 `^`/`>=` |
| N4 | 其余平台包在 devDeps 中同样钉精确版本（如 `@deepseek-ai/dsh-web 0.1.7-rc.2`） | 保证本地测试/类型断言针对的是与 peer 区间一致的确定快照 |

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
| E2 | 缓存 L0 进程内 Map-LRU + `PersistenceAdapter` 接口占位 | MVP 不依赖平台 storage 服务即可工作；原展望「接口冻结后接入 storage/snapshot 或 node:sqlite 即得 L1」已随 R-5(b) 处置（TC-B4-W1③）显式放弃——主线 storage 为 hub/forms 架构、全树无 KV 方法对，装配层不消费 ctx.storage（幻影接线）；终态：cachePersist=durable 恒走 FilePersistenceAdapter（`<home>/.webstack/cache`），StorageSeamAdapter 仅存为库级显式注入面 |
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
   `0.1.7-rc.2`）。overrides 的优先级高于任何 manifest 内的 semver 表达
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

## 5. 基线 0.1.2-rc.1 与 0.1.3 一次性验证记录（2026-09-07）

**承诺态**：`pnpm-workspace.yaml` 213 条 overrides + webstack devDeps 18 条
由 `0.1.2-alpha.4` 整体替换为 `0.1.2-rc.1`（精确钉，无 `^`）；peer 区间 N2
不变（semver 实测 `0.1.2-rc.1` ∈ `>=0.1.0-rc.2 <0.2.0`）。registry 实测：
`@deepseek-ai/dsh-web` 的 next tag = `0.1.2-rc.1`，versions 无 0.1.3。
回归：`pnpm -r run check` EXIT=0（684+21+56 = 761 测试全过）、`pnpm lint`
EXIT=0、`pnpm install --frozen-lockfile` 可复现。

**一次性本地 0.1.3 验证（非承诺态，验证后已还原）**：临时把 28 个实际解析的
`@deepseek-ai/dsh-*` overrides 连同 cordis、schemastery（主仓 vendored
4.0.2 / 3.18.2，统一双身份避免 Context 增广分裂）指向本地主仓
`zDSH-main` 工作树（HEAD `59a5f3ca61`，包版本 `0.1.3-alpha.1`），三轮
typecheck：

| 轮次 | 配置 | 结果 |
| --- | --- | --- |
| RUN01 | 默认（skipLibCheck:true），全 workspace typecheck | **EXIT=0，0 错误** → 插件源码对 0.1.3 类型兼容 |
| RUN02 | skipLibCheck:false（monorepo 图视图） | 17 错误，全部位于第三方/主仓 d.ts（tsdown 工具链可选依赖 TS2307、主仓内部链 `dsh-util-values` TS2307、@types/react 双身份 TS2300、主仓内部类型漂移 TS2344/TS2717、MCP SDK TS2420）；**插件 src/tests 自身 0 错误** |
| RUN03 | skipLibCheck:false + preserveSymlinks（隔离视图） | 149 错误，主体为 vitest 内部模块解析级联（TS2307/TS2882 → tests 文件隐式 any TS7006）；插件 src 0 错误；FileHub R4 隔离视图同型 |

日志与证据：仓根 `del/20260907-113907-0131-adapt/evidence/verify-0131/`
（含 V1 解析路径清单：被解析 d.ts 指向主仓工作树而非 registry 缓存）。
验证后还原承诺态，workspace yaml / lockfile 与验证前快照逐字节一致。

**file-upload 链判定（与 FileHub R4 同判定）**：主仓
`@deepseek-ai/dsh-client-ui-conversation` 的构建产物
`lib/types/client/contract/slots.d.ts:5` 引用
`@deepseek-ai/dsh-client-file-upload/client`，而该包只列在 ui-conversation
的 **devDependencies**（dependencies 中无）→ registry 消费者永远装不到 =
**上游打包缺陷，非插件问题**。link 视图下该链可经主仓嵌套 node_modules
解析，故 RUN02/03 未命中 file-upload 的 TS2307；缺陷由 manifest 事实证成，
不依赖 link 复现。

**未来切换说明（官方发布 0.1.3 后）**：

1. 按 §4 五步把基线 `0.1.2-rc.1` → `0.1.3` 整体替换（213 条 overrides +
   18 条 devDeps + ci.yml sed 锚点 + 本文档措辞），不做逐包混搭；
2. peer 区间已含 0.1.3（semver 实测），N2 不动；
3. **webstack devDeps 须补钉 `@deepseek-ai/dsh-client-file-upload`**——
   否则 ui-conversation d.ts 的 file-upload 链对 registry 消费者不可解析
   （上游缺陷，见上）；默认 skipLibCheck:true 下被抑制，关断即暴露 TS2307；
4. 切换后重跑 `pnpm -r run check && pnpm lint` + `--frozen-lockfile` 验证。

**哨兵盲区（已记录残留风险）**：`upgrade-smoke` 只盯 `next` dist-tag；若官方
发布 0.1.3 stable 而**不移动 next tag**，哨兵盯不到。切换前须人工核对
`pnpm view @deepseek-ai/dsh-web versions`（2026-09-07 实测 versions 无 0.1.3、
next = 0.1.2-rc.1）。

**措辞纪律**：当前状态表述为「对齐 `0.1.2-rc.1` 基线 + 已对本地主仓
`0.1.3-alpha.1` 完成一次性 typecheck 验证」；在官方 0.1.3 发布并完成基线
切换之前，**禁写「已适配 0.1.3」**。（已被 §6 取代：基线现为 `0.1.5-rc.2`）

## 6. 基线 0.1.5-rc.2 切换记录（2026-09-27，任务卡 D4）

**承诺态**：`pnpm-workspace.yaml` 216 条 overrides（原 213 条整体替换
`0.1.2-rc.1` → `0.1.5-rc.2`，另新增 3 条：`dsh-deque`、`dsh-util-crypto`、
`dsh-util-values`——建图后新增的上游包，条目缺失致图内 `^0.1.5-rc.2` 规格
自然漂移到 `0.1.5-rc.3`，而 rc.3 世代 exact peer cordis `"4.0.2"`；补盲后
全图纯 0.1.5-rc.2）+ webstack devDeps 18 条精确钉同步替换；ci.yml
upgrade-smoke sed 锚点同步替换。peer 区间 N2 不变（semver 实测
`0.1.5-rc.2` ∈ `>=0.1.0-rc.2 <0.2.0`）。registry 实测（2026-09-27）：
next tag = `0.1.7-rc.2`（已领先本切换目标；哨兵继续盯 next，下次切换前
仍须按 §5 哨兵盲区纪律人工核对 versions）。

**伴随断点修复（均属切换适配面，逐条证据）**：

1. cordis devDeps（webstack/bridge/verticals 三包）`^4.0.1` → `^4.0.2`：
   宿主 0.1.5-rc.2 全集 peer cordis `^4.0.2`（dsh-web@0.1.5-rc.2 manifest
   实测）；收敛后全图单一身份 4.0.4。对外 peerDependencies `^4.0.1` 未动
   （契约面变更超出 D4 授权，且更宽区间与图内解析无冲突）。（已由 WS-FIX
   卡收紧为 `^4.0.2`：见 §7）
2. webstack dependencies schemastery `^3.18.1` → `^3.18.2`：
   dsh-settings@0.1.5-rc.2 peers `^3.18.2`；修复前图内出现 3.18.1/3.18.2
   双身份（§5 已预警增广分裂风险），收敛后单一身份 3.18.2（= §5 主仓
   vendored 版本）。
3. webstack devDeps 补钉 `@deepseek-ai/dsh-client-file-upload@0.1.5-rc.2`
   （§5 未来切换说明第 3 条落地）：ui-conversation@0.1.5-rc.2
   `lib/types/client/contract/slots.d.ts:5` 仍 import
   `dsh-client-file-upload/client`，而该包仍只在其 devDependencies
   （dependencies ABSENT，manifest 实测）→ 上游打包缺陷在 0.1.5 世代仍在。
4. webstack devDeps 补 `zustand@~4.4.7` + `immer@^10.1.1`（新断点，
   specifier 镜像上游 devDeps）：dsh-client-store@0.1.5-rc.2 `lib/index.js`
   运行时裸 import `zustand/vanilla|middleware|shallow` 与 `immer`，而其
   manifest `dependencies: null`——同类上游打包缺陷；不补钉则
   tests/client-w6.test.ts 以 ERR_MODULE_NOT_FOUND 必挂。

**回归（真实运行输出）**：`pnpm install --no-frozen-lockfile` EXIT=0；
`pnpm peers check` = No peer dependency issues found；`pnpm run typecheck`
EXIT=0（三包）；`pnpm run test` EXIT=0——64 文件 / 928 测试全绿
（webstack 841 + bridge 56 + verticals 31，与批次 4 全谱口径一致）；
`pnpm run build` EXIT=0（webstack lib 4 文件 + client.js；index.d.ts 唯一
DIFF 为 1 行注释 = types.ts 镜像注记传导，index.js 零 DIFF）；
`pnpm run lint` EXIT=0（biome 152 文件零 fixes）。lockfile 断言：
0×`0.1.2-rc.1`、0×`0.1.5-rc.3`。

**措辞纪律（取代 §5 末段）**：当前状态表述为「对齐 `0.1.5-rc.2` 基线」；
在完成向下一世代（0.1.7-rc.x 或 stable）的切换之前，**禁写「已适配
0.1.7」**。§5 未来切换说明第 1-2 条已按本节执行（实际目标版本为
0.1.5-rc.2 而非 0.1.3），第 3 条已实证并补钉；§5 历史验证记录按日期
事实原样保留（其中 `0.1.2-rc.1` 字样为历史记录，不属 pin 残留）。（已被 §8 取代：基线现为 `0.1.7-rc.2`，现状表述见 §8 措辞纪律段）

## 7. cordis 对外 peer 收紧记录（2026-09-27，任务卡 WS-FIX）

**承诺态**：三包（webstack/bridge/verticals）`peerDependencies` 的
`@deepseek-ai/cordis` `^4.0.1` → `^4.0.2`（webstack package.json L115 /
bridge L95 / verticals L94）；devDeps 在 §6 时已是 `^4.0.2`，本次未动；
`peerDependenciesMeta` 与其余平台包 peer 区间（N2）零改动。lockfile 零
漂移——pnpm importers 不记录 peer 规格，git diff 申报面仅 3 份 manifest
+ 本文档。

**依据**：§6 伴随断点修复第 1 条的遗留项落地（D4 时「契约面变更超出卡
授权」未动，现用户全权授权）——宿主 0.1.5-rc.2 全集 peer cordis
`^4.0.2`（dsh-web@0.1.5-rc.2 manifest 实测），lockfile cordis 单一身份
4.0.4（98 处引用、0×4.0.1），收紧后区间与图内解析一致。

**回归（真实运行输出）**：`pnpm install` EXIT=0（Already up to date，无
peer 冲突）、`pnpm install --frozen-lockfile` EXIT=0、`pnpm peers check`
= No peer dependency issues found；`pnpm run typecheck` EXIT=0（三包）；
`pnpm run test` EXIT=0——64 文件 / 928 测试全绿（webstack 841 + bridge
56 + verticals 31，与 §6 口径一致）；`pnpm run lint` EXIT=0（biome 152
文件零 fixes）。

**.pnpm 残留定性（D4 遗留4 收口）**：node_modules/.pnpm 内无引用旧目录
实测共 8 枚——`0.1.2-rc.1` 3 枚（brand/deque/llm，带 cordis@4.0.1 后缀，
即 D4 记录之 3 枚）+ 同性质 5 枚（cordis@4.0.1 本体、brand@0.1.5-rc.2
与 llm@0.1.5-rc.2 各带 4.0.1 后缀、deque@0.1.5-rc.3 带 4.0.1/4.0.4 后缀
各一）。`pnpm install`、`pnpm prune`、`pnpm install --force`（pnpm
11.17.0）均短路 Already up to date，不重建虚拟存储 → 未自清；lockfile
引用全 0（0×`0.1.2-rc.1`、0×`0.1.5-rc.3`、0×`cordis@4.0.1`），活跃身份
齐全（brand/deque/llm@0.1.5-rc.2 带 4.0.4 后缀 + cordis@4.0.4），无功能
影响。定性为惰性残留、不强删；下次 node_modules 全量重建（如按 §4 基线
切换）时自然消失。

## 8. 基线 0.1.7-rc.2 切换记录（2026-09-29，SYNC-P4）

（本节为 289dab1 提交帧文书遗留之补记——P4 卡范围内未落，SYNC-017 波 B1
真源卫生批兑现；事实全部取自该提交信息与当帧门禁输出，计数经本批程序化
复核：pnpm-workspace.yaml 217×`0.1.7-rc.2` = 216 overrides + 1 基线注释、
packages/webstack/package.json 19× 精确钉、ci.yml 2 处〔:64 注释 + :67
转义 sed 锚点〕。）

**承诺态**：`pnpm-workspace.yaml` 216 条 overrides 整体替换
`0.1.5-rc.2` → `0.1.7-rc.2` + 基线注释 1 处（D4 先例：注释陈述当前基线）
+ packages/webstack devDeps 19 条精确钉同步替换 + ci.yml upgrade-smoke
转义 sed 锚点与注释 2 处同步（锚点属轮转面——锚点陈旧=哨兵静默失效=
假绿，D4 bfe2907 先例）。peer 区间 N2 不变；三包 compatible
`>=0.1.5-rc.2 <0.2.0` 未动（semver 实测 `0.1.7-rc.2` 在区间内）。

**#6082 补钉复核（保持）**：client-store/file-upload 补钉
（file-upload@0.1.7-rc.2 的 npm dependencies 仍缺 client-store，当会话
registry 复核）、zustand ~4.4.7、immer ^10.1.1；cordis `^4.0.2`
（devDeps/peers，registry 单一身份 4.0.4 同时满足 ^4.0.2 与 0.1.7 宿主
peer ~4.0.4，lock 验证）。

**伴随断点修复（3 处，均属 0.1.5→0.1.7 破坏面适配）**：

1. `src/client/index.ts`：官方 `SettingsScope` 类型不再由
   ui-settings/client 导出（上游 settings-mirror 重构）→ 本地结构接口
   承接同一 getSnapshot/subscribe/set 面；运行期本就是结构探测
   （peekScopeBinder），消费面不变。
2. `src/index.ts` settings seam：`SettingsForms.register` 在 0.1.7 移除
   （新面 describe/update/replace/mutate，无 watch）→ fail-soft 结构
   探测；register 缺席腿与服务缺席语义同款降级（回落组合入口配置）；
   新面热生效重接线=架构级遗留，升级申报 DEBT-WS-HOTRELOAD（触发器制，
   随 DEBT-SETTINGS-COVERAGE 清偿卡；配方见 P4-settings §3.4），
   不自发明。
3. `tests/client-w6.test.ts` face-4 事实注册表：ui-settings 类型-only
   消费断言翻转为负锁（上游消费面已终结），漂移守卫语义保留，零测试
   删除。

**回归（真实运行输出，289dab1 帧）**：`pnpm install` EXIT=0（lock 再解析
457×`0.1.7-rc.2` / 0×`0.1.5-rc.2`，cordis 单一身份 4.0.4）；
`pnpm install --frozen-lockfile` EXIT=0；`pnpm run typecheck` EXIT=0
（三包）；`pnpm run test` EXIT=0——928/928 全绿（webstack 841/57 文件 +
bridge 56/5 文件 + verticals 31/2 文件）；`pnpm run build` EXIT=0，
prebuilt lib 同帧重建：唯一 diff = packages/webstack/lib/index.js
（+3/-1，探测载体），bridge/verticals lib 字节恒等。备份：仓根
`del/20260929-034840-P4-WebStack`。

**措辞纪律（取代 §6 措辞纪律段）**：当前状态表述为「对齐 `0.1.7-rc.2`
基线」；在完成向下一世代（0.1.8-rc.x / 0.2.0 或 stable）的切换之前，
**禁写「已适配 0.1.8/0.2.0」**。§6 措辞纪律段原文保留、句末已按惯例补
「已被 §8 取代」注记。

