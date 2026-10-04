// src/install/recipe-contribute.ts
/**
 * `stream recipe contribute <id>`：把本机 override 里过了门槛的落地方式送回包的仓库。
 *
 * 零基础设施——去向由包自己说（`repository` + `stream.contribute.path`），我们不维护任何
 * 收集服务。有 `gh` 就开 PR（PR 里加一个 `contributions/<recipe>/<platform>-<hash>.json`，
 * 作者侧 `pnpm recipe:absorb` 吸收），没有就开一个预填好的 issue。贡献物**不带截图 / 控件树 /
 * origin**（spec §6.2）：那些是本机现场，既没有复用价值，又可能带着别人的东西。
 *
 * **与 spec §6.4 的一处差别**：spec 说贡献物超长时走剪贴板；这里落成「写文件 + 打印路径」
 * （`<dataDir>/recipe-overrides/<recipe>.contribution.md`）。理由是可测、且不依赖
 * `pbcopy`/`clip`——剪贴板在无头环境里静默失败，而用户以为自己手上已经有那段内容了。
 */
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { RecipeOverrideStore } from '../replay/desktop-override-store.ts'
import { assertTemplatesKept, groundingBody, type GroundingVerified } from '../replay/desktop-grounding.ts'
import { defaultDataDir } from './cli.ts'
import { builtinDirNear } from './add-command.ts'

export interface Contribution {
  recipe: string
  package: { name: string; version: string }
  stream: string
  /** 一条落地方式要么属于某一步，要么属于某块具名区域（spec §3.4）——**两者恰给一个**。 */
  step?: string
  area?: string
  grounding: Record<string, unknown>
  verified: GroundingVerified
}

/** 人话里怎么称呼这条贡献物指向的那个东西。步骤和区域同名是合法的，所以区域这边要点名。 */
function subject(c: Pick<Contribution, 'step' | 'area'>): string {
  return c.area !== undefined ? `区域「${c.area}」` : `「${c.step}」`
}
export interface ContributeTarget {
  repo: string
  /**
   * 包里那份 recipe 的仓库内路径（`stream.contribute.path`）。**本模块只拿它当「这个包开放了
   * 贡献」的信号**——PR 里放的是 `contributions/<recipe>/<...>.json`，不是往这个路径写。
   * 真正读它的是作者侧的 `scripts/recipe-absorb.mjs`（把贡献物合进这份 recipe）。所以它在这里
   * 看着像个死字段，删不得。
   */
  path: string
}

export type GhRunner = (args: string[]) => Promise<{ ok: boolean; out: string }>

export interface RecipeContributeDeps {
  dataDir?: string
  selfEntry?: string
  gh?: GhRunner
  open?: (url: string) => void
  streamVersion?: string
  log?: (s: string) => void
}

