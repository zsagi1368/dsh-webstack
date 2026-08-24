# dsh-webstack（WebStack / 网栈）

DeepSeek Harness（DSH）的集成式网页**搜索 + 抓取内核插件**。WebStack 以单一中性聚合器注册进宿主 `ctx.web` seam（search + fetch 双面），把全部路由决策——层级路由（`native` / `free` / `api` / `selfhosted` / `mcp`）、查询复杂度分档、多引擎 fallback、RRF 融合、缓存、凭据解析与 SSRF 四道闸安全管线——收拢在插件内部。捆绑的 cordis patch 为空表：默认共存档，不改写上游选择器，除非用户显式选择接管。

## 特性

- **免费池开箱即搜** —— DuckDuckGo HTML 端点 + Bing RSS「lite」轻通道；`free` 层结构性零凭据（免费档引擎禁止要求密钥）。
- **hints 意图层** —— 纯正则从原始查询确定性提取 `site:` 限域、引号短语、时效词与语言提示；硬约束下推引擎，软偏好仅尽力。
- **复杂度分档路由** —— 按冻结规则分档 `simple` / `medium` / `complex`，分档决定参与引擎数量与是否融合。
- **RRF 融合** —— 多引擎结果按排名倒数加权合并（Σ 1/(k+rank)，k=60）；同 URL 去重保留「首见原样」字符串，身份归一只发生在比较内部。
- **fallback + 引擎冷却** —— 有序候选执行，按错误三分类决策（`retryable` 同候选退避重试一次、`non-retryable` 换下一候选、`terminal` 整场终止）；`rate-limited` / `quota` 触发引擎冷却（尊重服务端 `retryAfterMs`，默认 60 s / 300 s）。
- **缓存指纹 + singleFlight** —— L0 进程内 LRU，键为 `CacheKeyInput` 全维度（层/引擎集/条数/hints/档位/凭据指纹）的 sha256 指纹；并发同键搜索共享同一个在飞 Promise。
- **凭据三级链** —— 遗留字面值 → 宿主 `credentialRef` → 环境变量，每次操作起点解析一次；快照只含布尔态、掩码 hint 与 opaque 哈希 id，明文不出闭包。
- **SSRF 四道闸** —— G1 静态校验 → G2 DNS 解析 IP 分类 → G3 重定向逐跳复验 → G4 有界响应体。豁免（`host:port` / IPv4 CIDR）只能跳过 G2，永不影响 G1/G3/G4。
- **能力降级梯** —— 全部可选接缝（settings / systemPrompt / tools / credentials / storage）先探测后使用；能力缺失降级而非报错。
- **doctor 双语诊断** —— `runDoctor` 产出机器可读报告，`renderDoctor` 渲染中/英文本并按档位给出处方。
- **prompt 守则节与状态节** —— ≤200 词行为守则节 + 动态 ≤80 词状态行注册进 systemPrompt seam。

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

## 配置

全量键集见 `src/settings/schema.ts`（`DEFAULT_SETTINGS`）。「热」= 下一次操作即生效；「重启」= 涉及引擎/进程结构变化，需重载插件。

