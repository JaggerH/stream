import { describe, it, expect } from 'vitest'
import { join, resolve } from 'node:path'
import { parseCliArgs, defaultDataDir, envForServer, parsePackageSpec, HELP } from './cli.ts'

describe('stream 这条命令的参数', () => {
  it('什么都不给 → 用默认（端口交给后端自己的默认，别在两处各写一个数）', () => {
    const o = parseCliArgs([])
    expect(o).toEqual({ help: false, version: false, unknown: [] })
    expect(envForServer(o, {}).STREAM_PORT).toBeUndefined()
  })

  it('--port / -p，空格和等号两种写法都认', () => {
    expect(parseCliArgs(['--port', '9000']).port).toBe(9000)
    expect(parseCliArgs(['--port=9000']).port).toBe(9000)
    expect(parseCliArgs(['-p', '9000']).port).toBe(9000)
  })

  /**
   * `--port abc` **不许静默落回默认**：用户以为自己换了口，实际起在 8900，而这件事
   * 在活体上的样子是"我明明指定了端口它却不听"——最难自查的一类。
   */
  it('端口不是个合法端口 → 进 unknown（由调用方报错退出），不当没写', () => {
    for (const bad of ['abc', '0', '70000', '-1']) {
      const o = parseCliArgs(['--port', bad])
      expect(o.port).toBeUndefined()
      expect(o.unknown.length).toBe(1)
    }
  })

  it('--data 折算成绝对路径（后端会 chdir 到资源目录，相对路径到那时就指向别处了）', () => {
    expect(parseCliArgs(['--data', './x']).dataDir).toBe(resolve('./x'))
  })

  it('认不出来的参数原样带出，不吞', () => {
    expect(parseCliArgs(['--wat', '--port', '9000']).unknown).toEqual(['--wat'])
  })

  it('-h / -v', () => {
    expect(parseCliArgs(['-h']).help).toBe(true)
    expect(parseCliArgs(['--version']).version).toBe(true)
  })
})

/**
 * 子命令。**第一个非 flag 参数就是它**，不给就是"起后端"那条老路（`command` 整格缺席，
 * 而不是一个 `{kind:'serve'}` —— 缺席才让"没给子命令"和"给了一个我们认识的子命令"在类型上
 * 分得开，`cli-entry` 的分发也就不用为老路留一个分支）。
 *
 * 认不出来的词**不许当成包名或静默忽略**：`stream ad @streamapp/netdisk` 要当场报错，
 * 而不是把 `ad` 当子命令跑、或者当成没写子命令直接把后端起起来（那才是最难查的一种）。
 */