/** 包申报的去向。两格缺一格就是「这个包没开放贡献」——不猜，也不往我们自己的仓库兜底。 */
export function contributeTarget(pkg: Record<string, unknown>): ContributeTarget | undefined {
  const path = (pkg.stream as { contribute?: { path?: unknown } } | undefined)?.contribute?.path
  if (typeof path !== 'string' || !path) return undefined
  const raw = typeof pkg.repository === 'string' ? pkg.repository : (pkg.repository as { url?: string } | undefined)?.url
  if (!raw) return undefined
  // 仓库名里**可以有点**（`owner/stream.js`）——只把末尾那个 `.git` 剥掉。排除点会让这类包
  // 被判成「没开放贡献」，而那句话与事实不符，排查时会往 contribute.path 上找错方向。
  const m = /^(?:github:|(?:git\+)?https?:\/\/github\.com\/|git@github\.com:)([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(raw.trim())
  if (m && m[2].includes('/')) return undefined
  return m ? { repo: `${m[1]}/${m[2]}`, path } : undefined
}

/**
 * 过了门槛的落地方式 → 要送出去的贡献物。
 *
 * **去模板化那道闸开在这里，不只在装载期。** `assertTemplatesKept` 原先只在包被装载时跑
 * （`recipe-store.ts`），而本机 override 那份文件**从来不过装载闸**（只 `JSON.parse`），
 * spec §5.4 又明写允许手工编辑它——于是一条把顶层的 `{contact}` 写死成真实联系人名的
 * grounding，能一路走到 GitHub。这是数据**真正离开这台机器**的那一处，闸必须开在这儿。
 *
 * `recipe` 是包里那份 recipe 的解析结果：按 `label` 取顶层那一步当模板基准，参数名取自
 * `meta.params_schema`。**取不到那一步就跳过**——闸跑不起来不等于通过（一条 label 已经不
 * 存在的落地方式，送上去作者也无处安放）。
 */
export function buildContributions(
  store: RecipeOverrideStore,
  sourceId: string,
  recipe: Record<string, unknown>,
  pkg: { name: string; version: string },
  streamVersion: string,
  only?: { step?: string; area?: string },
  log: (s: string) => void = (s) => void process.stdout.write(`${s}\n`),
): Contribution[] {
  const steps = Array.isArray(recipe.steps) ? (recipe.steps as Record<string, unknown>[]) : []
  const areas = (recipe.areas ?? {}) as Record<string, unknown>
  const paramNames = Object.keys(((recipe.meta as { params_schema?: Record<string, unknown> } | undefined)?.params_schema) ?? {})
  const out: Contribution[] = []
  for (const entry of store.contributable(sourceId)) {
    // 同一个名字既可能是一步、也可能是一块区域，所以筛选按「哪一种 + 叫什么」两项一起看：
    // `--step 气泡区` 不该捞到同名的区域。
    const key: Pick<Contribution, 'step' | 'area'> = entry.area !== undefined ? { area: entry.area } : { step: entry.label! }
    if (only?.step !== undefined && key.step !== only.step) continue
    if (only?.area !== undefined && key.area !== only.area) continue
    const who = subject(key)
    if (key.area !== undefined) {
      if (!areas[key.area]) {
        log(`跳过${who}：包里这份 recipe 已经没有这块区域了，对不上就不送`)
        continue
      }
      // 区域的 body 只有 region（spec §3.4），没有参数字面量可泄露——去模板化那道闸没有基准也
      // 没有对象，不跑。
    } else {
      const top = steps.find((s) => s.label === key.step)
      if (!top) {
        log(`跳过${who}：包里这份 recipe 已经没有这个 label 的步骤了，对不上就不送`)
        continue
      }
      try {
        assertTemplatesKept(top, entry.grounding as unknown as Record<string, unknown>, paramNames, `本机落地方式${who}`)
      } catch (e) {
        log(`跳过${who}：${(e as Error).message}`)
        continue
      }
    }
    out.push({
      recipe: sourceId,
      package: pkg,
      stream: streamVersion,
      ...key,
      // groundingBody 把 on / verified / origin / shadowed 都剥掉——origin 不出门（spec §6.2）。
      grounding: { on: entry.grounding.on, ...groundingBody(entry.grounding) },
      verified: entry.grounding.verified,
    })
  }
  return out
}

export function contributionTitle(c: Contribution): string {
  const on = c.grounding.on as { platform?: string; app?: string }
  return `recipe(${c.recipe}): ${on.platform ?? '*'}${on.app ? ` ${on.app}` : ''} 的${subject(c)}落地方式`
}

export function contributionBody(c: Contribution): string {
  return [
    `| 项 | 值 |`,
    `|---|---|`,
    `| recipe | ${c.recipe}（${c.package.name}@${c.package.version}） |`,
    c.area !== undefined ? `| 区域 | ${c.area} |` : `| 步骤 | ${c.step} |`,
    `| 在哪验过 | ${JSON.stringify(c.grounding.on)} |`,
    `| 真实运行 | ${c.verified.runs} 次，${c.verified.first} → ${c.verified.last}，判据每次都过 |`,
    `| 填充者 | ${c.verified.by} |`,
    `| Stream | ${c.stream} |`,
    ``,
    '```json',
    JSON.stringify(c, null, 2),
    '```',
    ``,
    `由 \`stream recipe contribute\` 生成；作者用 \`pnpm recipe:absorb <这个 issue/PR 号>\` 吸收。`,
  ].join('\n')
}

/**
 * 预填好的 issue 链接。**不用 `URLSearchParams`**：它按 form-urlencoded 把空格编成 `+`，
 * GitHub 的 issue 模板参数照单全收，于是标题里每个空格都变成一个加号。这里用
 * `encodeURIComponent`（空格 → `%20`）。
 */
export function issueUrl(target: ContributeTarget, c: Contribution): string {
  const q = Object.entries({ title: contributionTitle(c), labels: 'recipe-contribution', body: contributionBody(c) })
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&')
  return `https://github.com/${target.repo}/issues/new?${q}`
}

/**
 * 键序无关的序列化。`JSON.stringify` 按写入顺序输出，同一份 grounding 只因为两次写的键序不同
 * 就会算出另一个哈希、落到另一条分支上——「同一份 body 不刷重复 PR」这个目的当场就漏了。
 * （`src/replay/desktop-grounding.ts` 里有一份同样的东西，但没导出；这里不动 replay 那侧的接口。）
 */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`
  }
  return JSON.stringify(v)
}

/**
 * 贡献物的身份：同一步同一份 body 反复贡献时落在同一个分支/文件名上，不会刷出一堆重复 PR。
 *
 * **编进去的是 `{step}` / `{area}` 整个键，不是那个名字本身**：一步和一块区域可以同名（`气泡区`），
 * 只编名字的话两条贡献物算出同一个哈希，于是走同一条分支、写同一个文件——后送的那条把先送的
 * 悄悄顶掉，而两边都报「已开 PR」。
 */
export function contributionHash(c: Contribution): string {
  return createHash('sha256').update(canonical([c.area !== undefined ? { area: c.area } : { step: c.step }, c.grounding])).digest('hex').slice(0, 8)
}
export function branchName(c: Contribution): string {
  const on = c.grounding.on as { platform?: string }
  return `contrib/${c.recipe}/${on.platform ?? 'any'}-${contributionHash(c)}`
}
export function contributionPath(c: Contribution): string {
  const on = c.grounding.on as { platform?: string }
  return `contributions/${c.recipe}/${on.platform ?? 'any'}-${contributionHash(c)}.json`
}

/** 在几个包目录树里找装着 `<sourceId>.recipe.json` 的那个包。 */
export function findRecipePackage(
  dirs: string[],
  sourceId: string,
): { dir: string; packageJson: Record<string, unknown>; recipePath: string } | undefined {
  for (const root of dirs) {
    if (!root || !existsSync(root)) continue
    for (const name of readdirSync(root)) {
      const dir = join(root, name)
      // 悬空符号链接（`<dataDir>/recipes/` 里出现过）不该把整条命令崩掉在一个和贡献无关的原因上。
      if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) continue
      const recipePath = join(dir, `${sourceId}.recipe.json`)
      if (!existsSync(recipePath)) continue
      const pj = join(dir, 'package.json')
      const packageJson = existsSync(pj) ? (JSON.parse(readFileSync(pj, 'utf8')) as Record<string, unknown>) : {}
      return { dir, packageJson, recipePath }
    }
  }
  return undefined
}

/** 浏览器地址栏能吃下的长度。超了就落文件——截断的链接会开出一个内容残缺的 issue。 */
const ISSUE_URL_MAX = 6000

function defaultGh(args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) =>
    execFile('gh', args, { maxBuffer: 4 << 20 }, (err, stdout) => resolve({ ok: !err, out: String(stdout ?? '') })),
  )
}
function defaultOpen(url: string): void {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]]
  execFile(cmd as string, args as string[], () => {})
}

/**
 * fork → 从上游默认分支切一条 → 放一个文件 → 开 PR。
 *
 * **每一步都看 `ok`**，任一步没成就带着那一步的名字返回 failed，调用方退回 issue 那条路。
 * 不看的代价不是少一次重试：文件 PUT 失败之后 `pr create` 照样能开出一个**空 PR** 并拿到 URL，
 * 我们打印「已开 PR」，作者侧 `recipe:absorb` 却找不到任何贡献物——两边都不会喊。
 * 同理 base 分支解析不出来时**不许兜底成 `main`**：上游默认分支不叫 main 时那是静默开错 PR。
 */
type PrResult = { url: string } | { failed: string }

async function pullRequest(gh: GhRunner, target: ContributeTarget, c: Contribution): Promise<PrResult> {
  const who = await gh(['api', 'user'])
  const me = JSON.parse(who.out || '{}') as { login?: string }
  if (!who.ok || !me.login) return { failed: '查不到你的 GitHub 账号（gh api user）' }

  // 有 push 权限（仓库所有者 / 协作者）就**不 fork**，分支直接开在仓库本身：GitHub 不许一个账号
  // 同时拥有仓库和它的 fork（活体 2026-09-13：`gh repo fork` 回「A single user account cannot own
  // both a parent and fork」），而所有者恰恰是最常跑这条命令的人——作者在自己机器上学到一条
  // 落地方式，也该走同一条路进包。`permissions.push` 读不到就按没有算，退回 fork。
  const perm = await gh(['api', `repos/${target.repo}`, '--jq', '.permissions.push'])
  const canPush = perm.ok && perm.out.trim() === 'true'
  if (!canPush) {
    const forked = await gh(['repo', 'fork', target.repo, '--clone=false'])
    if (!forked.ok) return { failed: `fork ${target.repo} 没成` }
  }

  const viewed = await gh(['repo', 'view', target.repo, '--json', 'defaultBranchRef'])
  const repo = JSON.parse(viewed.out || '{}') as { defaultBranchRef?: { name?: string } }
  const base = repo.defaultBranchRef?.name
  if (!viewed.ok || !base) return { failed: `读不出 ${target.repo} 的默认分支` }

  const got = await gh(['api', `repos/${target.repo}/git/ref/heads/${base}`])
  const sha = (JSON.parse(got.out || '{}') as { object?: { sha?: string } }).object?.sha
  if (!got.ok || !sha) return { failed: `读不出 ${base} 的最新提交` }

  // 分支落在哪：能 push 就是仓库本身，否则是自己名下的 fork。`head` 的写法随之变——同仓库不带
  // `login:` 前缀。
  const fork = canPush ? target.repo : `${me.login}/${target.repo.split('/')[1]}`
  const head = canPush ? branchName(c) : `${me.login}:${branchName(c)}`
  const branch = branchName(c)
  const made = await gh(['api', `repos/${fork}/git/refs`, '-f', `ref=refs/heads/${branch}`, '-f', `sha=${sha}`])
  if (!made.ok) return { failed: `在 ${fork} 上建分支 ${branch} 没成（fork 刚建好时要等一会儿）` }

  const content = Buffer.from(JSON.stringify(c, null, 2) + '\n').toString('base64')
  const put = await gh([
    'api', `repos/${fork}/contents/${contributionPath(c)}`,
    '-X', 'PUT',
    '-f', `message=${contributionTitle(c)}`,
    '-f', `branch=${branch}`,
    '-f', `content=${content}`,
  ])
  if (!put.ok) return { failed: `往分支里放 ${contributionPath(c)} 没成` }

  const pr = await gh(['pr', 'create', '--repo', target.repo, '--head', head, '--title', contributionTitle(c), '--body', contributionBody(c)])
  return pr.ok && pr.out.trim() ? { url: pr.out.trim() } : { failed: 'gh pr create 没成' }
}

export async function runRecipeContributeCommand(
  cmd: { kind: 'recipe-contribute'; sourceId: string; step?: string; area?: string },
  deps: RecipeContributeDeps = {},
): Promise<number> {
  const log = deps.log ?? ((s: string) => void process.stdout.write(`${s}\n`))
  const gh = deps.gh ?? defaultGh
  const open = deps.open ?? defaultOpen
  const dataDir = deps.dataDir ?? defaultDataDir()
  const found = findRecipePackage([join(dataDir, 'recipes'), builtinDirNear(deps.selfEntry) ?? ''], cmd.sourceId)
  if (!found) {
    log(`stream: 找不到 recipe "${cmd.sourceId}"（在 ${join(dataDir, 'recipes')} 和内置包里都没有 ${cmd.sourceId}.recipe.json）`)
    return 1
  }
  const target = contributeTarget(found.packageJson)
  if (!target) {
    log(`stream: 这个包没开放贡献（${join(found.dir, 'package.json')} 缺 repository 或 stream.contribute.path）`)
    return 1
  }
  const pkg = { name: String(found.packageJson.name ?? 'local'), version: String(found.packageJson.version ?? '0') }
  // 包里那份 recipe 是去模板化那道闸的基准（见 `buildContributions`）。读不出来就停——
  // 没有基准就没有闸，而"闸跑不起来"和"闸放行了"在日志里长得一模一样。
  let recipeJson: Record<string, unknown>
  try {
    recipeJson = JSON.parse(readFileSync(found.recipePath, 'utf8')) as Record<string, unknown>
  } catch (e) {
    log(`stream: 读不出 ${found.recipePath}（${(e as Error).message}）——它是去模板化检查的基准，不读它就不能贡献`)
    return 1
  }
  const store = new RecipeOverrideStore(join(dataDir, 'recipe-overrides'))
  const cs = buildContributions(store, cmd.sourceId, recipeJson, pkg, deps.streamVersion ?? 'dev', { step: cmd.step, area: cmd.area }, log)
  if (cs.length === 0) {
    log(`stream: "${cmd.sourceId}"${cmd.step !== undefined || cmd.area !== undefined ? subject(cmd) : ''} 没有可贡献的落地方式——要 ≥3 次成功运行、跨 ≥2 天、且是本机学到的（不是包里自带的）`)
    return 1
  }
  const ghOk = (await gh(['auth', 'status'])).ok
  for (const c of cs) {
    if (ghOk) {
      const pr = await pullRequest(gh, target, c)
      if ('url' in pr) {
        log(`已开 PR：${pr.url}`)
        continue
      }
      log(`gh 这条路没走通（${pr.failed}），改走 issue 链接`)
    }
    const url = issueUrl(target, c)
    if (url.length > ISSUE_URL_MAX) {
      const dir = join(dataDir, 'recipe-overrides')
      // 文件名必须带哈希：一轮里可能有好几条都超长，按 recipe 命名的话它们互相覆盖，
      // 而日志对每一条都说了「已写到 <p>」——说过的话和磁盘上的事实不符，没有一处会喊。
      const p = join(dir, `${c.recipe}.${contributionHash(c)}.contribution.md`)
      mkdirSync(dir, { recursive: true })
      writeFileSync(p, `${contributionTitle(c)}\n\n${contributionBody(c)}\n`)
      const blank = `https://github.com/${target.repo}/issues/new?labels=recipe-contribution`
      log(`贡献物太长装不进链接，已写到 ${p}——把它贴进这个 issue：${blank}`)
      open(blank)
    } else {
      log(`打开预填好的 issue（按一下提交就行）：${url}`)
      open(url)
    }
  }
  return 0
}
