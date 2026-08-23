# Changelog

本项目的所有显著变更记录于此。格式基于 Keep a Changelog；
版本遵循语义化版本（0.x 期 API 不稳定）。

## [0.1.0] - 2026-08-24

初始发布。

### Added

- **内核**：中性聚合器（`WebstackAggregator`）双面注册进宿主 `ctx.web`
  seam（search + fetch）；默认共存档（cordis patch 为空表，不改写上游
  选择器）；能力降级梯 takeover → coexist → diagnostic。
- **搜索管线**：确定性 hints 意图提取（site:/引号短语/时效词/语言）→
  复杂度三档分路由 → 计划引擎集与注册表求交 → 凭据三级链解析 → 缓存指纹
  查询 → singleFlight 包裹 fallback 执行 → RRF 轻量融合 → 截断 → seam 映射。
- **引擎池**：免费池开箱即搜——DuckDuckGo HTML 端点适配器 + Bing RSS lite
  通道；自托管 SearXNG JSON 通道（显式配置 baseUrl 后注册）。api/mcp 层
  池位已冻结、引擎未接入。
- **fallback 与冷却**：错误三分类决策（retryable 同候选退避重试一次 /
  non-retryable 换候选 / terminal 整场终止）；rate-limited / quota 引擎级
  冷却（尊重 retryAfterMs，默认 60s / 300s），冷却期内剔除候选并记 warning。
- **缓存**：L0 进程内 Map-LRU（512 条目，分域 TTL search 10min / fetch
  60min / vertical 30min）；键为 `CacheKeyInput` 全维度 sha256 指纹（含凭据
  指纹）；singleFlight 并发去重；`PersistenceAdapter` L1 接口占位（未接线）。
- **安全**：SSRF 四道闸（G1 静态 → G2 DNS 解析 IP 分类 → G3 重定向逐跳
  复验 → G4 有界响应体）；豁免仅跳 G2；统一出站客户端为唯一下网络通道；
  输出边界 scrubber；上游响应窄化 + 截断转义 + 双语非指令横幅。
- **凭据**：三级链 legacy-literal → credentialRef → env；占位符拦截告警；
  快照仅含掩码 hint 与 opaqueId，明文不出闭包。
- **诊断**：`web_backend_status` 工具 + 对话请求双入口 doctor（零副作用，
  双语渲染，按档位处方）；动态 prompt 状态节；加载标记日志。
- **prompt 守则节**：≤200 词双语行为守则常驻 systemPrompt seam。
- **设置**：`installSettingsSection` 安装组合入口子集 schema，热生效；
  全量 `DEFAULT_SETTINGS` / `HOT_RELOADABLE` 元数据冻结于 settings/schema.ts。

### 已知限制

- api（keyed）/ mcp 层引擎、native delegate 句柄捕获均未接入（对应层池为空）。
- fusion 三参调优权重（timeDecayHalfLifeH / authorityBoost / diversityDiscount）
  已定义但融合排序尚未消费。
- fetch 域缓存未接线（聚合器当前只读写 search 域）。
- 缓存持久层仅内存（L1 `PersistenceAdapter` 占位）。
- 设置面安装的是组合入口子集 schema；全量 DEFAULT_SETTINGS 键集尚未全接。
- 宿主 locale 未探测：守则/状态节固定中文。
- `selectorPatchable` / `bridgeOnline` 无运行期回读验证（接管档自动降级共存）。
- 宿主无斜杠命令注册 API：不提供 `/webstack doctor` 等对话命令。
- IPv6 无 CIDR 豁免形态；DNS 核验与实际连接间存在理论 TOCTOU 竞态窗口。
