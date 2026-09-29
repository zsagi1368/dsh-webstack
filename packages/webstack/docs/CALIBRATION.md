# CALIBRATION — 平台校准事实（发布基线）

本文件记录 dsh-webstack 在 npm 发布与 DSH 平台集成上**已核实的事实**。所有结论
都来自实际安装/联调验证，不是文档推断；后续波次若推翻任何一条，须先改这里。

## 1. npm 生态事实

| # | 事实 | 依据与后果 |
| --- | --- | --- |
| N1 | registry = npmmirror（内网镜像源） | 安装/CI 全部走镜像；`pnpm publish` 前需确认目标 registry，避免把 rc 包发到错误源 |
| N2 | peer 策略：`>=0.1.0-rc.2 <0.3.0` | 五个 `@deepseek-ai/dsh-*` 平台包统一区间（cordis 另为 `^4.0.2`，不受该区间管辖）；封顶 `<0.3.0` 而非 caret 形——0.2.0 起宿主新增 peer 版本闸门，**caret 钉到 0.2.0 的写法**（等价展开 `>=0.2.0 <0.3.0`；本仓纪律要求该字面 0 命中，故此处一律以展开形书写）在 `0.2.0-rc.2` 下判 **false**，会当场静默禁用装件（semver 7.8.5 实测，sync-020/P4b，真值表见 §9） |
| N3 | `@deepseek-ai/dsh-invariants` 只有 next tag 提供 rc 版本，无 stable 匹配 | peer 区间无法命中 → 只能进 devDependencies 并**精确钉住**（当前 `0.2.0-rc.2`），绝不写 `^`/`>=` |
| N4 | 其余平台包在 devDeps 中同样钉精确版本（如 `@deepseek-ai/dsh-web 0.2.0-rc.2`） | 保证本地测试/类型断言针对的是与 peer 区间一致的确定快照 |

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
   `0.2.0-rc.2`，**恰 204 条**——sync-020/P4b 清偿了 12 条跨轮累积的死条目，
   证据见 §9）。overrides 的优先级高于任何 manifest 内的 semver 表达
   （含 devDependencies 的精确钉），peer 自动安装一次到位。
4. 与 N2/N4 的关系：peer 区间（`>=0.1.0-rc.2 <0.3.0`）是本包**对外承诺的
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
「已被 §8 取代」注记。（已被 §9 取代：基线现为 `0.2.0-rc.2`，现状表述见
§9 措辞纪律段；本节其余内容为 2026-09-29 帧的历史事实，按纪律原样保留。）

## 9. 基线 0.2.0-rc.2 切换记录（2026-09-30，sync-020 / SYNC-P4b）

**承诺态（六处，计数全部程序化复核，禁肉眼）**：

1. `pnpm-workspace.yaml` overrides：**204 条活条目**整体替换 `0.1.7-rc.2` →
   `0.2.0-rc.2` + **删除 12 条死条目**（清单与逐条证据见下）+ 基线注释 1 处
   随动 + 新增 7 行清偿说明注释。轮转后 pyyaml 实测：`overrides` **恰 204 条**、
   值直方图 `{'0.2.0-rc.2': 204}`（**单一值**）、无重名、`packages`/`autoInstallPeers`
   两键完好、cordis 与 schemastery **本体不在表内**（表内 4 个含 cordis 字样者
   均为 `dsh-*-cordis*` 包）。文件仍为 LF、无 BOM、尾行换行保留。
2. `packages/webstack/package.json`：devDeps **19 条**精确钉同步替换
   （**裸形保持裸形，未补 `=`**：改后 `"=0.2.0-rc.2"` 命中 0）；
   **peerDependencies 5 条放宽** `>=0.1.0-rc.2 <0.2.0` → `>=0.1.0-rc.2 <0.3.0`
   （dsh-web / dsh-settings / dsh-tools / dsh-credentials / dsh-llm）。
   `dsh.compatible` **未动**（仍 `>=0.1.5-rc.2 <0.2.0`；该字段权属在工厂侧，
   且 Workbench 有测试把它钉为 factory-set form，另卡处置）。
