// 门控的**契约测试**：钉住 `app/src/panel/hostTheme.ts`（Stream 仓库）读的那个 DSH 内部属性名
// （`data-ds-dark-theme`）在**用户自己装的引擎**里还在。那个名字是编译进
// `@deepseek-ai/dsh-client-ui-layout` 的一个未导出常量（`lib/client.js` 里的
// `DARK_ATTRIBUTE`），不是 DSH 承诺的公共契约——升级哪天把它改名，`hostTheme.ts`
// 不会报任何错，面板只会从此永远停在浅色，静默失效。
//
// **单向守卫**：这里只抓"改名"，抓不住"写入方式变了"——比如 DSH 哪天从
// `setAttribute`/`removeAttribute` 换成别的机制却字符串没变，这条测试看不出来。
//
// 引擎归用户（spec 2026-09-05：Stream 不再托管 DSH 引擎）。要跑就用 `DSH_ENGINE_DIR`
// 指向装了引擎的目录（例如 `$DSH_HOME/profiles/stream`），没设就默认 skip：
//
//   DSH_ENGINE_DIR=/path/to/engine-dir node_modules/.bin/vitest run test/theme-attribute.contract.live.test.ts
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// 引擎目录只认 `DSH_ENGINE_DIR`，不猜测、不回落到任何内置路径——这条测试跑在插件包里，
// 与「Stream 仓库某个 dataDir」不再有任何关系。
const engineDir = process.env.DSH_ENGINE_DIR
const CLIENT_JS = engineDir
  ? join(
      engineDir, 'node_modules',
      '@deepseek-ai', 'dsh-client-ui-layout', 'lib', 'client.js',
    )
  : undefined
const gated = !!CLIENT_JS && existsSync(CLIENT_JS)

describe.skipIf(!gated)('DSH 主题属性名契约（活体引擎）', () => {
  it('hostTheme.ts 镜像明暗态读的 data-ds-dark-theme 仍是引擎里那个常量', () => {
    const source = readFileSync(CLIENT_JS as string, 'utf8')
    // 与 Stream 仓库 `app/src/panel/hostTheme.ts` 的 HOST_DARK_ATTRIBUTE 逐字相同
    // （两个包之间没有共享依赖，故意写死字面量而不是跨包 import）。
    expect(
      source.includes('"data-ds-dark-theme"'),
      'Stream 仓库 app/src/panel/hostTheme.ts 的 HOST_DARK_ATTRIBUTE 读的就是这个属性名（面板' +
        '暗色镜像的唯一信号源）。这里没搜到，说明 DSH 升级把 client.js 里的 DARK_ATTRIBUTE 常量' +
        `改名了——去 ${CLIENT_JS} 里搜新名字，同步改 Stream 仓库的 HOST_DARK_ATTRIBUTE，再回来` +
        '更新这条测试断言的字符串。',
    ).toBe(true)
  })
})

if (!gated) {
  // eslint 无此仓库配置；用 console 提示门未开，避免默认 skip 时静默得像"没这测试"。
  console.info(
    '[theme-attribute.contract.live.test] 跳过：未设置 DSH_ENGINE_DIR，或该目录下没有已安装的 ' +
      '@deepseek-ai/dsh-client-ui-layout。要开门跑：DSH_ENGINE_DIR=<装了引擎的目录> ' +
      'node_modules/.bin/vitest run test/theme-attribute.contract.live.test.ts',
  )
}