describe('子命令', () => {
  it('不给子命令 = 老路（起后端），command 整格缺席', () => {
    expect(parseCliArgs([]).command).toBeUndefined()
    expect(parseCliArgs(['--port', '9000']).command).toBeUndefined()
  })

  it('mcp', () => {
    expect(parseCliArgs(['mcp']).command).toEqual({ kind: 'mcp' })
  })

  it('add <包名>，flag 可以跟在后面', () => {
    expect(parseCliArgs(['add', '@streamapp/netdisk']).command).toEqual({
      kind: 'add', name: '@streamapp/netdisk',
    })
    const o = parseCliArgs(['add', '@streamapp/netdisk', '--data', '/tmp/d'])
    expect(o.command).toEqual({ kind: 'add', name: '@streamapp/netdisk' })
    expect(o.dataDir).toBe('/tmp/d')
    expect(o.unknown).toEqual([])
  })

  it('add <包名>@<版本>', () => {
    expect(parseCliArgs(['add', '@streamapp/netdisk@0.2.0']).command).toEqual({
      kind: 'add', name: '@streamapp/netdisk', version: '0.2.0',
    })
    expect(parseCliArgs(['add', 'pansou@1.0.0']).command).toEqual({
      kind: 'add', name: 'pansou', version: '1.0.0',
    })
  })

  it('remove <包名>', () => {
    expect(parseCliArgs(['remove', '@streamapp/netdisk']).command).toEqual({
      kind: 'remove', name: '@streamapp/netdisk',
    })
  })

  /** 卸载没有"卸载哪个版本"这回事——装着的就那一份。带了版本号说明用户想错了，要说出来。 */
  it('remove 不接受版本号', () => {
    const o = parseCliArgs(['remove', '@streamapp/netdisk@0.2.0'])
    expect(o.command).toBeUndefined()
    expect(o.error).toMatch(/版本/)
  })

  it('add / remove 少了包名 → 报错，不当没写', () => {
    expect(parseCliArgs(['add']).error).toBeTruthy()
    expect(parseCliArgs(['remove']).error).toBeTruthy()
    // 后面跟的是个 flag，也不算给了包名。
    expect(parseCliArgs(['add', '--port', '9000']).error).toBeTruthy()
  })

  it('认不出来的子命令进 unknown（由调用方报错退出），不静默起后端', () => {
    const o = parseCliArgs(['ad', '@streamapp/netdisk'])
    expect(o.command).toBeUndefined()
    expect(o.unknown).toContain('ad')
  })

  it('子命令只认第一个（`stream mcp add x` 里的 add 不再是子命令）', () => {
    const o = parseCliArgs(['mcp', 'add'])
    expect(o.command).toEqual({ kind: 'mcp' })
    expect(o.unknown).toContain('add')
  })

  it('recipe contribute <id> [--step <label>]', () => {
    expect(parseCliArgs(['recipe', 'contribute', 'wechat-send']).command).toEqual({ kind: 'recipe-contribute', sourceId: 'wechat-send' })
    expect(parseCliArgs(['recipe', 'contribute', 'wechat-send', '--step', '点输入框']).command).toEqual({ kind: 'recipe-contribute', sourceId: 'wechat-send', step: '点输入框' })
    expect(parseCliArgs(['recipe']).error).toMatch(/recipe (run|contribute) <recipe id>/)
    expect(parseCliArgs(['recipe', 'frob', 'x']).error).toMatch(/只认 run \/ contribute/)
  })

  it('recipe run <id> [--param k=v]… [--yes] [--json]', () => {
    expect(parseCliArgs(['recipe', 'run', 'qq-send']).command).toEqual({ kind: 'recipe-run', sourceId: 'qq-send', params: {}, yes: false, json: false })
    expect(parseCliArgs(['recipe', 'run', 'qq-send', '--param', 'contact=张三', '--param', 'text=hi', '--yes', '--json']).command)
      .toEqual({ kind: 'recipe-run', sourceId: 'qq-send', params: { contact: '张三', text: 'hi' }, yes: true, json: true })
    // 值里带 = 的照样只按第一个 = 拆：一条 URL 参数不能被截成两半
    expect(parseCliArgs(['recipe', 'run', 'x', '--param', 'url=https://a/b?c=d']).command).toMatchObject({ params: { url: 'https://a/b?c=d' } })
    expect(parseCliArgs(['recipe', 'run']).error).toMatch(/recipe run <recipe id>/)
    expect(parseCliArgs(['recipe', 'run', 'x', '--param']).error).toMatch(/--param 要跟 名字=值/)
    expect(parseCliArgs(['recipe', 'run', 'x', '--param', 'novalue']).error).toMatch(/--param 要跟 名字=值/)
  })

  /** `--port` 对 `recipe run` 也生效——它打的是那个后端的门。同一个 flag 在不同子命令下含义漂移是最难查的。 */
  it('recipe run 前后的 --port 都认', () => {
    expect(parseCliArgs(['--port', '9001', 'recipe', 'run', 'x']).port).toBe(9001)
    expect(parseCliArgs(['recipe', 'run', 'x', '--port', '9001']).port).toBe(9001)
  })

  it('recipe contribute <id> --area <名字>；和 --step 只能给一个', () => {
    expect(parseCliArgs(['recipe', 'contribute', 'wechat-send', '--area', '气泡区']).command).toEqual({ kind: 'recipe-contribute', sourceId: 'wechat-send', area: '气泡区' })
    expect(parseCliArgs(['recipe', 'contribute', 'wechat-send', '--area']).error).toMatch(/--area 要跟一个区域名字/)
    expect(parseCliArgs(['recipe', 'contribute', 'wechat-send', '--step', 'L', '--area', '气泡区']).error).toMatch(/--step 和 --area 只能给一个/)
    expect(parseCliArgs(['recipe', 'contribute', 'wechat-send', '--area', '气泡区', '--step', 'L']).error).toMatch(/--step 和 --area 只能给一个/)
  })
})