3. `packages/bridge`、`packages/verticals`：**零改动**（实测二者仅
   `@deepseek-ai/cordis ^4.0.2` devD+peer，无 `dsh-*` 版本 pin）。
4. `ci.yml` upgrade-smoke：转义 sed 锚点 `0\.1\.7-rc\.2` → `0\.2\.0-rc\.2`
   + :64 注释 1 处，共 2 处（锚点属轮转面——锚点陈旧 = 哨兵静默失效 = 假绿，
   §8 与 D4 bfe2907 先例）。
5. `GOTCHAS.md` G3：示例版本与 peer 区间两个字面随动（该句因 N2 放宽而失真）。
6. 本文件：N2/N3/N4 与 §4 第 3-4 条的**现状字面**更正；§5/§6/§7/§8 的
   **历史事实一律原样保留**，仅按惯例在 §8 措辞纪律段句末补「已被 §9 取代」注记。

**12 条死条目清偿（逐条双侧证死，非沿袭上一轮的 216 条全轮）**：

| 包（去 scope 短名） | 官方 0.1.7-rc.2 树 | 官方 0.2.0-rc.2 树 | npm `0.1.7-rc.2` | npm `0.2.0-rc.2` | `dist-tags.latest` |
|---|---|---|---|---|---|
| dsh-acp-demo | ABSENT | ABSENT | NO | NO | 0.0.1-rc.1 |
| dsh-agent-presets | ABSENT | ABSENT | NO | NO | 0.0.1-rc.1 |
| dsh-agent-spine-demo | ABSENT | ABSENT | NO | NO | 0.0.1-rc.1 |
| dsh-code-runtime | ABSENT | ABSENT | NO | NO | 0.0.1-rc.1 |
| dsh-code-runtime-worker-thread | ABSENT | ABSENT | NO | NO | 0.0.1-rc.3 |
| dsh-e2b | ABSENT | ABSENT | NO | NO | 0.0.1-rc.1 |
| dsh-host-apiproxy | ABSENT | ABSENT | NO | NO | 0.0.1-rc.1 |
| dsh-sdk-jsonrpc-demo | ABSENT | ABSENT | NO | NO | 0.0.1-rc.5 |
| dsh-session-persistence-sqlite | ABSENT | ABSENT | NO | NO | 0.0.1-rc.1 |
| dsh-settings-file | ABSENT | ABSENT | NO | NO | 0.0.1-rc.3 |
| dsh-tool-subagent-report | ABSENT | ABSENT | NO | NO | 0.0.1-rc.1 |
| dsh-workflow-worker-thread | ABSENT | ABSENT | NO | NO | 0.0.1-rc.3 |

- 树侧方法：`git ls-tree -r --name-only <ref>` 全量 `package.json` 逐个 `git show`
  读 `name` 建 name→dir 反查表（base 350 件 / 348 具名，target 354 件 / 352 具名；
  只数 `packages/` 则为 321 → 325）。12 条在**两棵树里都不存在** ⇒ 不是 0.2.0 新删，
  而是**上一轮之前就已死**的跨轮累积噪声（其中 `dsh-code-runtime`、`dsh-e2b`
  正是 sync-017 记录的官方真删 2 包）。
- npm 侧**阳性对照**（防假阴性，同命令形式）：dsh-web / dsh-llm / dsh-tools /
  dsh-invariants / dsh-client-ui-conversation / dsh-client-ui-renderer /
  dsh-host-webserver —— **7/7 对 `0.1.7-rc.2` 与 `0.2.0-rc.2` 双双 YES** ⇒
  上表 12 条的 NO 为真阴性。
