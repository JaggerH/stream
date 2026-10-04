import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, existsSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apiPackageOps, localPackageOps, runAddCommand, runRemoveCommand, runUpdateCommand, runRestartCommand, builtinDirNear, readBaseline } from './add-command.ts'
import { dirNameFor } from '../replay/recipe-install.ts'
import { RECIPE_PACKAGE_SCHEMA_VERSION } from '../replay/recipe-package.ts'
import type { PendingChange } from '../packages/pending.ts'

/** 没有待重启项、也没人会去打 restart——只关心装 / 卸本身的用例用这份缺省。 */
const noPending = {
  pending: async (): Promise<PendingChange[]> => [],
  restart: async () => ({ status: 202, body: { mode: 'foreground' } }),
}

function harness(over: Record<string, unknown> = {}) {
  const lines: string[] = []
  return {
    lines,
    deps: {
      log: (l: string) => void lines.push(l),
      env: {} as NodeJS.ProcessEnv,
      dataDir: '/nonexistent',
      ...over,
      ...(over.ops ? { ops: { ...noPending, ...(over.ops as object) } } : {}),
    },
  }
}

/** 后端在场那一档：走 `/api/recipes/packages/*`，`confirm` 必须是 **preview 刚发的那一个**
 *  （防"preview 之后包变了"的 TOCTOU）——写死一个常量或者省掉它，闸门就白设了。 */
describe('后端在场 → 走 API', () => {
  it('preview → install，confirm 取自 preview', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    const fetchImpl = vi.fn(async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) })
      if (url.endsWith('/preview')) {
        return { ok: true, json: async () => ({ name: '@x/y', version: '1.0.0', confirm: 'sha512-abc', recipes: [] }) }
      }
      return { ok: true, json: async () => ({ dir: '/d/recipes/@x__y', version: '1.0.0' }) }
    })
    const ops = apiPackageOps('http://127.0.0.1:8900', fetchImpl as never)
    const p = await ops.preview('@x/y')
    await ops.install('@x/y', undefined, p.confirm)
    expect(calls.map((c) => c.url)).toEqual([
      'http://127.0.0.1:8900/api/recipes/packages/preview',
      'http://127.0.0.1:8900/api/recipes/packages/install',
    ])
    expect(calls[1].body).toEqual({ name: '@x/y', confirm: 'sha512-abc' })
  })

  it('版本给了就带上', async () => {
    const calls: unknown[] = []
    const fetchImpl = vi.fn(async (_url: string, init: { body: string }) => {
      calls.push(JSON.parse(init.body))
      return { ok: true, json: async () => ({ confirm: 'c', name: '@x/y', version: '2.0.0', recipes: [] }) }
    })
    await apiPackageOps('http://b', fetchImpl as never).preview('@x/y', '2.0.0')
    expect(calls[0]).toEqual({ name: '@x/y', version: '2.0.0' })
  })

  /** 后端的错要**原样说出来**：`validation_error` 的 message 就是用户要看的那句
   *  （撞名、白名单拒了某个文件、hostVersion 不匹配…）。吞掉它只剩一个 400。 */
  it('后端拒了 → 把它给的理由说出来', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: { code: 'validation_error', message: 'adapter name taken' } }),
    }))
    await expect(apiPackageOps('http://b', fetchImpl as never).preview('@x/y')).rejects.toThrow(/adapter name taken/)
  })

  it('uninstall 打 uninstall 路由', async () => {
    const urls: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url)
      return { ok: true, json: async () => ({ removed: true }) }
    })
    expect(await apiPackageOps('http://b', fetchImpl as never).uninstall('@x/y')).toBe(true)
    expect(urls).toEqual(['http://b/api/recipes/packages/uninstall'])
  })

  it('uninstall 404（没装过）→ false，不当成失败', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false, status: 404, json: async () => ({ error: { code: 'not_found', message: 'x is not installed' } }),
    }))
    expect(await apiPackageOps('http://b', fetchImpl as never).uninstall('@x/y')).toBe(false)
  })

  /** 响应体不是数组时别让它悄悄流进后面的 `.filter`/`.some`——那会在很远的地方炸出一句语焉不详
   *  的 TypeError。在这儿就说清楚"后端回的不是我们认识的形状"。 */
  it('updates() 响应体不是数组 → 抛清楚的错，不让它流进 .filter', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ oops: true }) }))
    await expect(apiPackageOps('http://b', fetchImpl as never).updates()).rejects.toThrow(/不是清单/)
  })
})

/**
 * 后端不在场那一档：**直接调后端里同一份函数**（纯函数 + fs），不是另写一套安装逻辑。
 * 两套的代价是白名单/撞名闸门必然漂，而漂了没有一处会喊。
 */
describe('后端不在场 → 直接调同一份函数', () => {
  it('userDir 是 <dataDir>/recipes；卸载一个真的目录', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'stream-add-'))
    try {
      const dir = join(dataDir, 'recipes', '@x__y')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@x/y', version: '1.0.0' }))
      const ops = localPackageOps({ dataDir })
      expect(await ops.uninstall('@x/y')).toBe(true)
      expect(existsSync(dir)).toBe(false)
      // 没装过的返回 false，不抛。
      expect(await ops.uninstall('@x/y')).toBe(false)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})

