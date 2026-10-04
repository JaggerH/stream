/**
 * **来路标注**（`origin`）：每条建议是**怎么来的**——从权威清单出发（某一集去找自己的文件），
 * 还是从网盘文件出发（没有集认领它，只能从它自己的证据边反推）。
 *
 * 这一层是**纯标注**：它只把 `plan.ts` 各个产出点本来就知道的事实标出来，一条动作的
 * kind / 目标 / 判定结果都不许因此改变。本文件的第二节（回归护栏）就是钉这一条的——
 * 除 `origin` 外的全部输出与标注前逐字相同，靠外置快照守。
 */
import { describe, it, expect } from 'vitest'
import { buildPlan, type PlanInput, type PlanOutcome } from './plan.ts'
import { makeIdentity } from '../identity.ts'
import { DEFAULT_MATCH_SPEC } from '../match-spec.ts'
import { OPENLIST_TRAITS } from '../shelf.ts'

// size 参数的单位是 **MiB**（同 `plan.test.ts`）：不足 `MIN_MEDIA_BYTES`（1 MiB）的文件只进待探。
const f = (path: string, sizeMiB = 100, durationS?: number) =>
  ({ path, name: path.split('/').pop()!, size: sizeMiB * 1024 * 1024, durationS })

const YILE_RULES = {
  titleStrip: ['^怡[乐楽樂](?:播客|电台)?\\s*[-–—·]\\s*'],
  epNumRegex: '^(\\d{3})\\.',
}
const identity = makeIdentity(YILE_RULES)

function base(): PlanInput {
  return {
    identity,
    matchSpec: DEFAULT_MATCH_SPEC,
    authority: [
      { leftKey: 'L750', title: '750.探秘人体特殊实验', durationS: 1000 },
      { leftKey: 'L454', title: '454.现代版枪下留人', durationS: 2605 },
    ],
    sourceFiles: [], libClaimedFiles: [], libSecondaryFiles: [],
    subShows: [{ name: '玄关笔记', dir: '/lib/付费/玄关笔记', numPattern: /^\d{2}\./ }],
    dirs: { claimed: '/lib/付费', secondary: '/lib/下架' },
    verdictFor: () => null,
    shelf: OPENLIST_TRAITS,
  }
}

/** 主池 + 下架复核两处账本行合起来找——`origin` 两边都得有。 */
const allRows = (out: PlanOutcome) => [...out.rows, ...out.secondaryReview.rows]
const rowFor = (out: PlanOutcome, path: string) => allRows(out).find((r) => r.path === path)!
const actionFor = (out: PlanOutcome, path: string) => out.actions.find((a) => a.src.path === path)!

// ───────────────────────────────────────────────────────────────────────────
// ① 归类：每一种 basis 形状各自标出正确的 origin
// ───────────────────────────────────────────────────────────────────────────

