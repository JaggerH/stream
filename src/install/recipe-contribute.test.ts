import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RecipeOverrideStore } from '../replay/desktop-override-store.ts'
import { contributeTarget, buildContributions, contributionTitle, contributionBody, issueUrl, branchName, contributionPath, contributionHash, findRecipePackage, runRecipeContributeCommand, type Contribution } from './recipe-contribute.ts'

const pkgJson = { name: '@streamapp/wechat', version: '1.0.1', repository: 'github:JaggerH/stream', stream: { type: 'recipe', contribute: { path: 'packages/wechat/wechat-send.recipe.json' } } }

describe('contributeTarget', () => {
  it('repository 三种写法都认；缺 repository 或 contribute.path → undefined', () => {
    expect(contributeTarget(pkgJson)).toEqual({ repo: 'JaggerH/stream', path: 'packages/wechat/wechat-send.recipe.json' })
    expect(contributeTarget({ ...pkgJson, repository: 'https://github.com/JaggerH/stream.git' })!.repo).toBe('JaggerH/stream')
    expect(contributeTarget({ ...pkgJson, repository: { type: 'git', url: 'git+https://github.com/JaggerH/stream.git' } })!.repo).toBe('JaggerH/stream')
    // 带点的仓库名是合法的，别把它判成「没开放贡献」；末尾的 .git 仍然要剥掉。
    expect(contributeTarget({ ...pkgJson, repository: 'github:owner/stream.js' })!.repo).toBe('owner/stream.js')
    expect(contributeTarget({ ...pkgJson, repository: 'https://github.com/owner/stream.js.git' })!.repo).toBe('owner/stream.js')
    expect(contributeTarget({ ...pkgJson, repository: undefined })).toBeUndefined()
    expect(contributeTarget({ ...pkgJson, stream: { type: 'recipe' } })).toBeUndefined()
  })
})