/**
 * Unix 全局安装下 `<prefix>/bin/stream` 是 npm 建的软链，指向真正的 `bin/stream.mjs`，而
 * `resources/` 住在**软链指向的那个目录**旁边。node 不会替 `process.argv[1]` realpath，
 * 不先解析就永远拼错，撞名闸门从此只剩第三方那一层，而且不报错。
 */
describe('builtinDirNear', () => {
  it('软链入口也能找到 —— 先 realpath 再取 dirname', () => {
    const root = mkdtempSync(join(tmpdir(), 'stream-builtin-'))
    try {
      const realBinDir = join(root, 'lib', 'node_modules', '@streamapp', 'stream', 'bin')
      const realEntry = join(realBinDir, 'stream.mjs')
      mkdirSync(realBinDir, { recursive: true })
      writeFileSync(realEntry, '// noop')
      const packagesDir = join(root, 'lib', 'node_modules', '@streamapp', 'stream', 'resources', 'packages')
      mkdirSync(packagesDir, { recursive: true })

      const linkDir = join(root, 'bin')
      mkdirSync(linkDir, { recursive: true })
      const link = join(linkDir, 'stream')
      symlinkSync(realEntry, link)

      expect(builtinDirNear(link)).toBe(realpathSync(packagesDir))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('不存在的路径 → undefined，不抛', () => {
    expect(builtinDirNear('/nonexistent/stream.mjs')).toBeUndefined()
  })

  it('undefined 入口 → undefined', () => {
    expect(builtinDirNear(undefined)).toBeUndefined()
  })
})

describe('stream add / remove 的收尾', () => {
  it('装成功 → 退出码 0，说清装到哪、什么时候生效；confirm 用的是本次 preview 发的那一个', async () => {
    const install = vi.fn(async () => ({ dir: '/d/recipes/@x__y', version: '1.0.0' }))
    const h = harness({
      ops: {
        preview: async () => ({ name: '@x/y', version: '1.0.0', confirm: 'sha512-thistime', recipes: [] }),
        install,
        uninstall: async () => true,
      },
      where: 'backend' as const,
    })
    expect(await runAddCommand({ name: '@x/y', version: '1.0.0' }, h.deps as never)).toBe(0)
    // preview → install 的 confirm 必须一路带过去：它是 tarball 的 integrity，挡的是
    // "preview 之后包变了"。写死一个常量、或者省掉它，闸门就白设了。
    expect(install).toHaveBeenCalledWith('@x/y', '1.0.0', 'sha512-thistime')
    const out = h.lines.join('\n')
    expect(out).toContain('/d/recipes/@x__y')
    expect(out).toMatch(/生效/)
  })

  it('装失败 → 退出码 1，理由打出来（不静默）', async () => {
    const h = harness({
      ops: {
        preview: async () => { throw new Error('registry 404 for @x/y') },
        install: async () => ({ dir: '', version: '' }),
        uninstall: async () => true,
      },
      where: 'backend' as const,
    })
    expect(await runAddCommand({ name: '@x/y' }, h.deps as never)).toBe(1)
    expect(h.lines.join('\n')).toContain('registry 404')
  })

  it('卸载一个没装过的包 → 退出码 1 并说清它本来就不在', async () => {
    const h = harness({
      ops: { preview: async () => ({}), install: async () => ({}), uninstall: async () => false },
      where: 'backend' as const,
    })
    expect(await runRemoveCommand({ name: '@x/y' }, h.deps as never)).toBe(1)
    expect(h.lines.join('\n')).toMatch(/没装|not installed/)
  })

  /** 后端不在场时装的包，**没有任何东西会去热装它**——这句必须说出来，不许静默不生效。 */
  it('本地档装完要说"下次起后端才生效"', async () => {
    const h = harness({
      ops: {
        preview: async () => ({ name: '@x/y', version: '1.0.0', confirm: 'c', recipes: [] }),
        install: async () => ({ dir: '/d/recipes/@x__y', version: '1.0.0' }),
        uninstall: async () => true,
      },
      where: 'local' as const,
    })
    await runAddCommand({ name: '@x/y' }, h.deps as never)
    expect(h.lines.join('\n')).toMatch(/下次|重启|起来/)
  })

  /**
   * 装的回执说「要等后端重载」，卸的回执必须对称。目录删了、进程里那份还活着：工具还在
   * `tools/list` 上，凭证域申报还在扩展的同步名单里，而没有任何一处会喊。回执是唯一的告知点。
   * 文案与 `docs/PACKAGE.md` §5.9.5 同源——改一句就得改另一处。
   */
  it('后端在场卸载 → 说清"重启后端后才真正卸掉"，并点名工具与凭证域', async () => {
    const h = harness({
      ops: { preview: async () => ({}), install: async () => ({}), uninstall: async () => true },
      where: 'backend' as const,
    })
    expect(await runRemoveCommand({ name: '@x/y' }, h.deps as never)).toBe(0)
    const out = h.lines.join('\n')
    expect(out).toContain('重启后端后才真正卸掉')
    expect(out).toContain('已装载的工具与凭证域申报在重启前仍在')
  })

  /** `remove` 不查撞名，「找不到内置包目录」这句告警只属于 `add` 那一档——照样打出来会让用户
   *  以为卸载哪里不对劲。 */
  it('remove 走本地档、找不到内置包目录时不打那句撞名告警', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'stream-remove-'))
    try {
      const lines: string[] = []
      const r = await runRemoveCommand({ name: '@x/y' }, {
        log: (l: string) => void lines.push(l),
        env: {} as NodeJS.ProcessEnv,
        dataDir,
        selfEntry: '/nonexistent/stream.mjs',
        probe: async () => false,
      } as never)
      expect(r).toBe(1) // 没装过
      expect(lines.join('\n')).not.toMatch(/找不到内置包目录/)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})

describe('runUpdateCommand', () => {
  const candidate = { name: '@streamapp/wechat', builtin: '1.0.1', latest: '1.0.2' }
  const preview = (effects: string[], extra: Record<string, unknown> = {}) => ({
    name: '@streamapp/wechat', version: '1.0.2', confirm: 'sha512-x', facility: 'wechat',
    recipes: [{ id: 'wechat-send', description: '', capabilities: [], effects, params: [] }],
    ...extra,
  })
  /** 注入的基线：当前版申报的 effects + 有没有代码格（缺省没有——内置 recipe 包都是纯数据包）。 */
  const bl = (effects: string[], code = false) => () => ({ effects: new Set(effects), code })
  function fakeOps(effects: string[], calls: string[], previewExtra: Record<string, unknown> = {}) {
    return {
      ...noPending,
      updates: async () => [candidate],
      preview: async () => preview(effects, previewExtra) as never,
      install: async (name: string, version: string | undefined, confirm: string) => { calls.push(`install ${name}@${version} ${confirm}`); return { dir: '/x', version: '1.0.2' } },
      uninstall: async () => true,
    }
  }
  it('官方包、effects 没新增 → 直接装', async () => {
    const calls: string[] = []
    const code = await runUpdateCommand({ kind: 'update', names: [], yes: false }, {
      ops: fakeOps(['send'], calls), baseline: bl(['send']), log: () => {},
    })
    expect(code).toBe(0)
    expect(calls).toEqual(['install @streamapp/wechat@1.0.2 sha512-x'])
  })
  it('effects 变大且没 --yes → 不装、退出码 2、打印 preview', async () => {
    const calls: string[] = []
    const lines: string[] = []
    const code = await runUpdateCommand({ kind: 'update', names: [], yes: false }, {
      ops: fakeOps(['send', 'purchase'], calls), baseline: bl(['send']), log: (l) => lines.push(l),
    })
    expect(code).toBe(2)
    expect(calls).toEqual([])
    expect(lines.join('\n')).toMatch(/purchase/)
    expect(lines.join('\n')).toMatch(/--yes/)
  })
  it('第三方包没 --yes → 同样拦下', async () => {
    const calls: string[] = []
    const lines: string[] = []
    const ops = { ...fakeOps(['send'], calls), updates: async () => [{ name: '@x/y', installed: '1.0.0', latest: '1.1.0' }] }
    const code = await runUpdateCommand({ kind: 'update', names: [], yes: false }, {
      ops, baseline: bl(['send']), log: (l) => lines.push(l),
    })
    expect(code).toBe(2)
    expect(calls).toEqual([])
    expect(lines.join('\n')).toMatch(/第三方/)
  })
  it('官方 scope 但 preview 说镜像核不上官方源 → 按第三方拦，理由念原因', async () => {
    const calls: string[] = []
    const lines: string[] = []
    const code = await runUpdateCommand({ kind: 'update', names: [], yes: false }, {
      ops: fakeOps(['send'], calls, { mirrorUnverified: '镜像上的 @streamapp/wechat@1.0.2 与官方源校验和不一致' }),
      baseline: bl(['send']), log: (l) => lines.push(l),
    })
    expect(code).toBe(2)
    expect(calls).toEqual([])
    expect(lines.join('\n')).toMatch(/校验和不一致/)
  })
  it('--yes 放行', async () => {
    const calls: string[] = []
    const code = await runUpdateCommand({ kind: 'update', names: [], yes: true }, {
      ops: fakeOps(['send', 'purchase'], calls), baseline: bl(['send']), log: () => {},
    })
    expect(code).toBe(0)
    expect(calls).toHaveLength(1)
  })

  /**
   * 代码格是权限阶梯里最响的一档（`RecipePackagePreview.code` / `.capability` 头注：进程内、完整
   * 权限、能取登录态）。一个官方纯数据包的新版本带上 `dist/index.js`，effects 可以一条都不变
   * ——只看 effects 的闸门对它是盲的，官方 scope 就一路静默装上。
   */
  it('官方包、effects 没变、但新版带了代码格 → 拦下，说清"新版带代码"', async () => {
    const calls: string[] = []
    const lines: string[] = []
    const code = await runUpdateCommand({ kind: 'update', names: [], yes: false }, {
      ops: fakeOps(['send'], calls, { code: { entry: 'dist/index.js', adapters: ['wx'], normalizers: [] } }),
      baseline: bl(['send']), log: (l) => lines.push(l),
    })
    expect(code).toBe(2)
    expect(calls).toEqual([])
    expect(lines.join('\n')).toMatch(/新版带代码（dist\/index\.js/)
    expect(lines.join('\n')).not.toMatch(/新增副作用/)
  })
  it('官方包、effects 没变、但新版带了能力格 → 同样拦下（两格是同一种权限）', async () => {
    const calls: string[] = []
    const lines: string[] = []
    const code = await runUpdateCommand({ kind: 'update', names: [], yes: false }, {
      ops: fakeOps(['send'], calls, { capability: { entry: 'dist/index.js' } }),
      baseline: bl(['send']), log: (l) => lines.push(l),
    })
    expect(code).toBe(2)
    expect(calls).toEqual([])
    expect(lines.join('\n')).toMatch(/新版带代码/)
  })
  it('新版带代码格 + --yes → 放行', async () => {
    const calls: string[] = []
    const code = await runUpdateCommand({ kind: 'update', names: [], yes: true }, {
      ops: fakeOps(['send'], calls, { code: { entry: 'dist/index.js', adapters: [], normalizers: [] } }),
      baseline: bl(['send']), log: () => {},
    })
    expect(code).toBe(0)
    expect(calls).toHaveLength(1)
  })
  it('当前版本来就带代码格、新版也带 → 不算升档，官方包直接装', async () => {
    const calls: string[] = []
    const code = await runUpdateCommand({ kind: 'update', names: [], yes: false }, {
      ops: fakeOps(['send'], calls, { code: { entry: 'dist/index.js', adapters: [], normalizers: [] } }),
      baseline: bl(['send'], true), log: () => {},
    })
    expect(code).toBe(0)
    expect(calls).toHaveLength(1)
  })

  it('带包名只更那几个', async () => {
    const calls: string[] = []
    await runUpdateCommand({ kind: 'update', names: ['@streamapp/qq'], yes: false }, {
      ops: fakeOps(['send'], calls), baseline: bl(['send']), log: () => {},
    })
    expect(calls).toEqual([])
  })
  it('没有更新 → 退出码 0、说一句', async () => {
    const lines: string[] = []
    const code = await runUpdateCommand({ kind: 'update', names: [], yes: false }, {
      ops: { ...fakeOps([], []), updates: async () => [] }, baseline: bl([]), log: (l) => lines.push(l),
    })
    expect(code).toBe(0)
    expect(lines.join('\n')).toMatch(/都是最新/)
  })

  /**
   * `ops.updates()` 的候选来自后端的内置层（后端在场时它看得到自己的 `resources/packages`），
   * 而 baseline 缺省是在 **CLI 进程**里读的（`builtinDirNear(process.argv[1])`）。CLI 进程找不到
   * 内置包目录时（源码树里 tsx 跑、或换了个 `--data`），一个只在内置层报到的候选会被读成
   * "基线是空集"——申报的每条 effect 都被念成"新增"，这是编出来的理由，不是真的多了副作用。
   * fail-closed：一样拦，但说实话；不用注入 `baseline` 就能测到，因为这条就是在测
   * **缺省**那条路径。
   */
  it('内置候选、CLI 读不到内置包目录 → 说"基线读不到"而不是"新增副作用"，仍然拦下', async () => {
    const calls: string[] = []
    const lines: string[] = []
    const code = await runUpdateCommand({ kind: 'update', names: [], yes: false }, {
      ops: fakeOps(['send'], calls), // 只在内置层报到：candidate.builtin 有值、installed 没有
      builtinDirAvailable: false,
      dataDir: '/nonexistent',
      selfEntry: '/nonexistent/stream.mjs',
      log: (l) => lines.push(l),
    })
    expect(code).toBe(2)
    expect(calls).toEqual([])
    const out = lines.join('\n')
    expect(out).toMatch(/基线读不到（找不到内置包目录）/)
    expect(out).not.toMatch(/新增副作用/)
  })

  it('同一种情形但 --yes → 照样放行（fail-closed 只挡没点头的）', async () => {
    const calls: string[] = []
    const code = await runUpdateCommand({ kind: 'update', names: [], yes: true }, {
      ops: fakeOps(['send'], calls),
      builtinDirAvailable: false,
      dataDir: '/nonexistent',
      selfEntry: '/nonexistent/stream.mjs',
      log: () => {},
    })
    expect(code).toBe(0)
    expect(calls).toHaveLength(1)
  })

  /** 请求了一个从没被 `ops.updates()` 报过的名字：区分"确实认识、只是已是最新"和"压根没装过、
   *  也不是内置包，从来没被查过"——混着说会让人以为自己拼错的包名其实装着。 */
  it('请求了一个既不在内置层也没装过的名字 → 说"没装过"而不是"已是最新"，且不再追一句"都是最新的"', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'stream-update-unknown-'))
    try {
      const calls: string[] = []
      const lines: string[] = []
      const code = await runUpdateCommand({ kind: 'update', names: ['@nobody/ghost'], yes: false }, {
        ops: fakeOps(['send'], calls),
        baseline: bl(['send']),
        dataDir,
        selfEntry: '/nonexistent/stream.mjs',
        log: (l) => lines.push(l),
      })
      expect(code).toBe(0) // wanted 过滤后候选为空
      expect(lines.join('\n')).toMatch(/@nobody\/ghost：没装过（也不是内置包）/)
      // 点了名的，逐个回答完就结束——总括那句会和「没装过」并排，读起来像"最新的"。
      expect(lines.join('\n')).not.toMatch(/都是最新的/)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('请求了一个确实装着、只是已经最新的名字 → 说"已是最新"', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'stream-update-latest-'))
    try {
      const dir = join(dataDir, 'recipes', dirNameFor('@streamapp/qq'))
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@streamapp/qq', version: '1.0.0' }))
      const calls: string[] = []
      const lines: string[] = []
      await runUpdateCommand({ kind: 'update', names: ['@streamapp/qq'], yes: false }, {
        ops: fakeOps(['send'], calls),
        baseline: bl(['send']),
        dataDir,
        selfEntry: '/nonexistent/stream.mjs',
        log: (l) => lines.push(l),
      })
      expect(lines.join('\n')).toMatch(/@streamapp\/qq：已是最新。/)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  /**
   * 内置包住 `packages/wechat/`——目录名是包 id，不是 `dirNameFor('@streamapp/wechat')`。
   * 按目录名去内置层找永远找不到，于是 `stream update @streamapp/wechat` 在已是最新时会被说成
   * 「没装过（也不是内置包）」。内置层的"认识它吗"必须按 npm 名判。夹具照发行形态摆：
   * `<bin>/../resources/packages/wechat/package.json`。
   */
  it('内置包（目录名 = 包 id）已是最新 → 说"已是最新"，不是"没装过"', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stream-update-builtin-'))
    try {
      const builtinDir = join(root, 'resources', 'packages')
      const wechat = join(builtinDir, 'wechat')
      mkdirSync(wechat, { recursive: true })
      mkdirSync(join(root, 'bin'), { recursive: true })
      writeFileSync(join(root, 'bin', 'stream.mjs'), '')
      writeFileSync(join(wechat, 'package.json'), JSON.stringify({
        name: '@streamapp/wechat', version: '1.0.2',
        stream: { type: 'recipe', facility: 'wechat', schemaVersion: RECIPE_PACKAGE_SCHEMA_VERSION },
      }))
      writeFileSync(join(wechat, 'wechat-send.recipe.json'), JSON.stringify({
        version: 1, kind: 'http', sourceId: 'wechat-send', output: 'object',
        request: { url: 'https://x.com/api/send', method: 'GET' }, assert: [],
        meta: { effects: ['send'] },
      }))
      const lines: string[] = []
      const code = await runUpdateCommand({ kind: 'update', names: ['@streamapp/wechat'], yes: false }, {
        ops: { ...fakeOps(['send'], []), updates: async () => [] }, // npm 上没有更新
        baseline: bl(['send']),
        dataDir: join(root, 'data'),
        selfEntry: join(root, 'bin', 'stream.mjs'),
        log: (l) => lines.push(l),
      })
      expect(code).toBe(0)
      expect(lines.join('\n')).toMatch(/@streamapp\/wechat：已是最新。/)
      expect(lines.join('\n')).not.toMatch(/没装过/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  /**
   * 装完的回执只说「要重启」还不够——用户得自己再敲一条命令。后端在场时列出待重启项
   * （`GET /api/packages/pending`，判据在后端算，这里不复刻）、问一句、答 y 就替他打 `POST /api/restart`。
   * 409（有任务在跑）**不强制**：8900 上跑着真金白银的任务，装个包不是打断它的理由。
   */
  describe('装完问重启', () => {
    const pendingRestart: PendingChange[] = [
      { name: '@streamapp/mineru', kind: 'updated', from: '1.0.0', to: '1.0.1', needsRestart: true, why: '容器要重启后按 x:1.0.1 重建' },
    ]
    it('后端在场、有待重启项、用户答 y → 打 restart；202 就说「重启中」', async () => {
      const calls: string[] = []
      const ops = {
        ...fakeOps(['send'], calls),
        pending: async () => pendingRestart,
        restart: async (force: boolean) => { calls.push(`restart force=${force}`); return { status: 202, body: { mode: 'supervised' } } },
      }
      const lines: string[] = []
      const code = await runUpdateCommand({ kind: 'update', names: [], yes: true }, {
        ops, where: 'backend', baseline: bl(['send']), log: (l) => lines.push(l), ask: async () => true,
      })
      expect(code).toBe(0)
      expect(lines.join('\n')).toContain('@streamapp/mineru：容器要重启后按 x:1.0.1 重建')
      expect(calls.at(-1)).toBe('restart force=false')
      expect(lines.at(-1)).toMatch(/重启中/)
      expect(lines.at(-1)).toMatch(/supervised/)
    })
    it('409 → 列出正在跑的任务，不强制，提示 stream restart --force', async () => {
      const restarts: boolean[] = []
      const ops = {
        ...fakeOps(['send'], []),
        pending: async () => pendingRestart,
        restart: async (force: boolean) => { restarts.push(force); return { status: 409, body: { running: [{ id: 'x', label: '东财登录' }] } } },
      }
      const lines: string[] = []
      const code = await runUpdateCommand({ kind: 'update', names: [], yes: true }, {
        ops, where: 'backend', baseline: bl(['send']), log: (l) => lines.push(l), ask: async () => true,
      })
      expect(code).toBe(0) // 更新本身成功了；没重启成是另一件事，回执里说
      expect(restarts).toEqual([false])
      expect(lines.join('\n')).toMatch(/东财登录/)
      expect(lines.join('\n')).toMatch(/stream restart --force/)
    })
    it('用户答 n → 不打 restart，说一句稍后 stream restart', async () => {
      const restart = vi.fn(async () => ({ status: 202, body: { mode: 'supervised' } }))
      const ops = { ...fakeOps(['send'], []), pending: async () => pendingRestart, restart }
      const lines: string[] = []
      await runUpdateCommand({ kind: 'update', names: [], yes: true }, {
        ops, where: 'backend', baseline: bl(['send']), log: (l) => lines.push(l), ask: async () => false,
      })
      expect(restart).not.toHaveBeenCalled()
      expect(lines.join('\n')).toMatch(/稍后 stream restart/)
    })
    it('--no-restart 不问', async () => {
      const ask = vi.fn(async () => true)
      const restart = vi.fn(async () => ({ status: 202, body: { mode: 'supervised' } }))
      const ops = { ...fakeOps(['send'], []), pending: async () => pendingRestart, restart }
      const lines: string[] = []
      await runUpdateCommand({ kind: 'update', names: [], yes: true }, {
        ops, where: 'backend', baseline: bl(['send']), log: (l) => lines.push(l), ask, restartFlag: 'no',
      })
      expect(ask).not.toHaveBeenCalled()
      expect(restart).not.toHaveBeenCalled()
      // 待重启项还是要列出来：跳过的是"问"，不是"告知"
      expect(lines.join('\n')).toContain('@streamapp/mineru')
    })
    it('--restart 不问直接重启', async () => {
      const ask = vi.fn(async () => false)
      const restart = vi.fn(async () => ({ status: 202, body: { mode: 'supervised' } }))
      const ops = { ...fakeOps(['send'], []), pending: async () => pendingRestart, restart }
      await runUpdateCommand({ kind: 'update', names: [], yes: true }, {
        ops, where: 'backend', baseline: bl(['send']), log: () => {}, ask, restartFlag: 'yes',
      })
      expect(ask).not.toHaveBeenCalled()
      expect(restart).toHaveBeenCalledWith(false)
    })
    it('没有待重启项 → 不问也不重启', async () => {
      const ask = vi.fn(async () => true)
      const restart = vi.fn(async () => ({ status: 202, body: { mode: 'supervised' } }))
      const ops = {
        ...fakeOps(['send'], []),
        // 有变更但都热生效了——needsRestart:false 的不算
        pending: async (): Promise<PendingChange[]> => [{ name: '@streamapp/wechat', kind: 'updated', needsRestart: false, why: 'recipe 数据已热生效' }],
        restart,
      }
      await runUpdateCommand({ kind: 'update', names: [], yes: true }, {
        ops, where: 'backend', baseline: bl(['send']), log: () => {}, ask,
      })
      expect(ask).not.toHaveBeenCalled()
      expect(restart).not.toHaveBeenCalled()
    })
    it('后端不在场（local）→ 照旧一句「下次 stream 起来时生效」，不问', async () => {
      const ask = vi.fn(async () => true)
      const ops = { ...fakeOps(['send'], []), pending: async () => pendingRestart }
      const lines: string[] = []
      await runUpdateCommand({ kind: 'update', names: [], yes: true }, {
        ops, where: 'local', baseline: bl(['send']), log: (l) => lines.push(l), ask,
      })
      expect(ask).not.toHaveBeenCalled()
      expect(lines.join('\n')).toMatch(/下次 `stream` 起来时生效/)
    })
    it('没装任何东西（全被拦下）→ 不问', async () => {
      const ask = vi.fn(async () => true)
      const ops = { ...fakeOps(['send', 'purchase'], []), pending: async () => pendingRestart }
      await runUpdateCommand({ kind: 'update', names: [], yes: false }, {
        ops, where: 'backend', baseline: bl(['send']), log: () => {}, ask,
      })
      expect(ask).not.toHaveBeenCalled()
    })
    /** 装已经成功了，问重启这一步炸了（503 没开包目录 / 网络断了）不许把它报成「装失败」。 */
    it('pending() 抛错 → 退出码仍 0，说一句「重启询问失败（包已装好）」', async () => {
      const calls: string[] = []
      const ops = { ...fakeOps(['send'], calls), pending: async (): Promise<PendingChange[]> => { throw new Error('boom') } }
      const lines: string[] = []
      const code = await runUpdateCommand({ kind: 'update', names: [], yes: true }, {
        ops, where: 'backend', baseline: bl(['send']), log: (l) => lines.push(l), ask: async () => true,
      })
      expect(code).toBe(0)
      expect(calls).toHaveLength(1)
      expect(lines.join('\n')).toMatch(/重启询问失败：boom（包已装好，稍后 stream restart）/)
      expect(lines.join('\n')).not.toMatch(/更新失败/)
    })
    it('add 与 remove 也问（后端在场）', async () => {
      const restart = vi.fn(async () => ({ status: 202, body: { mode: 'supervised' } }))
      const ops = {
        preview: async () => ({ name: '@x/y', version: '1.0.0', confirm: 'c', recipes: [] }),
        install: async () => ({ dir: '/d/recipes/@x__y', version: '1.0.0' }),
        uninstall: async () => true,
        pending: async () => pendingRestart,
        restart,
      }
      const h1 = harness({ ops, where: 'backend' as const, ask: async () => true })
      expect(await runAddCommand({ name: '@x/y' }, h1.deps as never)).toBe(0)
      expect(restart).toHaveBeenCalledTimes(1)
      expect(h1.lines.join('\n')).toContain('@streamapp/mineru')
      const h2 = harness({ ops, where: 'backend' as const, ask: async () => true })
      expect(await runRemoveCommand({ name: '@x/y' }, h2.deps as never)).toBe(0)
      expect(restart).toHaveBeenCalledTimes(2)
    })
  })
})

describe('runRestartCommand', () => {
  const base = { preview: async () => ({}), install: async () => ({}), uninstall: async () => true, updates: async () => [] }
  it('202 → 0 并打 mode', async () => {
    const restart = vi.fn(async () => ({ status: 202, body: { mode: 'foreground' } }))
    const lines: string[] = []
    const code = await runRestartCommand({ force: false }, {
      ops: { ...base, pending: async () => [], restart } as never, where: 'backend', log: (l) => lines.push(l),
    })
    expect(code).toBe(0)
    expect(restart).toHaveBeenCalledWith(false)
    expect(lines.join('\n')).toMatch(/重启中（foreground）/)
  })
  it('--force 透传', async () => {
    const restart = vi.fn(async () => ({ status: 202, body: { mode: 'supervised' } }))
    await runRestartCommand({ force: true }, {
      ops: { ...base, pending: async () => [], restart } as never, where: 'backend', log: () => {},
    })
    expect(restart).toHaveBeenCalledWith(true)
  })
  it('409 → 2 列任务', async () => {
    const lines: string[] = []
    const code = await runRestartCommand({ force: false }, {
      ops: { ...base, pending: async () => [], restart: async () => ({ status: 409, body: { running: [{ id: 'a', label: '东财登录' }, { id: 'b', label: '夸克转存' }] } }) } as never,
      where: 'backend', log: (l) => lines.push(l),
    })
    expect(code).toBe(2)
    expect(lines.join('\n')).toMatch(/东财登录、夸克转存/)
    expect(lines.join('\n')).toMatch(/stream restart --force/)
  })
  it('503 之类 → 1，带上后端给的理由', async () => {
    const lines: string[] = []
    const code = await runRestartCommand({ force: false }, {
      ops: { ...base, pending: async () => [], restart: async () => ({ status: 503, body: { error: { code: 'unavailable', message: 'restart not configured' } } }) } as never,
      where: 'backend', log: (l) => lines.push(l),
    })
    expect(code).toBe(1)
    expect(lines.join('\n')).toMatch(/HTTP 503/)
    expect(lines.join('\n')).toMatch(/restart not configured/)
  })
  /** `--port` 经 `deps.env.STREAM_BACKEND_URL` 进来（cli-entry 那格）；探针和 restart 都得打那个口，
   *  不是 `process.env` 里那份、更不是写死的 8900。 */
  it('deps.env.STREAM_BACKEND_URL 决定探哪个后端、打哪个口', async () => {
    const probed: string[] = []
    const posted: string[] = []
    const fetchImpl = vi.fn(async (url: string) => { posted.push(url); return { status: 202, json: async () => ({ mode: 'foreground' }) } })
    const code = await runRestartCommand({ force: false }, {
      env: { STREAM_BACKEND_URL: 'http://127.0.0.1:9001' } as NodeJS.ProcessEnv,
      probe: async (url) => { probed.push(url); return true },
      fetchImpl: fetchImpl as never,
      log: () => {},
    })
    expect(code).toBe(0)
    expect(probed).toEqual(['http://127.0.0.1:9001'])
    expect(posted).toEqual(['http://127.0.0.1:9001/api/restart'])
  })
  it('后端不在场 → 1，说没有可重启的', async () => {
    const lines: string[] = []
    const code = await runRestartCommand({ force: false }, {
      env: {} as NodeJS.ProcessEnv, probe: async () => false, dataDir: '/nonexistent', selfEntry: '/nonexistent/stream.mjs', log: (l) => lines.push(l),
    })
    expect(code).toBe(1)
    expect(lines.join('\n')).toMatch(/后端没在跑/)
    // 这条命令不查撞名，那句「找不到内置包目录」的告警不该出现
    expect(lines.join('\n')).not.toMatch(/找不到内置包目录/)
  })
})

/** api 档的 pending / restart：`restart` **不抛**，把状态码原样交给调用方分支（409 是一个答案，不是失败）。 */
describe('apiPackageOps.pending / restart', () => {
  it('pending 打 GET /api/packages/pending，回 .pending', async () => {
    const urls: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url)
      return { ok: true, status: 200, json: async () => ({ pending: [{ name: '@x/y', kind: 'installed', needsRestart: true, why: 'w' }] }) }
    })
    const r = await apiPackageOps('http://b', fetchImpl as never).pending()
    expect(urls).toEqual(['http://b/api/packages/pending'])
    expect(r).toEqual([{ name: '@x/y', kind: 'installed', needsRestart: true, why: 'w' }])
  })
  it('pending 后端 503 → 抛后端的理由', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({ error: { code: 'unavailable', message: 'package inventory not configured' } }) }))
    await expect(apiPackageOps('http://b', fetchImpl as never).pending()).rejects.toThrow(/package inventory not configured/)
  })
  it('restart 打 POST /api/restart，force 走 ?force=1；409 不抛', async () => {
    const calls: Array<{ url: string; method?: string }> = []
    const fetchImpl = vi.fn(async (url: string, init?: { method?: string }) => {
      calls.push({ url, method: init?.method })
      return { ok: false, status: 409, json: async () => ({ running: [{ id: 'x', label: 'L' }] }) }
    })
    const ops = apiPackageOps('http://b', fetchImpl as never)
    expect(await ops.restart(false)).toEqual({ status: 409, body: { running: [{ id: 'x', label: 'L' }] } })
    await ops.restart(true)
    expect(calls).toEqual([
      { url: 'http://b/api/restart', method: 'POST' },
      { url: 'http://b/api/restart?force=1', method: 'POST' },
    ])
  })
})

