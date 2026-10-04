// 作者侧：把一个 issue / PR 里的贡献物（`stream recipe contribute` 生成）合进包里的 recipe。
//   pnpm recipe:absorb <issue 或 PR 号>
// 四种情形（spec §6.5）：同 on 同 body → 只合并 verified；同 on 异 body → 并列；没有 → 插入；
// 找不到 label → 拒。贡献物指向一步（`step`）或一块具名区域（`area`，spec §3.4），两者恰给一个，
// 四种情形对二者完全一样。写回后由作者跑 recipe 守卫测试并提交——这个脚本不 commit。
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const TOP_ONLY = ['label', 'intent', 'expect', 'require', 'else', 'optional', 'blind', 'skipIf', 'groundings']
const META = ['on', 'verified', 'note', 'ref', 'origin', 'shadowed']

export function extractContribution(body) {
  const m = /```json\s*\n([\s\S]*?)\n```/.exec(body)
  const text = m ? m[1] : body
  try { return JSON.parse(text) } catch { throw new Error('正文里没有可解析的 JSON 块（要有 ```json … ``` 或整段就是 JSON）') }
}

export function validateContribution(c) {
  for (const k of ['recipe', 'package', 'stream', 'grounding', 'verified']) if (c?.[k] === undefined) throw new Error(`贡献物缺 ${k}`)
  // 一条落地方式要么属于某一步，要么属于某块具名区域（spec §3.4）。两个都给 / 都不给都不许猜。
  if ((c.step === undefined) === (c.area === undefined)) throw new Error('贡献物的 step 和 area 只能给一个')
  if (!c.grounding.on || typeof c.grounding.on !== 'object') throw new Error('grounding 缺 on')
  for (const k of TOP_ONLY) if (c.grounding[k] !== undefined) throw new Error(`grounding 里不许有 ${k}（只能在顶层）`)
  // 区域的 body 只有 region。多出来的键（kind / at / text…）要么是拿步骤的 payload 冒充区域，
  // 要么是把判据塞了进来——两种都不该落进 areas。
  if (c.area !== undefined) for (const k of Object.keys(c.grounding)) if (!META.includes(k) && k !== 'region') throw new Error(`区域的落地方式只许有 region，多了 ${k}`)
  for (const k of ['runs', 'first', 'last', 'by']) if (c.verified[k] === undefined) throw new Error(`verified 缺 ${k}`)
}

const canonical = (v) => Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v)
const body = (g) => Object.fromEntries(Object.entries(g).filter(([k]) => !META.includes(k) && !TOP_ONLY.includes(k)))
const sameKey = (a, b) => a.platform === b.platform && (a.lang ?? '') === (b.lang ?? '') && (a.app ?? '') === (b.app ?? '')

export function absorbContribution(recipeJson, c, ref) {
  validateContribution(c)
  const recipe = JSON.parse(JSON.stringify(recipeJson))
  // 贡献物指向的那个宿主：某一步，或顶层 areas 里那块区域（spec §3.4）。四种情形完全一样。
  const host = c.area !== undefined
    ? (Object.hasOwn(recipe.areas ?? {}, c.area) ? recipe.areas[c.area] : undefined)
    : recipe.steps.find((s) => s.label === c.step)
  if (!host) throw new Error(c.area !== undefined ? `recipe "${c.recipe}" 里没有名为「${c.area}」的区域` : `recipe "${c.recipe}" 里没有 label 为「${c.step}」的步骤`)
  host.groundings ??= []
  const incoming = { ...c.grounding, verified: { ...c.verified, by: 'contributed' }, ref }
  const same = host.groundings.find((g) => sameKey(g.on, incoming.on) && canonical(body(g)) === canonical(body(incoming)))
  if (same) {
    same.verified = {
      runs: (same.verified?.runs ?? 0) + c.verified.runs,
      first: [same.verified?.first, c.verified.first].filter(Boolean).sort()[0],
      last: [same.verified?.last, c.verified.last].filter(Boolean).sort().at(-1),
      by: 'contributed',
    }
    same.ref = same.ref ? `${same.ref} ${ref}` : ref
    return { recipe, action: 'merged-verified' }
  }
  const covered = host.groundings.some((g) => sameKey(g.on, incoming.on))
  host.groundings.push(incoming)
  return { recipe, action: covered ? 'appended' : 'inserted' }
}