| 键 | 默认 | 生效 | 说明 |
| --- | --- | --- | --- |
| `enabled` | `true` | 热 | 总开关；关闭 = provider 上报不可用，seam 自动回落 |
| `search.layer` | `free` | 热 | `native` / `free` / `api` / `selfhosted` / `mcp` |
| `search.autoFallback` | `true` | 热 | `false` = 只用首选单引擎 |
| `search.maxResults` | `8` | 热 | 请求级 `maxResults` 存在时优先 |
| `search.fusion.enabled` | `true` | 热 | RRF 融合总开关 |
| `search.fusion.timeDecayHalfLifeH` | `24` | 热 | 预留（尚未消费） |
| `search.fusion.authorityBoost` | `1.0` | 热 | 预留（尚未消费） |
| `search.fusion.diversityDiscount` | `0.85` | 热 | 预留（尚未消费） |
| `search.complexityRouting` | `true` | 热 | 关闭 = 固定按 medium 宽度取池 |
| `fetch.pipeline` | `t1` | 热 | `t1` / `t1+t2` / `t1+t2+t3` |
| `fetch.defaultMode` | `raw` | 热 | 抽取首选模式（回退链可能降级达成） |
| `fetch.maxContentChars` | `12000` | 热 | 渲染预算；canonical 按 ×4 派生封顶 8 MiB |
| `mode.sessionOnline` | `off` | 热 | 会话联网模式词汇 `off/on/ask` |
| `cache.enabled` | `true` | 热 | 搜索结果缓存开关 |
| `cache.ttlSearchMin` | `10` | 热 | search 域 TTL（分钟） |
| `cache.ttlFetchMin` | `60` | 热 | fetch 域 TTL（域接线待接） |
| `cache.persist` | `memory` | 热 | 当前仅 L0 内存；L1 经 `PersistenceAdapter` 接入 |
| `safety.ssrfExempts` | `[]` | 热 | 仅跳 G2 的豁免：`host:port` 或 IPv4 CIDR |
| `engines` | `{}` | **重启** | 引擎级 `enabled` / `apiKey` / `credentialRef` |
| `mcpServers` | `[]` | **重启** | MCP server 名单（引擎接入待接） |
| `verticals.packEnabled` | `false` | 热 | 垂类卫星包（待接） |
| `advanced.hintsLocale` | `auto` | 热 | hints 词表语言 |

安装期组合入口接受上述键的扁平子集：`enabled`、`layer`、`autoFallback`、`maxResults`、`complexityRouting`、`fusionEnabled`、`maxContentChars`、`ssrfExempts`、`searxngBaseUrl`（自托管 SearXNG 根地址；空串 = 不注册该引擎）。

## 诊断

宿主当前未向插件暴露斜杠命令注册 API，因此 WebStack 刻意不硬造 `/webstack doctor`。两个等价入口：

- 让模型调用 **`web_backend_status` 工具**（tools seam 在场时自动注册）：零副作用返回运行档位、各引擎状态（含冷却剩余毫秒与最近错误码）以及缓存命中/未命中/条目数统计；
- 或直接在对话里请求（如「检查 WebStack 后端状态」），走同一条 doctor 路径。

二者均只读本地数据：不发网络探针、不暴露任何凭据。

## 文字版管线图

一次搜索操作的完整路径：

```
query
  → extractHints      # site:/引号短语/时效词/语言 → SearchHints（确定性）
  → estimateBand      # simple | medium | complex
  → planSearch        # 层池 × 分档宽度 × autoFallback → engineIds + 融合标志
  → cache             # CacheKeyInput 全维度 sha256 指纹；命中即原样返回
  → creds             # 三级链每操作解析一次 → 快照 + 凭据指纹
  → fallback          # registry.runWithFallback：冷却剔除 / 重试一次 / 终态中止
  → RRF               # fuseHits 按 URL 身份去重，Σ1/(60+rank)，分数归一化
  → seam              # 截断至 count，映射 NormalizedHit[] → SeamWebSearchResult
```

抓取操作走同一条出站通道：预算派生（canonical = min(maxContentChars×4, 8 MiB)）→ SSRF 四道闸 → 有界读体 → 抽取回退链（raw→fit）→ 「状态即数据」上呈。

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

- native delegate 句柄捕获（接管档），让 `native` 层转发到宿主内置 provider。
- `api`（keyed）/ `mcp` 层引擎接入。
- fusion 三参消费（timeDecayHalfLifeH / authorityBoost / diversityDiscount）。
- fetch 域缓存接线（`cache.ttlFetchMin` 已定义）。
- 宿主 locale 探测（当前守则/状态节固定中文）。
- `selectorPatchable` / `bridgeOnline` 运行期回读验证。
- 浏览器桥接卫星；垂类卫星包。

## 许可证

[MIT](./LICENSE)
