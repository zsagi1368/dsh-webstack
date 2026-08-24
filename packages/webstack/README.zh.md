# dsh-webstack（WebStack / 网栈）

DeepSeek Harness（DSH）的集成式网页**搜索 + 抓取内核插件**。WebStack 以单一中性聚合器注册进宿主 `ctx.web` seam（search + fetch 双面），把全部路由决策——层级路由（`native` / `free` / `api` / `selfhosted` / `mcp`）、查询复杂度分档、多引擎 fallback、RRF 融合、缓存、凭据解析与 SSRF 四道闸安全管线——收拢在插件内部。捆绑的 cordis patch 为空表：默认共存档，不改写上游选择器，除非用户显式选择接管。

## 特性

- **免费池开箱即搜** —— DuckDuckGo HTML 端点 + Bing RSS「lite」轻通道；`free` 层结构性零凭据（免费档引擎禁止要求密钥）。
- **keyed 六家引擎矩阵** —— Tavily / Brave / Exa / Jina / Firecrawl / AnySearch 全量接线进 `api` 层候选池；无键即结构化 `auth` 失败交 fallback 换候选，绝不匿名降级。
- **MCP 层接入** —— 配置的 `mcpServers` 条目逐条过 `validateMcpEntry`（裸 npx 结构性拒绝），合法条目注册为通用 MCP 搜索引擎；stdio/http 双 transport、SDK 可选 peer 缺席静默降级。
- **原生委托档** —— `native` 层经委托引擎转发宿主内置 provider（句柄捕获为平台侧 TODO，缺位时可诊断失败并回落）。
- **垂类卫星腿（实验性）** —— `verticals.packEnabled && verticals.channels.x` 时惰性动态导入 `dsh-webstack-verticals`：免费池 `site:` 双站检索 + 官方 oEmbed 富化的合规免凭据 X 降级链；卫星包缺失静默跳过 + i18n 诊断键。
- **hints 意图层** —— 纯正则从原始查询确定性提取 `site:` 限域、引号短语、时效词与语言提示；硬约束下推引擎，软偏好仅尽力。
- **复杂度分档路由** —— 按冻结规则分档 `simple` / `medium` / `complex`，分档决定参与引擎数量与是否融合。
- **RRF 融合** —— 多引擎结果按排名倒数加权合并（Σ 1/(k+rank)，k=60）；时效半衰期 / 权威域乘子 / 同域多样性折扣三参可配；同 URL 去重保留「首见原样」字符串，来源引擎并入 `via` 标注。
- **fallback + 引擎冷却** —— 有序候选执行，按错误三分类决策（`retryable` 同候选退避重试一次、`non-retryable` 换下一候选、`terminal` 整场终止）；`rate-limited` / `quota` 触发引擎冷却（尊重服务端 `retryAfterMs`，默认 60 s / 300 s）。
- **缓存指纹 + singleFlight + L1 持久层** —— 键为 `CacheKeyInput` 全维度（层/引擎集/条数/hints/档位/**凭据指纹**）的 sha256；并发同键搜索共享在飞 Promise。`cache.persist=durable` 时 write-through 到宿主 storage seam 或文件（`~/.webstack/cache`），磁盘故障静默降级为 miss。
- **凭据三级链** —— 遗留字面值（`engines.<id>.key`）→ 宿主 `credentialRef` → 环境变量，每次操作起点解析一次；快照只含布尔态、掩码 hint 与 opaque 哈希 id；明文仅装进本次引擎请求对象（进程内传递），凭据轮换即刻换缓存键。
- **SSRF 四道闸** —— G1 静态校验 → G2 DNS 解析 IP 分类 → G3 重定向逐跳复验 → G4 有界响应体。豁免（`host:port` / IPv4 CIDR）只能跳过 G2，永不影响 G1/G3/G4。
- **T3 桥接兜底（可选卫星）** —— 浏览器桥接卫星在线时，静态抓取管线失败或正文过短（疑似 JS 空壳）则单次 `bridge.render(url, 8s)` 兜底；结果以 `statusCode=0`（非 HTTP 通道约定）与 `via='bridge'` 标注，`ssrf-blocked` 绝不绕行。
- **会话联网模式** —— Host-owned 三态状态机（off/on/ask）；`mode.sessionOnline=on` 时搜索强制 fresh 跳缓存读（写侧照常），由设置驱动即时生效。
- **Windows 系统代理兜底** —— `advanced.winProxyFallback=true` 时启动早期探测系统代理并注入 `HTTPS_PROXY`/`HTTP_PROXY`（尽力而为层，默认关闭不偷改环境）。
- **能力降级梯** —— 全部可选接缝（settings / systemPrompt / tools / credentials / storage / bridge）先探测后使用；能力缺失降级而非报错。
- **工具三件套** —— `web_backend_status`（零副作用诊断，含桥接/垂类状态行）、`web_batch_search`（≤10 条批量扇出走聚合管线，保序、逐项隔离、超限显式拒绝）、`web_history`（list/clear 参数化回放最近搜索/抓取账本）。
- **doctor 双语诊断** —— `runDoctor` 产出机器可读报告（引擎态 ∪ 配置面未接线项 ∪ 桥接 ∪ 垂类三态），`renderDoctor` 渲染中/英文本并按档位给出处方。
- **prompt 守则节与状态节** —— ≤200 词行为守则节 + 动态 ≤80 词状态行（含桥接/垂类短句）注册进 systemPrompt seam。

## 安装

WebStack 是 DSH 插件，以 npm 包 [`dsh-webstack`](https://www.npmjs.com/package/dsh-webstack) 分发。通过你的 DSH 插件机制（bundle 清单 / cordis patch 列表）接入：

```yaml
# bundle 依赖
dependencies:
  - name: dsh-webstack
```

包内含预构建 ESM（`lib/`）、cordis patch 描述文件 `dsh-webstack/cordis.patch.yml`（空表 = 共存档），平台包一律声明为 peer 依赖：

- 必需：`@deepseek-ai/cordis`、`@deepseek-ai/dsh-web`
- 可选（能力探测后使用）：`@deepseek-ai/dsh-settings`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-credentials`、`@deepseek-ai/dsh-llm`

Node.js >= 22.19。零原生模块；运行时依赖仅 `@deepseek-ai/schemastery`。

### 卫星包

本 monorepo 附带两个可选伴生包：

- **`dsh-webstack-bridge`** —— 浏览器扩展卫星，提供 T3 渲染兜底（静态抓取
  失败/JS 空壳救援）。安装与配对指引：[`packages/bridge/extension/README.md`](../../packages/bridge/extension/README.md)。
- **`dsh-webstack-verticals`** —— 实验性 X/Twitter 垂直腿（免费池 + oEmbed
  合规链，免凭据）。经 `verticals.packEnabled` + `verticals.channels.x`
  开启；开启需重载插件。

## 配置

全量键集见 `src/settings/schema.ts`（`DEFAULT_SETTINGS`）。「热」= 下一次操作即生效；「重启」= 涉及引擎/进程结构变化，需重载插件。

| 键 | 默认 | 生效 | 说明 |
| --- | --- | --- | --- |
| `enabled` | `true` | 热 | 总开关；关闭 = provider 上报不可用，seam 自动回落 |
| `search.layer` | `free` | 热 | `native` / `free` / `api` / `selfhosted` / `mcp` |
| `search.autoFallback` | `true` | 热 | `false` = 只用首选单引擎 |
| `search.maxResults` | `8` | 热 | 请求级 `maxResults` 存在时优先 |
| `search.fusion.enabled` | `true` | 热 | RRF 融合总开关 |
| `search.fusion.timeDecayHalfLifeH` | `24` | 热 | 时效半衰期（小时），0 = 关闭时效衰减 |
| `search.fusion.authorityBoost` | `1.0` | 热 | 权威域加权系数（1 = 不加权） |
| `search.fusion.diversityDiscount` | `0.85` | 热 | 同域重复结果折价系数（1 = 不折扣） |
| `search.complexityRouting` | `true` | 热 | 关闭 = 固定按 medium 宽度取池 |
| `fetch.pipeline` | `t1` | 热 | `t1` / `t1+t2` / `t1+t2+t3` |
| `fetch.defaultMode` | `raw` | 热 | 抽取首选模式（回退链可能降级达成） |
| `fetch.maxContentChars` | `12000` | 热 | 渲染预算；canonical 按 ×4 派生封顶 8 MiB |
| `mode.sessionOnline` | `off` | 热 | 会话联网模式词汇 `off/on/ask`；`on` 强制 fresh 跳缓存读 |
| `cache.enabled` | `true` | 热 | 搜索结果缓存开关 |
| `cache.ttlSearchMin` | `10` | 热 | search 域 TTL（分钟） |
| `cache.ttlFetchMin` | `60` | 热 | fetch 域 TTL |
| `cache.persist` | `memory` | 热 | `durable` 启用 L1：宿主 storage seam 优先，回落文件 `~/.webstack/cache` |
| `safety.ssrfExempts` | `[]` | 热 | 仅跳 G2 的豁免：`host:port` 或 IPv4 CIDR |
| `engines` | `{}` | **重启** | 引擎级节点：`key`（历史别名 `apiKey`）/ `credentialRef` / `enabled` |
| `mcpServers` | `[]` | **重启** | MCP server 条目表；过 `validateMcpEntry` 的注册为搜索引擎，拒绝项进 doctor unwired 清单 |
| `verticals.packEnabled` | `false` | 热* | 垂类卫星包总闸；关闭即时生效，开启需重载插件（结构注册） |
| `verticals.channels.x` | `false` | 热 | X 频道开关（受 `verticals.packEnabled` 总闸约束，双开才注册垂直腿） |
| `verticals.selectorRules` | `[]` | 热 | 站选定制源规则（`hostSuffix` + CSS 选择器子集），抓取入口命中后优先选择器抽取 |
| `advanced.hintsLocale` | `auto` | 热 | hints 词表语言 |
| `advanced.winProxyFallback` | `false` | 热 | 开启后启动早期探测 Windows 系统代理并注入 env（尽力而为层） |

安装期组合入口接受上述键的扁平子集：`enabled`、`layer`、`autoFallback`、`maxResults`、`complexityRouting`、`fusionEnabled`、`maxContentChars`、`ssrfExempts`、`searxngBaseUrl`（自托管 SearXNG 根地址；空串 = 不注册该引擎）、`sessionOnline`、`cachePersist`、`winProxyFallback`、`engines`、`mcpServers`、`verticalsPackEnabled`、`verticalsChannelX`。

## 诊断

宿主当前未向插件暴露斜杠命令注册 API，因此 WebStack 刻意不硬造 `/webstack doctor`。三个等价入口：

- 让模型调用 **`web_backend_status` 工具**（tools seam 在场时自动注册）：零副作用返回运行档位、各引擎状态（含冷却剩余毫秒与最近错误码）、桥接卫星与垂直频道状态行，以及缓存命中/未命中/条目数统计；
- **`web_batch_search`**：一次调用批量扇出至多 10 条查询，走同一条聚合管线（凭据/缓存/融合/fallback 全一致），结果保序、逐项结构化隔离；
- **`web_history`**：回放（list）或清空（clear）最近搜索/抓取环形账本。

三者均只读本地数据或走既有管线：不发网络探针、不暴露任何凭据。

## 文字版管线图

一次搜索操作的完整路径：

```
query
  → extractHints      # site:/引号短语/时效词/语言 → SearchHints（确定性）
  → estimateBand      # simple | medium | complex
  → planSearch        # 层池 × 分档宽度 × autoFallback → engineIds；命中垂类触发矩阵加发垂直腿
  → creds             # 三级链每操作解析一次 → 快照 + 凭据指纹 + 明文按槽位进请求对象
  → cache             # CacheKeyInput 全维度 sha256 指纹（含凭据指纹）；mode=on 强制 fresh 跳读
  → fallback          # registry.runWithFallback：冷却剔除 / 重试一次 / 终态中止
  ├─ 垂直腿            # 计划尾加发 dsh-webstack-verticals X 腿（实验性，随档位预算 race 结算）
  → RRF               # fuse 按 URL 身份去重，Σ1/(60+rank)，三参加权，分数归一化
  → seam              # 截断至 count，映射 NormalizedHit[] → SeamWebSearchResult
```

抓取操作走同一条出站通道：

```
url
  → budgets           # canonical = min(maxContentChars×4, 8 MiB)；三层独立互不挤占
  → SSRF 四道闸        # G1 静态 → G2 DNS → G3 重定向逐跳复验 → G4 有界读体
  → 站选规则           # selectorRules 命中 → 选择器抽取优先（mode=fit）
  → 抽取回退链         # raw→fit 有内容者胜；JSON 分支 pretty-print
  → 上呈              # 状态即数据 + 全空解释文案；T3：失败/过短单次 bridge.render 兜底
```

桥接卫星在线时，管道故障或正文过短会单次 `bridge.render` 兜底（`statusCode=0`、`via='bridge'`）。

各阶段性能包线与预算对照见 [`docs/BENCHMARK.md`](./docs/BENCHMARK.md)（本地复现：`pnpm --filter dsh-webstack bench`）。

## 设置面板

客户端半（`dsh-webstack/client`，构建产物 `lib/client.js`，经 ModuleLoader 握手注入 Web GUI）提供两块浏览器面：

**设置卡（Settings → Plugins，keyed slot `settings.plugin.item`，key = `webstack`）**
编辑字段与宿主设置 schema 对齐：总开关、默认路由层、结果条数上限（1–50）、候选展开、fusion 三参（timeDecayHalfLifeH / authorityBoost / diversityDiscount）、抓取字符上限、SSRF 豁免清单（每行一条 `host:port`）。所有改动先进暂存草稿状态机（clean / dirty / invalid / saving / failed 五态），校验通过才允许保存，保存按点路径逐条排队写入；引擎 `apiKey`/`credentialRef` 不在卡片编辑面内，密钥永不进入浏览器渲染树。

达成层级（降级梯）：

1. 宿主暴露可写的 `settingsScope` 服务 → 暂存草稿可编辑并落宿主设置文档；
2. `settingsScope` 可达但不可写（memory 模式等）→ 只读展示生效值；
3. `settingsScope` 不可达（当前版本即此形态：类型与服务面所在的
   dsh-client-ui-settings 系列未随插件分发）→ 以内置默认值为基线的只读展示卡，
   并在卡面注明改用配置档 `webstack:` 段修改。

**联网模式按钮（composer 工具行左端，列表槽 `conversation.input.left`）**

会话级三态循环 off → on → ask（对应 `mode.sessionOnline`）。`settingsScope` 可写时点击同步落宿主文档；不可达时退化为会话内本地态（刷新还原），按钮提示注明。

## Roadmap TODO

剩余真实 TODO：

- native delegate 句柄捕获（平台侧），让 `native` 层真实转发到宿主内置 provider（当前已注册委托引擎，句柄缺位时可诊断失败）。
- 宿主 locale 探测（当前守则/状态节固定中文）。
- fetch 域缓存接线（`cache.ttlFetchMin` 已定义待消费）。
- 垂直频道增量与站选选择器规则的设置面编辑器。
- `selectorPatchable` 运行期回读验证；桥接卫星配对状态的主动心跳回读。
- npm 发布自动化（发布 token 待办）。

## 许可证

[MIT](./LICENSE)