describe('从权威清单出发（authority）：某一集认领了它', () => {
  it('authority:<leftKey> —— 匹配器把这份文件认成节目单里的这一集', () => {
    const out = buildPlan({ ...base(), sourceFiles: [f('/src/750.探秘人体特殊实验.mp3', 100, 1000)] })
    const row = rowFor(out, '/src/750.探秘人体特殊实验.mp3')
    expect(row.basis).toBe('authority:L750')
    expect(row.origin).toBe('authority')
    expect(actionFor(out, '/src/750.探秘人体特殊实验.mp3').origin).toBe('authority')
  })

  it('redundant-free:<leftKey> —— 认领成立、那一集源站自己放得出 → 删', () => {
    const out = buildPlan({
      ...base(),
      authority: [{ leftKey: 'LF', title: '600.免费那一集', durationS: 1500, paid: false, needsSupply: false }],
      sourceFiles: [f('/src/600.免费那一集.mp3', 100, 1500)],
    })
    const row = rowFor(out, '/src/600.免费那一集.mp3')
    expect(row.basis).toBe('redundant-free:LF')
    expect(row.origin).toBe('authority')
    expect(actionFor(out, '/src/600.免费那一集.mp3').origin).toBe('authority')
  })

  it('same-episode-copy:<leftKey> —— 匹配器认出它是那一集的其余份', () => {
    const DUR = 6043
    const out = buildPlan({
      ...base(),
      authority: [
        { leftKey: 'L756', title: '756.先来的那一集', durationS: DUR },
        { leftKey: 'L037', title: '37.申与酉', durationS: DUR },
      ],
      libClaimedFiles: [f('/lib/付费/756.先来的那一集.mp3', 999, DUR), f('/lib/付费/37.申与酉.mp3', 999, DUR)],
      sourceFiles: [f('/src/37.申与酉.mp3', 100, DUR + 1)],
    })
    const row = rowFor(out, '/src/37.申与酉.mp3')
    expect(row.basis).toBe('same-episode-copy:L037')
    expect(row.origin).toBe('authority')
    expect(actionFor(out, '/src/37.申与酉.mp3').origin).toBe('authority')
  })

  it('ambiguous:<reason>:<leftKey> —— 某一集有候选但不敢认 → 问人', () => {
    const out = buildPlan({ ...base(), sourceFiles: [f('/src/601.毫不相干的一集.mp3', 100, 2605)] })
    const row = rowFor(out, '/src/601.毫不相干的一集.mp3')
    expect(row.basis).toBe('ambiguous:name-floor:L454')
    expect(row.origin).toBe('authority')
    expect(actionFor(out, '/src/601.毫不相干的一集.mp3').origin).toBe('authority')
  })

  // 下架货架复核那一趟整趟都是集侧发问的（只消费 `assignments` = 某一集认领了货架上这份）。
  it('下架复核三条（relisted / shelf-copy-of / redundant-free）都是集侧', () => {
    const PAID = { leftKey: 'LP', title: '801.付费那一集', durationS: 1600, paid: true }
    const FREE = { leftKey: 'LF', title: '600.免费那一集', durationS: 1500, paid: false, needsSupply: false }

    const relisted = buildPlan({
      ...base(), authority: [PAID], libSecondaryFiles: [f('/lib/下架/801.付费那一集.mp3', 100, 1600)],
    })
    expect(rowFor(relisted, '/lib/下架/801.付费那一集.mp3')).toMatchObject({ basis: 'relisted:LP', origin: 'authority' })
    expect(actionFor(relisted, '/lib/下架/801.付费那一集.mp3').origin).toBe('authority')

    const shelfCopy = buildPlan({
      ...base(), authority: [PAID],
      libClaimedFiles: [f('/lib/付费/801.付费那一集.mp3', 200, 1600)],
      libSecondaryFiles: [f('/lib/下架/801.付费那一集（补档）.mp3', 100, 1600)],
    })
    expect(rowFor(shelfCopy, '/lib/下架/801.付费那一集（补档）.mp3'))
      .toMatchObject({ basis: 'shelf-copy-of:/lib/付费/801.付费那一集.mp3', origin: 'authority' })

    const shelfFree = buildPlan({
      ...base(), authority: [FREE], libSecondaryFiles: [f('/lib/下架/600.免费那一集.mp3', 100, 1500)],
    })
    expect(rowFor(shelfFree, '/lib/下架/600.免费那一集.mp3')).toMatchObject({ basis: 'redundant-free:LF', origin: 'authority' })
    expect(actionFor(shelfFree, '/lib/下架/600.免费那一集.mp3').origin).toBe('authority')
  })
})

