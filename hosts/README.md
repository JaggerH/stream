# `hosts/` — Stream 在某个对话宿主里露面的产物

**放什么**：一个对话宿主（DSH、将来的 Claude Code / Codex / Claude Desktop）里"Stream 长什么样"
的那份东西——宿主插件、宿主 bundle、宿主侧的渲染与输入扩展。一个宿主一个子目录，今天只有
`dsh/`（npm `@streamapp/dsh-plugin-stream-ui`，目录名不等于包名，用户装法与包名都不随目录变）。

**不放什么**：`capabilities/` 才是"Stream 能做什么"（能力包填 Stream 包的能力槽位、由后端装载）；
`packages/` 是 Stream 包（Source 清单 / recipe / 容器）。两者与 `hosts/` 并排，不互相搬。

**规矩**：

- **`hosts/*` 只被宿主消费，后端不许 import。** 后端源码（`src/**`、`shared/**`、
  `capabilities/**`、`cli/**`）里出现指向 `hosts/` 的 import/require 就是错的，由
  `src/hosts-boundary.guard.test.ts` 钉着。反向可以：后端的测试**读**这里的数据文件
  （`hosts/dsh/registry-table.json`、`cordis.patch.yml`）来钉跨仓契约，那是读文件不是 import。
- **每个子目录自带包管理**，不并进 pnpm workspace——DSH 这份依赖 `@deepseek-ai/dsh-client-*`
  那几个宿主私有的客户端包，走 npm 与自己的 `package-lock.json`。根 `vitest.config.ts` 因此
  排除整个 `hosts/**`。
- **每个子目录必须有 `package.json` 且带 `test` 与 `typecheck` 两个脚本**——CI 的 `hosts` job
  按这两个名字调用它们。同样由 `src/hosts-boundary.guard.test.ts` 钉着。
- **worktree 里没有它们的 `node_modules`**（根/`app`/`extension` 那三条软链不覆盖这儿）。要跑
  它的测试就把主检出那份链过来，跑完 `rm` 掉再提交：
  `ln -s <stream-checkout>/hosts/dsh/node_modules <worktree>/hosts/dsh/node_modules`。