- **删除的可证安全性（演绎，非经验）**：这 12 条的**原值 `0.1.7-rc.2` 本身就是
  npm 上不存在的版本**，而 install 一直成功 ⇒ 这些包**根本不在依赖图内**
  （否则解析到不存在的版本必然失败）⇒ 删掉该 override 对解析结果**零影响**。
  反向选择（轮转到 `0.2.0-rc.2`）等于**再写一个明知不存在的值**，会误导读者
  以为该包在 rc.2 存在；留旧值则同样是假值且造成表内两种版本并存、更难审。
- **计数口径变更**：overrides 面从「216 条」变为「**204 条**」。§8 记载的
  「217×`0.1.7-rc.2` = 216 overrides + 1 基线注释」是当帧事实，原样保留。

**peer 放宽的 semver 真值模拟（semver **7.8.5**，即本仓实际解析到的
`node_modules/.pnpm/semver@7.8.5`，与官方 app-boot 依赖同版；闸门同款
`{includePrerelease:true}`）**：

| runtime | 旧值 `>=0.1.0-rc.2 <0.2.0` | **新值 `>=0.1.0-rc.2 <0.3.0`** | `>=0.2.0 <0.3.0`（＝caret 钉到 0.2.0 的展开形，**错误修法**） |
|---|---|---|---|
| **`0.2.0-rc.2`（本轮）** | true | **true** | **false ← 会当场静默禁用装件** |
| `0.2.0`（正式版） | **false ← 定时雷** | **true** | true |
| `0.2.1` | false | **true** | true |
| `0.3.0` | false | **false（正确失效点）** | false |
| `0.1.7-rc.2`（旧基线） | true | true | false |

⇒ 新值是**唯一同时满足「本轮不坏」与「正式版不坏」**的形；caret 钉到 0.2.0 的写法
（展开形 `>=0.2.0 <0.3.0`，见上表第 3 列）在 `0.2.0-rc.2` 下判 false，**严禁采用**。排序事实实测：`lt('0.2.0-rc.2','0.2.0')=true`、
`gt('0.2.0-rc.2','0.1.7-rc.2')=true`、`lt('0.2.0-rc.2','0.3.0')=true`。
去掉 `includePrerelease` 后 rc.2 对新旧区间**均判 false** ⇒ 该 flag 是承重墙。

**19 个 devDep 包的官方 `src/` 子树 OID 对账（base vs target，dir 由 name 反查）**：
**15 IDENTICAL / 4 DIFFERS**。

- IDENTICAL（15）：dsh-client-locale `5a914588cf`、dsh-client-store `8a34b370b7`、
  dsh-client-ui-input-trigger `526e8daf9a`、dsh-client-ui-settings `23bc880ed2`、
  dsh-client-ui-slots `cce09249d6`、dsh-attachment `d10adf40bf`、dsh-agent `8fbb7ac176`、
  dsh-typert-protocol `708775ffc3`、dsh-client-file-upload `cc257b6c7a`、
  dsh-invariants `1dbf691207`、dsh-llm `fabaf75e13`、dsh-settings `bd2a95c789`、
  dsh-tools `234fb99ccd`、dsh-credentials `4a2301cc40`、dsh-web `87d65578fe`。
- DIFFERS（4），逐个查导出面（`git diff base target -- <dir>/src`）：
  | 包 | `-export` | `+export` | 定性 |
  |---|---|---|---|
  | dsh-client-ui-renderer | **0** | 0 | 唯一改动＝`src/client/scoped-slots.tsx` 1 行：`nextAncestors` 上移并包进 `useMemo`（React hooks 顺序修正），**无 API 变化** |
  | dsh-client-ui-conversation | **0** | 3 | src 内 12 文件 +129/−32，新增 `MessageSubmissionState`/`MessageSubmission`/`reportMessageSubmission`，**零删除** |
  | dsh-api-remotes | **0** | 2 | `src/client/index.ts` +7/−2，新增两条 `export type {}` 空类型再导出，**零删除** |
  | dsh-session | **1** | 2 | 见下专项 |