describe('从网盘文件出发（file）：没有集认领它，只能从它自己的证据边反推', () => {
  it('redundant-free-candidates:<keys> —— 没集要它、证据指着的那几集都不需供货 → 删', () => {
    const free = (leftKey: string, title: string) => ({ leftKey, title, durationS: 3000, paid: false, needsSupply: false })
    const COLLIDE = f('/src/玄关笔记/37.申与酉.mp3', 100, 3000)
    const out = buildPlan({
      ...base(), authority: [free('L037', '037.三谈身边灵异事'), free('L038', '038.四谈身边灵异事')],
      sourceFiles: [COLLIDE],
    })
    expect(rowFor(out, COLLIDE.path)).toMatchObject({ basis: 'redundant-free-candidates:L037,L038', origin: 'file' })
    expect(actionFor(out, COLLIDE.path).origin).toBe('file')
  })

  it('evidence-conflict:<keys> —— 没集要它、边指向好几集 → 问人', () => {
    const STRANGER = '/lib/付费/玄关笔记/37.申与酉.mp3'
    const out = buildPlan({
      ...base(),
      authority: [
        { leftKey: 'L756', title: '756.大家都焦虑的这么具体了吗？', durationS: 6043, paid: true },
        { leftKey: 'L037', title: '37.申与酉', durationS: 2041, paid: true },
      ],
      libClaimedFiles: [f('/lib/付费/756.大家都焦虑的这么具体了吗？.mp3', 92, 6044), f(STRANGER, 231, 6044)],
      sourceFiles: [f('/src/玄关笔记/37.申与酉【公众号】.mp3', 31, 2041)],
    })
    expect(rowFor(out, STRANGER)).toMatchObject({ basis: 'evidence-conflict:L037,L756', origin: 'file' })
    expect(actionFor(out, STRANGER).origin).toBe('file')
  })

  it('no-duration-hit:<n>s —— 没集要它、边也没有 → 下架', () => {
    const out = buildPlan({ ...base(), sourceFiles: [f('/src/092.穿衣服.mp3', 100, 777)] })
    expect(rowFor(out, '/src/092.穿衣服.mp3')).toMatchObject({ basis: 'no-duration-hit:777s', origin: 'file' })
    expect(actionFor(out, '/src/092.穿衣服.mp3').origin).toBe('file')
  })

  it('no-duration —— 时长还没探到', () => {
    const out = buildPlan({ ...base(), sourceFiles: [f('/src/092.穿衣服.mp3')] })
    expect(rowFor(out, '/src/092.穿衣服.mp3')).toMatchObject({ basis: 'no-duration', origin: 'file' })
    expect(actionFor(out, '/src/092.穿衣服.mp3').origin).toBe('file')
  })

  // 上表之外、`plan.ts` 里真实存在的另外三个产出点。判据同一条：**没有任何一集认领它**，
  // 推理起点是这份文件自己（字节数 / 人对这份文件的裁定 / 判决层对它的终态）。
  it('size-dup-of:<path> —— 字节全等，判据是这两份文件自己（跑在匹配器之前）', () => {
    const EP = '600.那一集.mp3'
    const out = buildPlan({
      ...base(), authority: [{ leftKey: 'L600', title: '600.那一集', durationS: 1500 }],
      libClaimedFiles: [f(`/lib/付费/${EP}`, 100, 1500)],
      sourceFiles: [f(`/src/${EP}`, 100, 1500)],
    })
    expect(rowFor(out, `/src/${EP}`)).toMatchObject({ basis: `size-dup-of:/lib/付费/${EP}`, origin: 'file' })
    expect(actionFor(out, `/src/${EP}`).origin).toBe('file')
  })

  it('decision:exempt —— 人对这份文件的身份键裁过豁免（无动作，只有账本行）', () => {
    const out = buildPlan({ ...base(), sourceFiles: [f('/src/092.穿衣服.mp3', 100, 777)], verdictFor: () => 'exempt' })
    expect(rowFor(out, '/src/092.穿衣服.mp3')).toMatchObject({ basis: 'decision:exempt', origin: 'file' })
  })

  it('decision:not-episode:<keys> —— 人答过"不是这一集"，此后没有集要它 → 下架', () => {
    const STRANGER = '/lib/付费/玄关笔记/37.申与酉.mp3'
    const out = buildPlan({
      ...base(),
      authority: [
        { leftKey: 'L756', title: '756.大家都焦虑的这么具体了吗？', durationS: 6043, paid: true },
        { leftKey: 'L037', title: '37.申与酉', durationS: 2041, paid: true },
      ],
      libClaimedFiles: [f(STRANGER, 231, 6044)],
      sourceFiles: [f('/src/玄关笔记/37.申与酉【公众号】.mp3', 31, 2041)],
      notEpisode: (leftKey, path) => leftKey === 'L756' && path === STRANGER,
    })
    expect(rowFor(out, STRANGER)).toMatchObject({ basis: 'decision:not-episode:L756', origin: 'file' })
    expect(actionFor(out, STRANGER).origin).toBe('file')
  })
})

