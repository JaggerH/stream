/**
 * 进程入口的配置读取：**环境变量 → `AppConfig`** 的唯一翻译点。
 *
 * 库入口（`src/engine/`）不读 `process.env`，所以「读环境」这一步不能住在 `bootstrap.ts` 里（它在库入口可达范围内）。
 * `serve.ts`、`stream mcp`、doctor、`stream plugins` 这几个进程入口调这里；库的调用方自己给 config，或交给
 * `createStream` 读数据目录下的 config.yaml（那一档没有环境回落）。
 */
import type { AppConfig } from './types.ts'
import { readConfig, resolveConfigPath } from './bootstrap.ts'

export function loadConfig(path = resolveConfigPath(process.env)): AppConfig {
  return readConfig(path, process.env)
}