describe('buildContributions / body / url', () => {
  /** 去模板化那道闸的基准：顶层那一步长什么样、参数叫什么名字。 */
  const recipeJson = {
    meta: { params_schema: { contact: { type: 'string' }, message: { type: 'string' } } },
    steps: [
      { label: '点进消息输入框拿焦点', kind: 'click', at: { x: 0.5, y: 0.9 } },
      { label: '打正文', kind: 'type', text: '{message}' },
      { label: '搜联系人', kind: 'type', text: '{contact}' },
    ],
  }
  const setup = () => {
    const s = new RecipeOverrideStore(mkdtempSync(join(tmpdir(), 'c-')))
    s.addGrounding('wechat-send', '点进消息输入框拿焦点', { on: { platform: 'darwin', app: '>=4.0.6 <=4.0.8' }, kind: 'click', at: { x: 0.6, y: 0.87 }, verified: { runs: 4, first: '2026-09-14', last: '2026-09-17', by: 'human' }, origin: { run: 'r1', evidence: 'sha256:x' } })
    s.addGrounding('wechat-send', '打正文', { on: { platform: 'darwin' }, kind: 'type', text: '{message}', verified: { runs: 1, first: '2026-09-14', last: '2026-09-14', by: 'human' } })
    return s
  }
  it('只带过门槛的；不带 origin；带 stream 版本与包身份', () => {
    const cs = buildContributions(setup(), 'wechat-send', recipeJson, { name: '@streamapp/wechat', version: '1.0.1' }, '0.0.21')
    expect(cs).toHaveLength(1)
    expect(cs[0]).toEqual({
      recipe: 'wechat-send', package: { name: '@streamapp/wechat', version: '1.0.1' }, stream: '0.0.21', step: '点进消息输入框拿焦点',
      grounding: { on: { platform: 'darwin', app: '>=4.0.6 <=4.0.8' }, kind: 'click', at: { x: 0.6, y: 0.87 } },
      verified: { runs: 4, first: '2026-09-14', last: '2026-09-17', by: 'human' },
    })
  })
  it('--step 只挑那一步', () => {
    expect(buildContributions(setup(), 'wechat-send', recipeJson, { name: 'p', version: '1' }, '0', { step: '打正文' })).toEqual([])
  })
  it('写死了顶层模板的落地方式不出门，日志点名是哪一步；模板还在的照常送', () => {
    const s = setup()
    // 手写进 override 的一条：顶层是 `{contact}`，这里被写死成了真实联系人名。
    s.addGrounding('wechat-send', '搜联系人', { on: { platform: 'darwin' }, kind: 'type', see: { text: '文件传输助手' }, text: '文件传输助手', verified: { runs: 3, first: '2026-09-14', last: '2026-09-16', by: 'human' } })
    const log: string[] = []
    const cs = buildContributions(s, 'wechat-send', recipeJson, { name: 'p', version: '1' }, '0', undefined, (l) => log.push(l))
    expect(cs.map((c) => c.step)).toEqual(['点进消息输入框拿焦点'])
    expect(log.join('\n')).toContain('搜联系人')
    expect(log.join('\n')).toContain('文件传输助手')
  })
  it('包里已经没有这个 label 的步骤 → 跳过（闸跑不起来不算通过）', () => {
    const s = setup()
    const log: string[] = []
    expect(buildContributions(s, 'wechat-send', { steps: [] }, { name: 'p', version: '1' }, '0', undefined, (l) => log.push(l))).toEqual([])
    expect(log.join('\n')).toContain('点进消息输入框拿焦点')
  })
  it('区域条目：对得上顶层 areas 才送，key 是 area；--area 只筛区域', () => {
    const s = new RecipeOverrideStore(mkdtempSync(join(tmpdir(), 'c-')))
    const verified = { runs: 3, first: '2026-09-10', last: '2026-09-13', by: 'human' as const }
    s.addAreaGrounding('wechat-send', '气泡区', { on: { platform: 'darwin' }, region: 'bottom', verified })
    s.addAreaGrounding('wechat-send', '已删的区域', { on: { platform: 'darwin' }, region: 'top', verified })
    const recipe = { steps: [], areas: { 气泡区: { region: 'center' } }, meta: {} }
    const logs: string[] = []
    const out = buildContributions(s, 'wechat-send', recipe, { name: '@streamapp/wechat', version: '1.0.1' }, '0.0.22', undefined, (l) => logs.push(l))
    expect(out).toEqual([
      { recipe: 'wechat-send', package: { name: '@streamapp/wechat', version: '1.0.1' }, stream: '0.0.22', area: '气泡区', grounding: { on: { platform: 'darwin' }, region: 'bottom' }, verified },
    ])
    expect(out[0].step).toBeUndefined()
    expect(logs.join('\n')).toContain('已删的区域')
    // `--step 气泡区` 不该捞到同名的区域，反之亦然。
    expect(buildContributions(s, 'wechat-send', recipe, { name: 'p', version: '1' }, '0', { step: '气泡区' })).toEqual([])
    expect(buildContributions(s, 'wechat-send', recipe, { name: 'p', version: '1' }, '0', { area: '气泡区' })).toHaveLength(1)
  })
  it('区域条目的标题 / 正文 / 分支名 / 文件路径都说「区域」，哈希也和同名步骤分得开', () => {
    const grounding = { on: { platform: 'darwin' }, region: 'bottom' }
    const verified = { runs: 3, first: '2026-09-10', last: '2026-09-13', by: 'human' as const }
    const area: Contribution = { recipe: 'wechat-send', package: { name: 'p', version: '1' }, stream: '0', area: '气泡区', grounding, verified }
    const step: Contribution = { ...area, area: undefined, step: '气泡区' }
    expect(contributionTitle(area)).toContain('区域「气泡区」')
    expect(contributionTitle(step)).not.toContain('区域「')
    expect(contributionBody(area)).toContain('"area": "气泡区"')
    expect(contributionBody(area)).toContain('| 区域 | 气泡区 |')
    expect(branchName(area)).toMatch(/^contrib\/wechat-send\/darwin-[0-9a-f]{8}$/)
    // 同名的一步和一块区域是两件事：哈希一样就会撞进同一条分支 / 同一个文件，后来的那条被悄悄顶掉。
    expect(contributionHash(area)).not.toBe(contributionHash(step))
    expect(contributionPath(area)).not.toBe(contributionPath(step))
  })
  it('body 是证据表 + json 块；issue URL 编码后含 labels 与 title', () => {
    const [c] = buildContributions(setup(), 'wechat-send', recipeJson, { name: '@streamapp/wechat', version: '1.0.1' }, '0.0.21')
    const body = contributionBody(c)
    expect(body).toMatch(/```json\n[\s\S]*"step": "点进消息输入框拿焦点"[\s\S]*\n```/)
    expect(body).toMatch(/4 次/)
    const url = issueUrl({ repo: 'JaggerH/stream', path: 'x' }, c)
    expect(url.startsWith('https://github.com/JaggerH/stream/issues/new?')).toBe(true)
    expect(url).toContain('labels=recipe-contribution')
    expect(decodeURIComponent(url)).toContain('recipe(wechat-send): darwin')
    expect(branchName(c)).toMatch(/^contrib\/wechat-send\/darwin-[0-9a-f]{8}$/)
  })
  it('哈希与键序无关——同一份 body 换个写入顺序还是同一条分支，不刷重复 PR', () => {
    const base = { recipe: 'r', package: { name: 'p', version: '1' }, stream: '0', step: 'S' }
    const a = { ...base, grounding: { on: { platform: 'darwin' }, kind: 'click', at: { x: 1, y: 2 } }, verified: { runs: 3, first: 'a', last: 'b', by: 'human' as const } }
    const b = { ...base, grounding: { at: { y: 2, x: 1 }, kind: 'click', on: { platform: 'darwin' } }, verified: { runs: 9, first: 'c', last: 'd', by: 'ai' as const } }
    expect(contributionHash(b)).toBe(contributionHash(a))
  })
})