describe('标注跟着判定走，不被后续改写吞掉', () => {
  // suspect-dir 熔断把**已有的**动作整批降级成 pending。它换的是处置，不是来路——
  // 降级后那条卡照旧要说清"这建议本来是怎么来的"。
  it('suspect-dir 降级后 origin 原样保留', () => {
    const dir = '/src/别的播客'
    const out = buildPlan({
      ...base(),
      sourceFiles: [1, 2, 3, 4, 5, 6].map((i) => f(`${dir}/无关${i}.mp3`, 100 + i, 700 + i)),
      sourceDirs: [dir],
    })
    const a = actionFor(out, `${dir}/无关1.mp3`)
    expect(a).toMatchObject({ kind: 'pending', pendingKind: 'suspect-dir' })
    expect(a.origin).toBe('file')
    expect(rowFor(out, `${dir}/无关1.mp3`).origin).toBe('file')
  })

  it('账本行与动作的 origin 永远一致（同一条判定的两个面）', () => {
    for (const [name, input] of scenarios()) {
      const out = buildPlan(input)
      const byPath = new Map(allRows(out).map((r) => [r.path, r.origin]))
      for (const a of out.actions) {
        expect(a.origin, `${name} → ${a.src.path}`).toBe(byPath.get(a.src.path))
      }
    }
  })

  it('每一条账本行、每一条动作都带 origin —— 没有"不知道来路"的建议', () => {
    for (const [name, input] of scenarios()) {
      const out = buildPlan(input)
      for (const r of allRows(out)) expect(r.origin, `${name} row ${r.path}`).toMatch(/^(authority|file)$/)
      for (const a of out.actions) expect(a.origin, `${name} action ${a.src.path}`).toMatch(/^(authority|file)$/)
    }
  })
})

// ───────────────────────────────────────────────────────────────────────────
// ② 回归护栏：加标注前后，除 origin 外的输出逐字不变
// ───────────────────────────────────────────────────────────────────────────

/** 覆盖 `plan.ts` 全部 decision 产出点的一组现状。**顺序与内容都不许随手改**——
 *  快照就是标注前那一版的输出，改了 fixture 等于换了体检对象。 */
