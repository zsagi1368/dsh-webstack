# dsh-webstack-monorepo

Monorepo for the **DSH WebStack** plugin family, managed with pnpm workspaces.

本仓库是 DSH WebStack 插件家族的 monorepo，使用 pnpm workspace 管理。

## Structure / 结构

| Package | Path | Status |
| --- | --- | --- |
| `dsh-webstack` (core / 核心) | [`packages/webstack`](./packages/webstack) | active / 活跃 |
| bridge satellite / 网桥卫星 | `packages/bridge` | planned / 规划中 |
| verticals satellite / 垂直卫星 | `packages/verticals` | planned / 规划中 |

- **Core** — integrated web search + fetch kernel plugin for DeepSeek Harness: see [`packages/webstack/README.md`](./packages/webstack/README.md) and the Chinese edition [`packages/webstack/README.zh.md`](./packages/webstack/README.zh.md).
- **核心包** — 面向 DeepSeek Harness 的一体化搜索 + 抓取内核插件：文档见 [`packages/webstack/README.zh.md`](./packages/webstack/README.zh.md) 与英文版 [`packages/webstack/README.md`](./packages/webstack/README.md)。

## Development / 开发

Requires Node.js >= 22.19 and pnpm (see `packageManager`). / 需要 Node.js >= 22.19 与 pnpm（版本见根 `packageManager` 字段）。

```bash
pnpm install          # install all workspace packages / 安装全部工作区依赖
pnpm lint             # biome check across packages / 全工作区 lint
pnpm -r run check     # typecheck + test + build per package / 各包 类型检查+测试+构建
```

Scripts at the repository root delegate into every package under `packages/*` via `pnpm -r --filter './packages/*' run …`; each package keeps its own toolchain (tsdown / vitest / biome).

根目录脚本通过 `pnpm -r --filter './packages/*' run …` 委派到各子包执行；每个子包保留独立的工具链（tsdown / vitest / biome）。

## License

MIT — see [LICENSE](./LICENSE).