- **dsh-session 专项（`-export`=1 的逐字定性）**：`src/index.ts` 全文件 diff **恰 1 行**，
  且为**严格增量**——
  `-export { interruptedTurnClosers, TOOL_NOT_STARTED, TOOL_OUTCOME_UNKNOWN } from './repair.ts'`
  `+export { interruptedTurnClosers, ToolCallRecovery, TOOL_NOT_STARTED, TOOL_OUTCOME_UNKNOWN } from './repair.ts'`
  原三个名字**全部保留**，只**新增** `ToolCallRecovery`；index.ts 其余 16 条 export 行
  （:27-31、:33-36、:171、:200、:446、:895、:904、:911、:925、:1327、:1328）逐行字节相同。
  `repair.ts` 虽 +114/−80（重构抽出 `ToolCallRecovery` 类），但三个被再导出符号的
  **声明签名逐字相同**：`TOOL_NOT_STARTED`/`TOOL_OUTCOME_UNKNOWN` 仍为同值 const、
  `interruptedTurnClosers(events: readonly SessionEvent[]): SessionEvent[]` 签名不变、
  `openTurnClosers(events, cause)` 与 `OpenTurnCloseCause` 不变。
  ⇒ **导出面零删除、一项新增**；`-export` 命中来自「一条 export 语句被改写」而非「导出被移除」。
  另实测 **WebStack 全仓对 `dsh-session` 的引用只有 `packages/webstack/package.json:155`
  这一条 devDep 声明，src/tests 内零 import** ⇒ 该包即使有破坏面也影响不到本仓编译与运行。

**回归（真实运行输出，本帧）**：

- `pnpm install` EXIT=0（pnpm 11.17.0，Scope: all 4 workspace projects，+37/−37 包）；
  lock 再解析 **445×`0.2.0-rc.2` / 0×`0.1.7-rc.2`**（基线为 457×旧 / 0×新）；
  lock 头部 `overrides` 段 = **204 条、值单一 `0.2.0-rc.2`**（与 workspace 文件一致）。
- **结果判据（overrides 表充分性证明）**：程序化提取 lock 内全部
  `@deepseek-ai/dsh-*` 解析身份 → **distinct 84 个，非 `0.2.0-rc.2` 者 0 个**。
  ⇒ **无需增补 rc.2 新增包**；反证：`dsh-config-editor`、`dsh-package-manifest`、
  `dsh-ptc-runtime` 三个 rc.2 新包**不在 override 表内**却同样解析到 `0.2.0-rc.2`。
- **cordis 家族零漂移**（改前/改后 lock 版本集合逐一相同）：cordis `4.0.4`、
  schemastery `3.18.2`+`3.18.4`、cosmokit `1.8.5`、cordis-plugin-loader `1.0.5`、
  cordis-plugin-include `1.0.9`、cordis-plugin-group `1.0.4`。
- **install 后实测落位版本（禁采信 exit 0）**：19 条 devDep 从
  `packages/webstack/node_modules/<pkg>/package.json` 逐个读 `version` →
  **19/19 = `0.2.0-rc.2`，mismatches NONE**（含 5 个 peer 放宽对象）。
  注：本仓为 monorepo，devDeps 链接在 `packages/webstack/node_modules` 下，
  在仓根读会全部 MISS（属读取路径错误，非落位失败）。
- `pnpm install --frozen-lockfile` EXIT=0：「Lockfile is up to date, resolution step
  is skipped / Already up to date / ✓ passes supply-chain policies (299 entries)」，
  lock 与 workspace 两文件 md5 **前后同值** ⇒ 零隐式回写。
- lock 内 **git/tarball 依赖 0 条** ⇒ pnpm 11.7.0 `inheritedParentPkgBreaksPeerDiamond`
  不适用，双工具 SOP 与判据三套无需启动（本机 pnpm 实测 11.17.0，与 `packageManager` 一致）。