function scenarios(): [string, PlanInput][] {
  const DUR = 6043
  const twins = [
    { leftKey: 'L756', title: '756.先来的那一集', durationS: DUR },
    { leftKey: 'L037', title: '37.申与酉', durationS: DUR },
  ]
  const STRANGER = '/lib/付费/玄关笔记/37.申与酉.mp3'
  const live = () => ({
    authority: [
      { leftKey: 'L756', title: '756.大家都焦虑的这么具体了吗？', durationS: 6043, paid: true },
      { leftKey: 'L037', title: '37.申与酉', durationS: 2041, paid: true },
    ],
    libClaimedFiles: [f('/lib/付费/756.大家都焦虑的这么具体了吗？.mp3', 92, 6044), f(STRANGER, 231, 6044)],
    sourceFiles: [f('/src/玄关笔记/37.申与酉【公众号】.mp3', 31, 2041)],
  })
  const FREE = { leftKey: 'LF', title: '600.免费那一集', durationS: 1500, paid: false, needsSupply: false }
  const PAID = { leftKey: 'LP', title: '801.付费那一集', durationS: 1600, paid: true }

  return [
    ['认领搬入', { ...base(), sourceFiles: [f('/src/750.探秘人体特殊实验.mp3', 100, 1000)] }],
    ['免费集副本判删', { ...base(), authority: [FREE], sourceFiles: [f('/src/600.免费那一集.mp3', 100, 1500)] }],
    ['同集其余份', {
      ...base(), authority: twins,
      libClaimedFiles: [f('/lib/付费/756.先来的那一集.mp3', 999, DUR), f('/lib/付费/37.申与酉.mp3', 999, DUR)],
      sourceFiles: [f('/src/37.申与酉.mp3', 100, DUR + 1)],
    }],
    ['集侧问句 duration-collision', { ...base(), sourceFiles: [f('/src/601.毫不相干的一集.mp3', 100, 2605)] }],
    ['文件侧冲突卡', { ...base(), ...live() }],
    ['文件侧冲突卡 + 人已答全', { ...base(), ...live(), notEpisode: (k: string, p: string) => p === STRANGER && (k === 'L037' || k === 'L756') }],
    ['集侧问句 + 人已答', {
      ...base(), ...live(), libClaimedFiles: [f(STRANGER, 231, 6044)],
      notEpisode: (k: string, p: string) => k === 'L756' && p === STRANGER,
    }],
    ['候选全免费 → 不出卡直接删', {
      ...base(),
      authority: [
        { leftKey: 'L037', title: '037.三谈身边灵异事', durationS: 3000, paid: false, needsSupply: false },
        { leftKey: 'L038', title: '038.四谈身边灵异事', durationS: 3000, paid: false, needsSupply: false },
      ],
      sourceFiles: [f('/src/玄关笔记/37.申与酉.mp3', 100, 3000)],
    }],
    ['残差下架', { ...base(), sourceFiles: [f('/src/092.穿衣服.mp3', 100, 777)] }],
    ['时长未探到', { ...base(), sourceFiles: [f('/src/092.穿衣服.mp3')] }],
    ['字节全等重复', {
      ...base(), authority: [{ leftKey: 'L600', title: '600.那一集', durationS: 1500 }],
      libClaimedFiles: [f('/lib/付费/600.那一集.mp3', 100, 1500)],
      sourceFiles: [f('/src/600.那一集.mp3', 100, 1500)],
    }],
    ['人工豁免', { ...base(), sourceFiles: [f('/src/092.穿衣服.mp3', 100, 777)], verdictFor: () => 'exempt' as const }],
    ['下架复核：回流', { ...base(), authority: [PAID], libSecondaryFiles: [f('/lib/下架/801.付费那一集.mp3', 100, 1600)] }],
    ['下架复核：货架副本', {
      ...base(), authority: [PAID],
      libClaimedFiles: [f('/lib/付费/801.付费那一集.mp3', 200, 1600)],
      libSecondaryFiles: [f('/lib/下架/801.付费那一集（补档）.mp3', 100, 1600)],
    }],
    ['下架复核：免费集', { ...base(), authority: [FREE], libSecondaryFiles: [f('/lib/下架/600.免费那一集.mp3', 100, 1500)] }],
    ['目录熔断', {
      ...base(),
      sourceFiles: [1, 2, 3, 4, 5, 6].map((i) => f(`/src/别的播客/无关${i}.mp3`, 100 + i, 700 + i)),
      sourceDirs: ['/src/别的播客'],
    }],
    ['没有第二货架（影视）', {
      ...base(), dirs: { claimed: '/lib/付费' }, sourceFiles: [f('/src/092.穿衣服.mp3', 100, 777)],
    }],
  ]
}

/** 深度剥掉 `origin`（以及**只有**它）——留下的每一个字节都必须与标注前一致。 */
function stripOrigin(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripOrigin)
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([k]) => k !== 'origin')
        .map(([k, x]) => [k, stripOrigin(x)]),
    )
  }
  return v
}

describe('纯标注：除 origin 外的输出逐字不变', () => {
  // 快照是在**标注落地之前**跑出来的（characterization test）：它记的是老行为。
  // 之后任何一条动作的 kind / 目标 / 判定 / 理由改了形状，这里当场红。
  it('全部场景的 actions / rows / counts / 守恒 / 下架复核', () => {
    const dump = scenarios().map(([name, input]) => {
      const out = buildPlan(input)
      return [name, stripOrigin({
        actions: out.actions,
        rows: out.rows.map((r) => ({ ...r, explain: undefined })),
        counts: out.counts,
        conservation: out.conservation,
        authority: out.authority,
        secondaryReview: {
          checked: out.secondaryReview.checked,
          rows: out.secondaryReview.rows.map((r) => ({ ...r, explain: undefined })),
        },
      })]
    })
    expect(dump).toMatchSnapshot()
  })
})
