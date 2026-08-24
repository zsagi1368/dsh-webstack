<div align="center">

# dsh-webstack

**Monorepo of the WebStack plugin family for DeepSeek Harness**

[![CI](https://github.com/zsagi1368/dsh-webstack/actions/workflows/ci.yml/badge.svg)](https://github.com/zsagi1368/dsh-webstack/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/zsagi1368/dsh-webstack)](https://github.com/zsagi1368/dsh-webstack/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

English · [简体中文](#中文)

</div>

## Packages

| Package | Path | Description |
| --- | --- | --- |
| [`dsh-webstack`](./packages/webstack) | `packages/webstack` | Core kernel plugin — integrated web search & fetch |
| [`dsh-webstack-bridge`](./packages/bridge) | `packages/bridge` | Satellite — browser-render rescue (MV3 extension + pairing protocol) |
| [`dsh-webstack-verticals`](./packages/verticals) | `packages/verticals` | Satellite — experimental vertical search channels (opt-in) |

Core documentation: [README.md](./packages/webstack/README.md) · [简体中文](./packages/webstack/README.zh.md)

## <a id="中文"></a>中文

本仓库是 **WebStack 插件家族**的 pnpm workspace monorepo：

| 包 | 路径 | 说明 |
| --- | --- | --- |
| `dsh-webstack`（内核） | `packages/webstack` | 一体化网络搜索 + 抓取内核插件 |
| `dsh-webstack-bridge`（桥接卫星） | `packages/bridge` | 浏览器渲染兜底（MV3 扩展 + 配对协议） |
| `dsh-webstack-verticals`（垂类卫星） | `packages/verticals` | 实验性垂类检索渠道（显式开启） |

核心文档：[简体中文](./packages/webstack/README.zh.md) · [English](./packages/webstack/README.md)

## Development / 开发

Requires Node.js ≥ 22.19 and pnpm ≥ 10.

```bash
pnpm install          # install all workspace packages / 安装全部工作区依赖
pnpm lint             # biome check across packages / 全工作区 lint
pnpm -r run check     # typecheck + test + build per package / 各包 类型检查+测试+构建
pnpm --filter dsh-webstack bench   # performance envelopes / 性能基准
```

Root scripts delegate into every package under `packages/*`; each package keeps its own toolchain (tsdown / vitest / biome).

根目录脚本委派到各子包执行；每个子包保留独立工具链（tsdown / vitest / biome）。

## License

MIT — see [LICENSE](./LICENSE).