- `pnpm run typecheck` **EXIT=0（三包全绿）**——这是 P3 明确要求的**全仓 tsc 双保险**。
- `pnpm run test` **EXIT=0，928/928 全绿**：webstack **841/57 文件** +
  bridge **56/5 文件** + verticals **31/2 文件**；`failed`/`FAIL`/`✗`/`×` 命中均为 0。
  与 §8 记载的上一轮 928/928（841/57 + 56/5 + 31/2）**逐数相同** ⇒ 无测试静默掉队。
  include 模式核对：三包均为 `tests/**/*.test.ts(x)`，实测 `.test.ts(x)` 文件数
  57/5/2 与 include 精确吻合；webstack 另有 **1 个 `.spec.ts`**
  （`tests/tools-host-contract.spec.ts`）**被 config 显式排除**在默认 run 之外
  （config 注释说明其经 `test:contract` 单独跑）⇒ 非 FileHub 那类 include 漏配假绿。
- `pnpm run test:contract` **EXIT=0，8/8 全绿**（宿主契约结构断言，对着同级
  zDSH-main 的 0.2.0-rc.2 合并树跑）。
- `pnpm run build` **本轮未跑**：本次改动**零 `src/` 文件**（porcelain 可证），
  prebuilt `lib/` 与源码仍同帧，不触发 §8 的「prebuilt 同帧重建」纪律。

**工具生成面（pnpm 11.17.0 新行为，登记以免被误判为越界改动）**：install 时 pnpm
自动往 `pnpm-workspace.yaml` 追加 **37 条 `minimumReleaseAgeExclude`**（`pkg@0.2.0-rc.2` 形），
并提示 `set minimumReleaseAgeStrict to true to gate these updates with a prompt`。
实测 `minimumReleaseAge` **主键在任何载体上都不存在**（仓内 `.npmrc`〔本仓无此文件〕/
`pnpm-workspace.yaml` / 三个 `package.json`、`pnpm config get`、`npm config get`、
`~/.npmrc`、`npm config get globalconfig` 指向的文件不存在、`pnpm config list` 全量），
⇒ 该清单当前**惰性**；它的作用是防止当日发布的 rc.2 被供应链年龄策略静默降级。
同批同现象已在 FileHub（新增 14 条）与 Workbench（就地加宽 3 条为
`pkg@0.1.7-rc.2 || 0.2.0-rc.2`，条目数不变）复现。**未修改任何 pnpm 用户级/全局配置。**
⇒ `pnpm-workspace.yaml` 属**预期改动面（工具生成）**，「改动面只在 package.json + lock」
这条旧判据在 11.17.0 下天然不成立。

**惰性残留定性（沿用 §5 末段先例，不强删）**：`.pnpm` 虚拟存储内仍有 112 个
`0.1.7-rc.2` 目录（37 个唯一包名，与上面 37 条 exclude 一一对应），但**再生后的 lock 内
`0.1.7-rc.2` 命中为 0**、且 `packages/webstack/node_modules` 下 19/19 实测为 rc.2 ⇒
残留属**未清理的孤儿目录、不在解析图内**，无功能影响。未执行 `pnpm store prune`
（跨仓共享存储，动它属系统级状态变更）；下次 node_modules 全量重建时自然消失。

**措辞纪律（取代 §8 措辞纪律段）**：当前状态表述为「对齐 `0.2.0-rc.2` 基线」；
在完成向下一世代（0.2.0 正式版 / 0.2.1 / 0.3.0 或 stable）的切换之前，
**禁写「已适配 0.2.0 正式版」**——本轮对齐的是 rc.2 字节面，peer 上界 `<0.3.0`
对**未来 0.2.x** 的兼容性依赖 semver 线内约定，不是字节级证明（P3 诚实边界，
本轮以全仓 tsc + 928/928 + 契约 8/8 作行为级双保险）。§8 措辞纪律段原文保留、
句末已按惯例补「已被 §9 取代」注记。