describe('包名@版本 的拆法', () => {
  it('scope 的那个 @ 不是版本分隔符', () => {
    expect(parsePackageSpec('@streamapp/netdisk')).toEqual({ name: '@streamapp/netdisk' })
  })
  it('最后一个 @ 才是', () => {
    expect(parsePackageSpec('@a/b@1.2.3-rc.1')).toEqual({ name: '@a/b', version: '1.2.3-rc.1' })
    expect(parsePackageSpec('b@1.2.3')).toEqual({ name: 'b', version: '1.2.3' })
  })
})

describe('数据目录', () => {
  /** `~/.stream` 不是随手挑的：native messaging 清单和 Stream Desktop 的 data 指针已经住那儿。 */
  it('默认 ~/.stream', () => {
    expect(defaultDataDir({}, '/home/u')).toBe(join('/home/u', '.stream'))
  })

  it('STREAM_DATA_DIR 显式给了就听它（容器/自托管那一档一直这么传）', () => {
    expect(defaultDataDir({ STREAM_DATA_DIR: '/srv/d' }, '/home/u')).toBe('/srv/d')
  })

  it('空串不算给了', () => {
    expect(defaultDataDir({ STREAM_DATA_DIR: '  ' }, '/home/u')).toBe(join('/home/u', '.stream'))
  })

  it('命令行 --data 压过环境变量', () => {
    const env = envForServer(parseCliArgs(['--data', '/opt/s']), { STREAM_DATA_DIR: '/srv/d' })
    expect(env.STREAM_DATA_DIR).toBe('/opt/s')
  })
})

/**
 * 发行包 `cli/package.json` 里那几个 **runtime 依赖**（server.mjs 把它们留成 external，
 * 在用户机器上由 npm 装）必须和仓库根锁的是**同一个范围**。
 *
 * 分家的代价是真实撞到过的（2026-08-31，win-test 全新机器）：根上是 `better-sqlite3@^11`，
 * 而 `^11` 没有 Node 24 的预编译包 → 用户机器上退回 node-gyp 源码编译 → 缺 Python/VS
 * 直接 `npm install` 失败，**一条命令的安装当场废掉**。而本地怎么跑都是绿的：我们自己的
 * node 版本不同、装的是另一个版本。两边单看都正常，没有任何一处会喊。
 *
 * **例外表 `ROOT_EXEMPT` 不是"跳过检查"，是把"为什么它安全"编成判据。** 上面那次事故的
 * 成因是**范围解析**（`^11` 在不同 node 版本的机器上解出不同的版本），所以豁免的前提就是
 * 这条依赖**没有解析的自由度**——精确钉死的版本，两边装到的必然是同一份。下面那条
 * `pinned` 断言守的就是这个前提：谁哪天把它改回 `^x.y.z`，豁免的理由当场不成立、测试变红。
 *
 * 豁免有**两种**前提，各自由下面一条断言真去核：
 * - `pinned`：精确钉死的版本，没有解析的自由度（上面那段说的那种）。
 * - `not-imported`：仓库源码里没有任何一处**静态 import** 它——它只是随发行包出货的字节，
 *   由运行时按路径解出。根上没有它不是疏漏，是**开发机根本走不到那条路**（扩展那份的第一档
 *   是仓库自己的构建产物，见 `shared/browser-relay/extension-dir.ts`）。这个前提一旦被打破
 *   （有人真的把这个包 import 进来），根上就必须装它，否则 tsc / bundler
 *   在开发机上会直接找不到——那条断言当场变红。
 */
interface RootExemption {
  /** 为什么根上没有它（会被打进失败信息，逼下一个人读完再动）。 */
  why: string
  /** 豁免的前提，下面的断言真去核的那一条。 */
  premise: 'pinned' | 'not-imported'
}

/** 允许只住在 `cli/` 里的依赖 → 豁免的理由与前提。 */
const ROOT_EXEMPT: Record<string, RootExemption> = {
  '@streamapp/chrome-extension': {
    why:
      '扩展的字节，只随发行包出货：`shared/browser-relay/extension-dir.ts` 用 require.resolve ' +
      '按路径解出它的目录再整份拷走，从不 import 它。开发机命中的是第一档（仓库自己的 ' +
      '`extension/.output/chrome-mv3`），所以仓库根没有理由装一份。',
    premise: 'not-imported',
  },
}

