/**
 * `hosts/` 的两条边界的牙（规矩本身写在 `hosts/README.md`）。
 *
 * 1. **后端不许 import `hosts/`。** `hosts/<宿主>/` 是"Stream 在某个对话宿主里露面的产物"：
 *    它跟着宿主的 React / 客户端包版本走、自带一套 npm 依赖、不在 pnpm workspace 里。后端源码
 *    一旦 import 过去，症状不是编译错——`tsc` 会顺着相对路径读到那份 `.tsx`，然后要求根 tsconfig
 *    解出 `@deepseek-ai/dsh-client-*` 与 `react`，而它们只装在 `hosts/dsh/node_modules`。于是
 *    错误落在一个和起因毫无关系的地方（"找不到 react 的类型"），并且**发行包会把整棵宿主插件
 *    树拖进去**。跨仓契约要钉就**读数据文件**（`registry-table.json` / `cordis.patch.yml`，
 *    `dsh-ui-registry-parity.test.ts` 与 `dsh-bundle.contract.test.ts` 就是这么做的）——读文件
 *    不是 import，不建立编译期依赖。
 *
 * 2. **每个 `hosts/<宿主>/` 必须有 `package.json` 且带 `test` 与 `typecheck` 脚本。**
 *    这是 CI 那个 `hosts` job 的前提：它按这两个固定名字调用。新加一个宿主目录却漏了脚本时，
 *    CI 的表现是"这个目录根本没跑过"——**没有任何一处会喊**，正是 AGENTS.md「加了一份名单」
 *    那一节反复记的形状。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { repoRoot } from './http/build-identity.ts'
import { listScannedFiles } from './capability-names.guard.test.ts'

/** 后端侧：这几棵树里的代码是后端自己 bundle 出去的那一份。 */
const BACKEND_ROOTS = ['src/', 'shared/', 'capabilities/', 'cli/']

const CODE_FILE = /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/

/**
 * 只认**模块说明符**里的 `hosts/`，不认注释和字符串里的路径——文档性的提及（"源在
 * `hosts/dsh/src/client/...`"）是好事，禁的是编译期依赖。
 *
 * 两种形态都要罩住：相对路径 `../../hosts/dsh/...`（后端到 `hosts/` 唯一可能的写法，因为
 * 那些包没有 workspace 别名），以及裸的 `hosts/...`（配了 baseUrl 时能解出来）。
 */
const HOSTS_IMPORT =
  /(?:^|[^\w$])(?:import|export)\s[^;]*?from\s*['"]((?:\.\.?\/)*hosts\/[^'"]*)['"]|(?:require|import)\s*\(\s*['"]((?:\.\.?\/)*hosts\/[^'"]*)['"]\s*\)/

/** 本文件自己必须写出被禁的那几种写法（下面那条自证有牙的用例）才守得住它，所以排除自身。 */
const SELF = 'src/hosts-boundary.guard.test.ts'

/** `hosts/` 下的宿主目录清单——问文件系统要，新加一个目录自动被这两条罩住。 */
function hostDirs(): string[] {
  const root = join(repoRoot, 'hosts')
  return readdirSync(root).filter((n) => statSync(join(root, n)).isDirectory())
}

describe('hosts/ 边界', () => {
  const backendFiles = listScannedFiles(repoRoot).filter(
    (rel) => rel !== SELF && BACKEND_ROOTS.some((r) => rel.startsWith(r)) && CODE_FILE.test(rel),
  )

  // 扫到的文件要有量：清单一旦写宽（前缀写错、后缀过滤打偏）会安静地返回一小撮，
  // 下面那条照样全绿——那正是"绿得毫无意义"。
  it('扫到了后端那几棵树', () => {
    expect(backendFiles.length).toBeGreaterThan(300)
  })

  it('后端源码里没有指向 hosts/ 的 import', () => {
    const hits = backendFiles.filter((f) => HOSTS_IMPORT.test(readFileSync(join(repoRoot, f), 'utf8')))
    expect(
      hits,
      '后端不许 import hosts/（那是宿主侧的包，自带 npm 依赖与宿主 React）——要钉契约就读它的数据文件',
    ).toEqual([])
  })

  // 判据本身要能自证有牙：上一条全绿时，"正则写错了"和"仓库真干净"长得一模一样。
  it('判据认得几种 import 写法，且放行注释与文档里的路径提及', () => {
    for (const s of [
      "import { registry } from '../../hosts/dsh/src/registry.ts'",
      'export { x } from "../hosts/dsh/src/index.ts"',
      "const m = require('../../hosts/dsh/lib/index.js')",
      "await import('../../hosts/dsh/src/client/index.tsx')",
      "import type { Row } from 'hosts/dsh/src/registry.ts'",
    ]) {
      expect(HOSTS_IMPORT.test(s), `应命中：${s}`).toBe(true)
    }
    for (const s of [
      '// 源在 `hosts/dsh/src/client/input/stream-ref-source.ts`',
      "const TABLE = join(repoRoot, 'hosts', 'dsh', 'registry-table.json')",
      "readFileSync('hosts/dsh/cordis.patch.yml', 'utf8')",
      "import { probeBackend } from '../../shared/mcp/probe-backend.ts'",
    ]) {
      expect(HOSTS_IMPORT.test(s), `应放行：${s}`).toBe(false)
    }
  })

  it('hosts/ 下至少有一个宿主目录', () => {
    expect(hostDirs()).toContain('dsh')
  })

  it.each(hostDirs())('hosts/%s 有 package.json 且带 test 与 typecheck 脚本', (name) => {
    const pkgPath = join(repoRoot, 'hosts', name, 'package.json')
    expect(existsSync(pkgPath), `${pkgPath} 缺失——CI 的 hosts job 按目录枚举，没有它就跑不起来`).toBe(true)
    const scripts = (JSON.parse(readFileSync(pkgPath, 'utf8')).scripts ?? {}) as Record<string, string>
    for (const s of ['test', 'typecheck']) {
      expect(scripts[s], `hosts/${name} 的 package.json 缺 "${s}" 脚本——CI 按这个固定名字调用`).toBeTruthy()
    }
  })
})