describe('findRecipePackage', () => {
  it('在给定目录树里按 <sourceId>.recipe.json 找到包目录', () => {
    const root = mkdtempSync(join(tmpdir(), 'pk-'))
    const d = join(root, '@streamapp__wechat'); mkdirSync(d)
    writeFileSync(join(d, 'package.json'), JSON.stringify(pkgJson))
    writeFileSync(join(d, 'wechat-send.recipe.json'), '{}')
    expect(findRecipePackage([root], 'wechat-send')?.recipePath).toBe(join(d, 'wechat-send.recipe.json'))
    expect(findRecipePackage([root], 'nope')).toBeUndefined()
  })
})

describe('runRecipeContributeCommand', () => {
  const setup = () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dd-'))
    const d = join(dataDir, 'recipes', '@streamapp__wechat'); mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'package.json'), JSON.stringify(pkgJson))
    // 这份 recipe 是去模板化那道闸的基准：贡献的那一步必须在这里找得到同名 label。
    writeFileSync(join(d, 'wechat-send.recipe.json'), JSON.stringify({ steps: [
      { label: 'L', kind: 'click', at: { x: 0.6, y: 0.87 } },
      { label: '长一', kind: 'type', text: 'x' },
      { label: '长二', kind: 'type', text: 'x' },
    ] }))
    new RecipeOverrideStore(join(dataDir, 'recipe-overrides')).addGrounding('wechat-send', 'L', { on: { platform: 'darwin' }, kind: 'click', at: { x: 0.6, y: 0.87 }, verified: { runs: 4, first: '2026-09-14', last: '2026-09-17', by: 'human' } })
    return dataDir
  }
  /**
   * 假 gh 按子命令精确分派，形状照真 gh 来（`repo view --json defaultBranchRef` 只产生
   * `defaultBranchRef.name`，从来没有 `default_branch`）。默认分支故意不叫 main——
   * 兜底成 main 的实现会在这里当场红，而不是等到线上把 PR 开到错的 base 上。
   */
  /** `canPush`：`gh api repos/<repo> --jq .permissions.push` 回什么——所有者/协作者是 `true`，路人是 `false`。 */
  const fakeGh = (calls: string[][], fail?: (args: string[]) => boolean, canPush = false) => async (args: string[]) => {
    calls.push(args)
    if (fail?.(args)) return { ok: false, out: '' }
    const [a, b] = args
    if (a === 'auth') return { ok: true, out: '' }
    if (a === 'api' && b === 'user') return { ok: true, out: JSON.stringify({ login: 'me' }) }
    if (a === 'api' && b === 'repos/JaggerH/stream' && args[2] === '--jq') return { ok: true, out: `${canPush}\n` }
    if (a === 'repo' && b === 'fork') return { ok: true, out: '' }
    if (a === 'repo' && b === 'view') return { ok: true, out: JSON.stringify({ defaultBranchRef: { name: 'develop' } }) }
    if (a === 'api' && b.includes('/git/ref/')) return { ok: true, out: JSON.stringify({ object: { sha: 'abc' } }) }
    if (a === 'api' && b.endsWith('/git/refs')) return { ok: true, out: '{}' }
    if (a === 'api' && b.includes('/contents/')) return { ok: true, out: '{}' }
    if (a === 'pr' && b === 'create') return { ok: true, out: 'https://github.com/JaggerH/stream/pull/1\n' }
    throw new Error(`假 gh 不认识这条调用：${args.join(' ')}`)
  }

  it('gh 登录着 → fork + 从真正的默认分支切 + 放文件 + pr create；退出码 0', async () => {
    const calls: string[][] = []
    const log: string[] = []
    const code = await runRecipeContributeCommand({ kind: 'recipe-contribute', sourceId: 'wechat-send' }, { dataDir: setup(), gh: fakeGh(calls), open: () => {}, streamVersion: '0.0.21', log: (s) => log.push(s) })
    expect(code).toBe(0)
    const flat = calls.map((c) => c.join(' '))
    expect(calls.map((c) => `${c[0]} ${c[1]}`)).toEqual([
      'auth status', 'api user', 'api repos/JaggerH/stream', 'repo fork', 'repo view',
      'api repos/JaggerH/stream/git/ref/heads/develop',
      'api repos/me/stream/git/refs',
      expect.stringContaining('api repos/me/stream/contents/contributions/wechat-send/darwin-'),
      'pr create',
    ])
    // base 是 develop 不是 main；分支从 me 那个 fork 上发出去。
    expect(flat.some((l) => /git\/refs -f ref=refs\/heads\/contrib\/wechat-send\/darwin-[0-9a-f]{8} -f sha=abc/.test(l))).toBe(true)
    expect(flat.some((l) => /--head me:contrib\/wechat-send\/darwin-[0-9a-f]{8}/.test(l))).toBe(true)
    expect(log.join('\n')).toContain('pull/1')
  })

  it('--area 一路透到贡献物：PR 标题说的是区域，不是步骤', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dd-'))
    const d = join(dataDir, 'recipes', '@streamapp__wechat'); mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'package.json'), JSON.stringify(pkgJson))
    writeFileSync(join(d, 'wechat-send.recipe.json'), JSON.stringify({ steps: [], areas: { 气泡区: {} } }))
    new RecipeOverrideStore(join(dataDir, 'recipe-overrides')).addAreaGrounding('wechat-send', '气泡区', { on: { platform: 'darwin' }, region: 'bottom', verified: { runs: 4, first: '2026-09-14', last: '2026-09-17', by: 'human' } })
    const calls: string[][] = []
    const code = await runRecipeContributeCommand({ kind: 'recipe-contribute', sourceId: 'wechat-send', area: '气泡区' }, { dataDir, gh: fakeGh(calls), open: () => {}, streamVersion: '0.0.22', log: () => {} })
    expect(code).toBe(0)
    const pr = calls.find((c) => c[0] === 'pr')!.join(' ')
    expect(pr).toContain('区域「气泡区」')
    expect(pr).toContain('"area": "气泡区"')
  })

  it('有 push 权限（所有者 / 协作者）→ 不 fork，分支开在仓库本身，head 不带 login: 前缀', async () => {
    // GitHub 不许一个账号同时拥有仓库和它的 fork（活体 2026-09-13 `gh repo fork` 被拒），而所有者
    // 恰恰是最常跑这条命令的人——所以 push 权限在手就绕过 fork。
    const calls: string[][] = []
    const log: string[] = []
    const code = await runRecipeContributeCommand({ kind: 'recipe-contribute', sourceId: 'wechat-send' }, { dataDir: setup(), gh: fakeGh(calls, undefined, true), open: () => {}, streamVersion: '0.0.21', log: (s) => log.push(s) })
    expect(code).toBe(0)
    const flat = calls.map((c) => c.join(' '))
    expect(calls.some((c) => c[0] === 'repo' && c[1] === 'fork')).toBe(false)
    expect(flat.some((l) => /^api repos\/JaggerH\/stream\/git\/refs -f ref=refs\/heads\/contrib\//.test(l))).toBe(true)
    expect(flat.some((l) => /^api repos\/JaggerH\/stream\/contents\/contributions\//.test(l))).toBe(true)
    expect(flat.some((l) => /--head contrib\/wechat-send\/darwin-[0-9a-f]{8} /.test(l))).toBe(true)
    expect(flat.some((l) => /--head me:/.test(l))).toBe(false)
    expect(log.join('\n')).toContain('pull/1')
  })

  it('放文件那一步失败 → 不许再 pr create（否则开出一个报成功的空 PR），退回 issue 链接', async () => {
    const calls: string[][] = []
    const opened: string[] = []
    const log: string[] = []
    const gh = fakeGh(calls, (args) => args[0] === 'api' && args[1].includes('/contents/'))
    const code = await runRecipeContributeCommand({ kind: 'recipe-contribute', sourceId: 'wechat-send' }, { dataDir: setup(), gh, open: (u) => opened.push(u), streamVersion: '0.0.21', log: (s) => log.push(s) })
    expect(code).toBe(0)
    expect(calls.some((c) => c[0] === 'pr')).toBe(false)
    expect(log.join('\n')).toMatch(/没走通/)
    expect(opened[0]).toMatch(/issues\/new\?/)
  })

  it('读不出默认分支 → 不拿 main 兜底，直接退回 issue 链接', async () => {
    const calls: string[][] = []
    const opened: string[] = []
    const gh = fakeGh(calls, (args) => args[0] === 'repo' && args[1] === 'view')
    expect(await runRecipeContributeCommand({ kind: 'recipe-contribute', sourceId: 'wechat-send' }, { dataDir: setup(), gh, open: (u) => opened.push(u), streamVersion: '0.0.21', log: () => {} })).toBe(0)
    expect(calls.some((c) => c[0] === 'api' && c[1].includes('/git/ref/'))).toBe(false)
    expect(opened[0]).toMatch(/issues\/new\?/)
  })
  it('没 gh → 打开预填 issue 链接；退出码 0', async () => {
    const opened: string[] = []
    const code = await runRecipeContributeCommand({ kind: 'recipe-contribute', sourceId: 'wechat-send' }, { dataDir: setup(), gh: async () => ({ ok: false, out: '' }), open: (u) => opened.push(u), streamVersion: '0.0.21', log: () => {} })
    expect(code).toBe(0)
    expect(opened[0]).toMatch(/issues\/new\?/)
  })
  it('没有过门槛的 → 说清并退出码 1；包没开放贡献 → 退出码 1', async () => {
    const dataDir = setup()
    const log: string[] = []
    expect(await runRecipeContributeCommand({ kind: 'recipe-contribute', sourceId: 'wechat-send', step: '不存在' }, { dataDir, gh: async () => ({ ok: false, out: '' }), open: () => {}, log: (s) => log.push(s) })).toBe(1)
    expect(log.join('\n')).toMatch(/没有.*可贡献/)

    // 包没申报去向（缺 stream.contribute.path）→ 也是 1，而且说的是另一件事。
    const d2 = mkdtempSync(join(tmpdir(), 'dd2-'))
    const p = join(d2, 'recipes', 'local-x'); mkdirSync(p, { recursive: true })
    writeFileSync(join(p, 'package.json'), JSON.stringify({ name: 'x', version: '1' }))
    writeFileSync(join(p, 'wechat-send.recipe.json'), '{}')
    const log2: string[] = []
    expect(await runRecipeContributeCommand({ kind: 'recipe-contribute', sourceId: 'wechat-send' }, { dataDir: d2, gh: async () => ({ ok: false, out: '' }), open: () => {}, log: (s) => log2.push(s) })).toBe(1)
    expect(log2.join('\n')).toMatch(/没开放贡献/)
  })
  it('超长的落盘文件名带哈希——同一轮里多条不会互相覆盖', async () => {
    const dataDir = setup()
    const store = new RecipeOverrideStore(join(dataDir, 'recipe-overrides'))
    const verified = { runs: 4, first: '2026-09-14', last: '2026-09-17', by: 'human' as const }
    for (const label of ['长一', '长二']) {
      store.addGrounding('wechat-send', label, { on: { platform: 'darwin' }, kind: 'type', text: 'x'.repeat(7000), verified })
    }
    const log: string[] = []
    const code = await runRecipeContributeCommand({ kind: 'recipe-contribute', sourceId: 'wechat-send' }, { dataDir, gh: async () => ({ ok: false, out: '' }), open: () => {}, streamVersion: '0.0.21', log: (s) => log.push(s) })
    expect(code).toBe(0)
    const written = readdirSync(join(dataDir, 'recipe-overrides')).filter((f) => f.endsWith('.contribution.md'))
    expect(written).toHaveLength(2)
    for (const f of written) expect(f).toMatch(/^wechat-send\.[0-9a-f]{8}\.contribution\.md$/)
    // 日志说的那条路径就是磁盘上真有的那一条。
    for (const f of written) expect(log.join('\n')).toContain(join(dataDir, 'recipe-overrides', f))
  })

  it('找不到这份 recipe → 退出码 1', async () => {
    const log: string[] = []
    expect(await runRecipeContributeCommand({ kind: 'recipe-contribute', sourceId: 'nope' }, { dataDir: setup(), gh: async () => ({ ok: false, out: '' }), open: () => {}, log: (s) => log.push(s) })).toBe(1)
    expect(log.join('\n')).toMatch(/找不到 recipe/)
  })
})