/**
 * PR 正文没有 JSON 块时的退路：`stream recipe contribute` 建的 PR 还带一个
 * `contributions/<recipe>/<platform>-<hash>.json` 文件，从 `gh pr diff` 的输出里把它的
 * 新增内容（`+` 行）拼回去。只认新建文件的 `+++ b/contributions/....json` 头，取该 hunk 里
 * 所有 `+` 行（去掉前导 `+`），下一个 `+++`/`diff --git` 出现就换到下一个候选文件。
 */
export function contributionFromPrDiff(diffText) {
  const lines = diffText.split('\n')
  let matching = false
  let collected = []
  const tryParse = () => {
    if (!collected.length) return undefined
    try { return JSON.parse(collected.join('\n')) } catch { return undefined }
  }
  for (const line of lines) {
    if (line.startsWith('+++ ')) {
      const parsed = tryParse()
      if (parsed !== undefined) return parsed
      const path = line.slice(4).trim().replace(/^b\//, '')
      matching = /^contributions\/.*\.json$/.test(path)
      collected = []
      continue
    }
    if (line.startsWith('diff --git')) { matching = false; collected = []; continue }
    if (matching && line.startsWith('+') && !line.startsWith('+++')) collected.push(line.slice(1))
  }
  return tryParse()
}

/** 在 packages/ 下找 `package.json#name` 等于贡献物里那个包的目录。 */
function findPackageDir(root, name) {
  for (const d of readdirSync(root)) {
    const pj = join(root, d, 'package.json')
    if (existsSync(pj) && JSON.parse(readFileSync(pj, 'utf8')).name === name) return join(root, d)
  }
  return undefined
}

export async function main(argv, deps = {}) {
  const n = argv[0]
  if (!n) { console.error('用法：pnpm recipe:absorb <issue 或 PR 号>'); return 2 }
  const gh = deps.gh ?? ((args) => execFileSync('gh', args, { encoding: 'utf8' }))
  let text
  let isPr = false
  try { text = JSON.parse(gh(['issue', 'view', n, '--json', 'body'])).body } catch { text = JSON.parse(gh(['pr', 'view', n, '--json', 'body'])).body; isPr = true }
  let c
  try {
    c = extractContribution(text)
  } catch (err) {
    // issue 正文本来就该有 JSON 块；PR 那条路才有「贡献物落在附带文件里、正文没有」的可能，
    // 所以只在 PR 分支兜底去读 diff，issue 分支照旧把原错误抛出去。
    if (!isPr) throw err
    const diff = gh(['pr', 'diff', n])
    const fromDiff = contributionFromPrDiff(diff)
    if (fromDiff === undefined) throw err
    c = fromDiff
  }
  validateContribution(c)
  const root = deps.packagesRoot ?? join(process.cwd(), 'packages')
  const pkgDir = findPackageDir(root, c.package.name)
  if (!pkgDir) { console.error(`packages/ 下没有 name 为 ${c.package.name} 的包`); return 1 }
  const pj = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  const rel = pj.stream?.contribute?.path
  if (!rel) { console.error(`${c.package.name} 的 package.json 没有 stream.contribute.path`); return 1 }
  const repoRoot = deps.repoRoot ?? process.cwd()
  const file = join(repoRoot, rel)
  const { recipe, action } = absorbContribution(JSON.parse(readFileSync(file, 'utf8')), c, `#${n}`)
  writeFileSync(file, JSON.stringify(recipe, null, 2) + '\n')
  // **指的必须是真会校验这份 recipe 的那道闸。** `loader.real.test.ts` 只数包、不调
  // `validateRecipe`：一条 `on` 范围写坏、把 `{contact}` 写死成人名、或带了顶层专属键的贡献物
  // 照样能绿着走进发行包。`recipe-store.shipped.test.ts` 把出货的桌面 recipe 逐份喂进
  // `validateRecipe`，是唯一能把这三种拦下来的那一个。
  const who = c.area !== undefined ? `区域「${c.area}」` : `「${c.step}」`
  console.log(`${action}: ${rel} ${who} ${JSON.stringify(c.grounding.on)}；现在跑 node_modules/.bin/vitest run src/replay/recipe-store.shipped.test.ts 再提交`)
  return 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = await main(process.argv.slice(2))