describe('发行包的依赖不许和仓库根分家', () => {
  it('cli/package.json 的每个 runtime 依赖 = 根 package.json 里的同一个范围', async () => {
    const { readFileSync } = await import('node:fs')
    const root = resolve(import.meta.dirname, '../..')
    const read = (p: string) => JSON.parse(readFileSync(join(root, p), 'utf8'))
    const rootDeps = { ...read('package.json').dependencies }
    const cliDeps = read('cli/package.json').dependencies as Record<string, string>
    for (const [name, range] of Object.entries(cliDeps)) {
      if (name in ROOT_EXEMPT) continue
      expect(rootDeps[name], `${name} 在根的 dependencies 里不存在——发行包凭什么装它？`).toBeDefined()
      expect(range, `${name}：发行包 ${range} ≠ 仓库根 ${rootDeps[name]}`).toBe(rootDeps[name])
    }
  })

  // 豁免的前提各自被真去核了。任一条一红，说明前提没了，例外也就不该再有。
  it('每个豁免的依赖，它写下的那条前提今天仍然成立', async () => {
    const { readFileSync } = await import('node:fs')
    const root = resolve(import.meta.dirname, '../..')
    const cliDeps = JSON.parse(readFileSync(join(root, 'cli/package.json'), 'utf8')).dependencies as Record<string, string>
    for (const [name, { why, premise }] of Object.entries(ROOT_EXEMPT)) {
      const range = cliDeps[name]
      expect(range, `${name} 在 ROOT_EXEMPT 里却不在 cli 的 dependencies 里——例外表该清了`).toBeDefined()
      if (premise === 'pinned') {
        expect(
          /^\d+\.\d+\.\d+(?:[-+][\w.]+)?$/.test(range ?? ''),
          `${name}: "${range}" 不是精确版本。豁免它的全部理由是"没有范围解析的自由度"（${why}）——` +
            '写成范围之后这条理由当场不成立，要么钉死版本，要么把它加回仓库根。',
        ).toBe(true)
      } else {
        // `not-imported`：仓库源码里不许出现对它的静态 import / require。出现了就说明开发机
        // 也要装它，根上没有它就不再是"走不到那条路"，而是一个会在别人机器上炸的缺口。
        const { spawnSync } = await import('node:child_process')
        // `rg` 无命中时 exit 1（那正是我们要的状态），所以用 spawnSync 读 stdout，
        // 不用会因此抛的 execFileSync。不能用 git grep：公开 archive 没有 `.git`。
        const r = spawnSync(
          'rg',
          [
            '-n',
            '-e',
            `(from|import|require\\()[ ]*['"]${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`,
            join(root, 'src'),
            join(root, 'shared'),
            join(root, 'app/src'),
            join(root, 'capabilities'),
            join(root, 'cli'),
            join(root, 'scripts'),
          ],
          { cwd: root, encoding: 'utf8' },
        )
        // rg 没跑起来时 `stdout` 是空的，而空 = "没人 import"——
        // 这条断言**恰好是通过的**，于是守卫悄悄退化成一句空话。先证明它真的搜过。
        expect(r.error, `rg 没跑起来：${r.error?.message}`).toBeUndefined()
        expect([0, 1], `rg 异常退出（status=${r.status}）：${r.stderr}`).toContain(r.status)
        const hits = (r.stdout ?? '').trim()
        expect(hits, `${name} 被静态 import 了（${hits}）。豁免的理由是"没人 import 它"（${why}）——理由没了。`).toBe('')
      }
    }
  })
})

/**
 * `--external:` 那份名单就是这条守卫的回补清单。
 *
 * external 只说"别把它打进 bundle"（原生 addon 打进去必炸），**没说它会不会随包出货**。
 * 出不出货的判据只有一条：**静态 import 还是动态 import**。
 *
 * - 静态 import → 开机那一刻就要解析得到。不出货 = 干净装机上 `ERR_MODULE_NOT_FOUND`，后端根本起不来。
 * - 只被动态 import（且有降级）→ boot 不受影响，但**不等于可以不出货**：降级只保 boot，不保功能。
 *   内置功能真靠它的（`isolated-vm` 撑着内置 recipe 的 compute 段）照样得出货——见下一条守卫。
 *
 * 为什么必须写成一条测试：这个缺陷在开发机上**完全看不见**——仓库根装着 sharp，tsc 绿、全量测试绿、
 * `npm pack` 也绿，只有在一台没有它的机器上第一次启动才炸。2026-09-07 的干净装机 e2e 正是撞在这里
 * （`desktop-see.ts` 静态 import sharp，而 sharp 被 external 掉又没进 cli 的 dependencies）。
 */