describe('localPackageOps.pending / restart', () => {
  it('pending 回空；restart 抛「后端不在场」', async () => {
    const ops = localPackageOps({ dataDir: '/nonexistent' })
    expect(await ops.pending()).toEqual([])
    await expect(ops.restart(false)).rejects.toThrow(/后端不在场/)
  })
})

/**
 * `readBaseline` 此前没有直接测试——只被 `runUpdateCommand` 间接用到（且那些用例总是
 * 注入 `baseline` 绕开它）。夹具风格照抄 `recipe-package.test.ts` 的 `twoLayers`。
 */
describe('readBaseline', () => {
  it('一个内置包、一条 recipe 带 effects:[send]、不带代码 → { effects: {send}, code: false }', () => {
    const builtinDir = mkdtempSync(join(tmpdir(), 'baseline-builtin-'))
    const userDir = mkdtempSync(join(tmpdir(), 'baseline-user-'))
    try {
      const p = join(builtinDir, 'demo')
      mkdirSync(p, { recursive: true })
      writeFileSync(join(p, 'package.json'), JSON.stringify({
        name: '@streamapp/demo', version: '1.0.0',
        stream: { type: 'recipe', facility: 'demo', schemaVersion: RECIPE_PACKAGE_SCHEMA_VERSION },
      }))
      writeFileSync(join(p, 'manifests.yaml'), [
        '- id: send',
        '  adapter: replay',
        '  description: demo send action for readBaseline test',
        '  topics: []',
        '  capabilities: [timeline]',
        '  cadence_hint_seconds: 1800',
        '  auth:',
        '    type: none',
      ].join('\n'))
      writeFileSync(join(p, 'send.recipe.json'), JSON.stringify({
        version: 1, kind: 'http', sourceId: 'send', output: 'object',
        request: { url: 'https://x.com/api/send', method: 'GET' }, assert: [],
        meta: { effects: ['send'] },
      }))
      expect(readBaseline('@streamapp/demo', builtinDir, userDir)).toEqual({ effects: new Set(['send']), code: false })
    } finally {
      rmSync(builtinDir, { recursive: true, force: true })
      rmSync(userDir, { recursive: true, force: true })
    }
  })

  it('用户层已装那份带 stream.capability → code: true（能力格与代码格同一种权限）', () => {
    const userDir = mkdtempSync(join(tmpdir(), 'baseline-user-cap-'))
    try {
      const p = join(userDir, dirNameFor('@streamapp/cap'))
      mkdirSync(p, { recursive: true })
      writeFileSync(join(p, 'package.json'), JSON.stringify({
        name: '@streamapp/cap', version: '1.0.0',
        stream: { id: 'cap', capability: 'dist/index.js' },
      }))
      expect(readBaseline('@streamapp/cap', undefined, userDir)).toEqual({ effects: new Set(), code: true })
    } finally {
      rmSync(userDir, { recursive: true, force: true })
    }
  })
})
