// @vitest-environment node
// ↑ 同 app/src/boards/panels/panel-boards.build.test.ts:构建在 jsdom 下启动即炸,必须 node。
/**
 * 客户端产物的 require 闸门:
 * DSH 页面装载器给 factory 的那个 `require` 只认宿主自己提供的模块(react / react/jsx-runtime /
 * `@deepseek-ai/*`)。产物里出现任何别的 `require("…")`——比如把 `dependencies` 自动 external 掉的
 * npm 依赖——factory 一执行就抛,整个插件注册失败(响亮但发生在浏览器里,单测看不见)。
 *
 * 对产物断言而不是对源码断言:单测从 node_modules 解析 schemastery 永远是绿的,
 * 只有产物层能看见它被打成了裸 require。同一理由见 panel-boards.build.test.ts 头注。
 */
import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import path from 'node:path'

const execFileAsync = promisify(execFile)
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 宿主 ModuleLoader 的 `require` 能解析的模块。别往里加东西——加之前先确认宿主真有那一份。 */
const HOST_MODULES = [/^react$/, /^react\/jsx-runtime$/, /^@deepseek-ai\//]

describe('客户端产物', () => {
  it('只 require 宿主提供的模块,不留裸 require', async () => {
    await execFileAsync(process.execPath, [path.join(pluginRoot, 'node_modules/tsdown/dist/run.js')], {
      cwd: pluginRoot,
      timeout: 280_000,
    })
    const js = await readFile(path.join(pluginRoot, 'lib/client.js'), 'utf8')
    const required = [...js.matchAll(/require\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1] ?? '')
    expect(required.length, '产物里一个 require 都没有——信封形状变了,这条闸门就失效了').toBeGreaterThan(0)
    const foreign = [...new Set(required)].filter((id) => !HOST_MODULES.some((re) => re.test(id)))
    expect(foreign, `产物里有宿主解析不了的 require:${foreign.join(', ')}——factory 一执行就抛`).toEqual([])
  }, 300_000)
})