describe('被 --external 掉的包：静态 import 的必须随发行包出货', () => {
  it('build-server.mjs 的每个 --external，静态 import 就得在 cli/package.json 里', async () => {
    const { readFileSync } = await import('node:fs')
    const { spawnSync } = await import('node:child_process')
    const root = resolve(import.meta.dirname, '../..')
    const buildScript = readFileSync(join(root, 'scripts/build-server.mjs'), 'utf8')
    const externals = [...buildScript.matchAll(/--external:([^'"\s]+)/g)].map((m) => m[1]!)
    // 名单空了 = 这条守卫在空转（有人改了 build-server 的写法），比不通过更坏。
    expect(externals.length, 'build-server.mjs 里一个 --external 都没搜到——守卫在空转').toBeGreaterThan(0)

    const cliDeps = JSON.parse(readFileSync(join(root, 'cli/package.json'), 'utf8')).dependencies as Record<string, string>
    for (const name of externals) {
      const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      // `from 'x'` / `import 'x'` / `require('x')` 命中静态用法；`import('x')` 是动态的，
      // 后面跟的是括号不是引号，所以这个模式天然放它过去——这正是本条要区分的那件事。
      const r = spawnSync(
        'rg',
        ['-n', '--glob', '!*.test.ts', '-e', `(from|import|require\\()[ ]*['"]${esc}['"]`, join(root, 'src'), join(root, 'shared')],
        { cwd: root, encoding: 'utf8' },
      )
      // rg 没跑起来时 stdout 为空，而空 = "没人静态 import"——那会让守卫悄悄变成一句空话。
      expect(r.error, `rg 没跑起来：${r.error?.message}`).toBeUndefined()
      expect([0, 1], `rg 异常退出（status=${r.status}）：${r.stderr}`).toContain(r.status)
      const staticHits = (r.stdout ?? '')
        .split('\n')
        .filter((l) => l.trim() !== '')
        // 注释里提到包名不算引用；`import type` 在 build 期被擦掉，也不算。
        .filter((l) => !/:\s*(\/\/|\*|\/\*)/.test(l))
        .filter((l) => !/\bimport\s+type\b/.test(l))
      if (staticHits.length === 0) continue
      expect(
        cliDeps[name],
        `${name} 被 --external 掉了，而且是**静态** import（${staticHits[0]}）——` +
          '它必须写进 cli/package.json 的 dependencies 随包出货，否则干净装机上后端起不来' +
          '（ERR_MODULE_NOT_FOUND，开发机上永远看不到）。真想不出货，就把它改成动态 import + 明确降级，' +
          '像 src/replay/compute-sandbox.ts 对 isolated-vm 那样。',
      ).toBeDefined()
    }
  })
})

/**
 * 「动态 import + 降级」只保 boot，不保功能。`isolated-vm` 就是这样被漏掉的：它不随包出货，后端照样起，
 * 而内置 recipe 的 compute 段（音乐搜索 / 下载、歌单、网盘分享验活……）在每一台用户机器上都失败——
 * 开发机仓库根装着它，所以全量测试、活体全绿（2026-09-27，Mac 上装 0.0.26 订歌单才撞出来）。
 * 判据：只要有内置 recipe 写了 `compute`，发行包就必须带上它，且与仓库根同一个版本（沙箱行为随版本变）。
 */
describe('内置 recipe 用了 compute：isolated-vm 必须随发行包出货', () => {
  it('cli/package.json 的 dependencies 或 optionalDependencies 里有 isolated-vm，版本与仓库根一致', async () => {
    const { readFileSync, readdirSync, existsSync } = await import('node:fs')
    const root = resolve(import.meta.dirname, '../..')
    const pkgsDir = join(root, 'packages')
    const users: string[] = []
    for (const dir of readdirSync(pkgsDir, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue
      for (const f of readdirSync(join(pkgsDir, dir.name))) {
        if (!f.endsWith('.recipe.json')) continue
        const recipe = JSON.parse(readFileSync(join(pkgsDir, dir.name, f), 'utf8')) as { compute?: unknown }
        if (recipe.compute) users.push(`${dir.name}/${f}`)
      }
    }
    // 走空 = 这条守卫在空转（目录挪了 / 字段改名了），比不通过更坏。
    expect(existsSync(pkgsDir)).toBe(true)
    if (users.length === 0) return
    const cli = JSON.parse(readFileSync(join(root, 'cli/package.json'), 'utf8')) as {
      dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>
    }
    const shipped = cli.dependencies?.['isolated-vm'] ?? cli.optionalDependencies?.['isolated-vm']
    expect(shipped, `这些内置 recipe 用了 compute，而发行包不带 isolated-vm：${users.join(', ')}`).toBeDefined()
    const rootVersion = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }).dependencies?.['isolated-vm']
    expect(shipped, '发行包的 isolated-vm 版本要与仓库根一致（测过的就是那一版）').toBe(rootVersion)
  })
})

describe('stream update', () => {
  it('不带包名 = 全查', () => {
    expect(parseCliArgs(['update']).command).toEqual({ kind: 'update', names: [], yes: false })
  })
  it('带包名与 --yes', () => {
    expect(parseCliArgs(['update', '@streamapp/wechat', '@streamapp/qq', '--yes']).command)
      .toEqual({ kind: 'update', names: ['@streamapp/wechat', '@streamapp/qq'], yes: true })
  })
  it('--yes 写在包名前面也认', () => {
    expect(parseCliArgs(['update', '--yes', '@streamapp/wechat']).command)
      .toEqual({ kind: 'update', names: ['@streamapp/wechat'], yes: true })
  })
  it('update 不接受版本号', () => {
    expect(parseCliArgs(['update', '@streamapp/wechat@1.0.2']).error).toMatch(/版本号/)
  })
  it('后面的 --data 仍归外层', () => {
    const o = parseCliArgs(['update', '@streamapp/wechat', '--data', '/tmp/d'])
    expect(o.command).toEqual({ kind: 'update', names: ['@streamapp/wechat'], yes: false })
    expect(o.dataDir).toBe('/tmp/d')
  })
})

/** 装 / 更 / 卸完要不要重启后端：`--restart` / `--no-restart` 把「问」跳过去（脚本里不能等人答）。 */
describe('--restart / --no-restart', () => {
  it('add / remove / update 都认，进 restart 一格', () => {
    expect(parseCliArgs(['add', '@streamapp/netdisk', '--restart']).command)
      .toEqual({ kind: 'add', name: '@streamapp/netdisk', restart: 'yes' })
    expect(parseCliArgs(['remove', '@streamapp/netdisk', '--no-restart']).command)
      .toEqual({ kind: 'remove', name: '@streamapp/netdisk', restart: 'no' })
    expect(parseCliArgs(['update', '--yes', '--restart']).command)
      .toEqual({ kind: 'update', names: [], yes: true, restart: 'yes' })
  })
  it('写在子命令前面也认', () => {
    expect(parseCliArgs(['--no-restart', 'add', '@streamapp/netdisk']).command)
      .toEqual({ kind: 'add', name: '@streamapp/netdisk', restart: 'no' })
  })
  it('不给 = 没有这一格（运行时才决定问不问）', () => {
    expect(parseCliArgs(['add', '@streamapp/netdisk']).command).not.toHaveProperty('restart')
  })
  it('两个都给 → 报错，不是后者盖前者', () => {
    expect(parseCliArgs(['add', '@streamapp/netdisk', '--restart', '--no-restart']).error).toMatch(/--restart 和 --no-restart 只能给一个/)
  })
  it('对别的子命令没意义 → 进 unknown，不静默吞', () => {
    expect(parseCliArgs(['mcp', '--restart']).unknown).toContain('--restart')
  })
})

describe('stream restart', () => {
  it('restart', () => {
    expect(parseCliArgs(['restart']).command).toEqual({ kind: 'restart', force: false })
  })
  it('restart --force', () => {
    expect(parseCliArgs(['restart', '--force']).command).toEqual({ kind: 'restart', force: true })
  })
  it('--force 对别的子命令没意义 → 进 unknown', () => {
    expect(parseCliArgs(['add', '@x/y', '--force']).unknown).toContain('--force')
  })
  it('HELP 里有它', () => {
    expect(HELP).toMatch(/restart \[--force\]/)
  })
})
