import { describe, it, expect } from 'vitest'
import { buildPlan, type PlanAction, type PlanInput, type RFile } from './plan.ts'
import { makeIdentity } from '../identity.ts'
import { DEFAULT_MATCH_SPEC } from '../match-spec.ts'
import { OPENLIST_TRAITS } from '../shelf.ts'
import { resultFrom } from '../match-engine/adapt.ts'

// size 参数的单位是 **MiB**：真实媒体文件都在 MiB 量级，而不足 `MIN_MEDIA_BYTES`（1 MiB）的一律
// 判 `size-suspect` 只进待探。夹具里写 `100`/`200` 是为了读着清爽，进 buildPlan 时换算成字节。
const f = (path: string, sizeMiB = 100, durationS?: number) =>
  ({ path, name: path.split('/').pop()!, size: sizeMiB * 1024 * 1024, durationS })

// 怡乐命名的等价规则——fixture 全按它写的（identity 只做分组键：豁免 + 字节全等判同集）
const YILE_RULES = {
  titleStrip: ['^怡[乐楽樂](?:播客|电台)?\\s*[-–—·]\\s*'],
  epNumRegex: '^(\\d{3})\\.',
}
const identity = makeIdentity(YILE_RULES)

function base(): PlanInput {
  return {
    identity,
    matchSpec: DEFAULT_MATCH_SPEC, // 与绑定同步同一份谱——归档器不许有第二个脑（spec P7）
    authority: [
      { leftKey: 'L750', title: '750.探秘人体特殊实验', durationS: 1000 },
      { leftKey: 'L091', title: '091.前一集', durationS: 1100 },
      { leftKey: 'L093', title: '093.后一集', durationS: 1200 },
      { leftKey: 'L454', title: '454.现代版枪下留人', durationS: 2605 },
    ],
    sourceFiles: [], libClaimedFiles: [], libSecondaryFiles: [],
    subShows: [{ name: '玄关笔记', dir: '/lib/付费/玄关笔记', numPattern: /^\d{2}\./ }],
    dirs: { claimed: '/lib/付费', secondary: '/lib/下架' },
    verdictFor: () => null,
    shelf: OPENLIST_TRAITS,
  }
}

const actions = (input: PlanInput): PlanAction[] => buildPlan(input).actions
const rowFor = (input: PlanInput, path: string) => buildPlan(input).rows.find((r) => r.path === path)!

describe('一个匹配脑：buildPlan 只消费匹配器的判决（spec §3）', () => {
  it('文件名对得上清单 → 认领,搬进付费货架', () => {
    const input = { ...base(), sourceFiles: [f('/src/750.探秘人体特殊实验.mp3')] }
    expect(actions(input)).toEqual([
      expect.objectContaining({ kind: 'move', dstDir: '/lib/付费', basis: 'authority:L750' }),
    ])
    expect(rowFor(input, '/src/750.探秘人体特殊实验.mp3')).toMatchObject({ verdict: 'claimed', episode: '750.探秘人体特殊实验' })
  })

  it('没被认领 + 时长已知 + 时长和名字都与清单不沾 → 下架货架（默认且安全,不是问句）', () => {
    const input = { ...base(), sourceFiles: [f('/src/092.穿衣服.mp3', 100, 777)] }
    expect(actions(input)[0]).toMatchObject({ kind: 'move', dstDir: '/lib/下架' })
    expect(rowFor(input, '/src/092.穿衣服.mp3')).toMatchObject({ verdict: 'offline', basis: 'no-duration-hit:777s' })
  })

  // 名字关卡（活体 2026-07-30:780/796 库内那份多 5 秒尾巴,正身已由来源那份认领）:
  // 时长谁都不沾、但认集身份指向清单里的某一集 → 它是那一集的副本/另一版,唯一议题是替换,
  // **不是**"没配上"——扔下架会变成和 feed 撞名的独立集,违反步 4"默认不重复"。
  // 长度差 5 秒 = compareQuality 判 incomparable（不是同一份内容,码率没法比）→ 质量分不出高下,
  // 方向交给节目单裁：节目单 8274s,来源那份严丝合缝、库内那份多 5 秒 → 删库内那份
  // （`authority-duration:`）,不是反过来。确认档,定时轮不执行。
  it('名字指向已认领的集、时长差出容差 → 删离节目单更远的那份,不进下架', () => {
    const A780 = { leftKey: 'L780', title: '780.四十五谈身边灵异事', durationS: 8274, paid: true, needsSupply: true }
    const input = {
      ...base(), authority: [...base().authority, A780],
      sourceFiles: [f('/src/780.四十五谈身边灵异事【耗时整理】.mp3', 100, 8274)], // 正身,认领
      libClaimedFiles: [f('/lib/付费/780.四十五谈身边灵异事.mp3', 200, 8279)],       // 尾巴副本
    }
    const out = buildPlan(input)
    // 来源那份认领成立,但货架上还压着同集的尾巴副本（文件名带【】装饰、字面不同名）——
    // 同集占位护栏照样拦成 swap-hold：默认不重复（步 4）,裁掉副本后下一轮自然落位。
    // 活体 2026-07-30:同名的 796 被字面比对拦住了,装饰名的 780/05/37 漏过去差点一集两份。
    expect(rowFor(input, '/src/780.四十五谈身边灵异事【耗时整理】.mp3')).toMatchObject({ verdict: 'claimed', basis: 'authority:L780', action: 'pending:swap-hold' })
    expect(out.actions.some((a) => a.kind === 'move')).toBe(false)
    // 理由里点名占位者——用户对着 swap-hold 行要能知道"等的是哪份"
    const hold = out.actions.find((a) => a.kind === 'pending' && a.pendingKind === 'swap-hold') as Extract<PlanAction, { kind: 'pending' }>
    expect(hold.reason).toContain('780.四十五谈身边灵异事.mp3')
    const copyRow = rowFor(input, '/lib/付费/780.四十五谈身边灵异事.mp3')
    expect(copyRow).toMatchObject({ verdict: 'copy', basis: 'same-episode-copy:L780', episode: '780.四十五谈身边灵异事' })
    // 质量比不出（差 5 秒,码率没法比）→ 第 1 档裁：删离节目单更远的库内那份,留严丝合缝的来源那份。
    // 绝不是"副本一律上位"——那会删掉和节目单一致的那份,方向纯靠遍历运气。
    const drop = out.actions.find((a) => a.kind === 'delete-loser') as Extract<PlanAction, { kind: 'delete-loser' }>
    expect(drop).toMatchObject({
      src: expect.objectContaining({ path: '/lib/付费/780.四十五谈身边灵异事.mp3' }),
      keptPath: '/src/780.四十五谈身边灵异事【耗时整理】.mp3',
      basis: 'authority-duration:/lib/付费/780.四十五谈身边灵异事.mp3', // basis 指着被删的那份
    })
    expect(out.actions.some((a) => a.kind === 'replace')).toBe(false)
    // 对照里两份都在 + 节目单时长（裁判在场）:用户点确认前要看得见"凭什么删这份"
    expect(drop.compare!.authorityDurationS).toBe(8274)
    const paths = drop.compare!.candidates.map((c) => c.path).sort()
    expect(paths).toEqual(['/lib/付费/780.四十五谈身边灵异事.mp3', '/src/780.四十五谈身边灵异事【耗时整理】.mp3'])
    expect(out.actions.some((a) => a.kind === 'move' && a.dstDir === '/lib/下架')).toBe(false)
  })

  // 影视绑定没有第二货架（没有「下架」这个概念）。认不出的文件**判定照记、动作为空**：
  // 原地不动、永不删（spec §3 闸门三）。账本仍有它一行，守恒照算——少一行就是账本的 bug。
  it('没有第二货架 → 认不出的文件原地不动（verdict 仍 offline,无动作,守恒成立）', () => {
    const input: PlanInput = { ...base(),
      dirs: { claimed: '/lib/付费' },
      libSecondaryFiles: [],
      sourceFiles: [f('/src/092.穿衣服.mp3', 100, 777)] }
    const out = buildPlan(input)
    expect(out.actions).toEqual([])
    expect(rowFor(input, '/src/092.穿衣服.mp3')).toMatchObject({
      verdict: 'offline', basis: 'no-duration-hit:777s no-secondary-shelf', action: 'none',
    })
    expect(out.counts).toEqual({ input: 1, claimed: 0, offline: 1, copy: 0, hold: 0, dup: 0, exempt: 0 })
    expect(out.conservation).toBe(true)
  })

  it('时长未知 → hold,绝不进下架（未知 ≠ 不符）', () => {
    const input = { ...base(), sourceFiles: [f('/src/092.穿衣服.mp3')] } // durationS undefined
    expect(actions(input)[0]).toMatchObject({ kind: 'pending', pendingKind: 'no-duration' })
    expect(rowFor(input, '/src/092.穿衣服.mp3')).toMatchObject({ verdict: 'hold', basis: 'no-duration' })
  })

  // 时长主锚的意义所在：编号错位一位（455 vs 454）+ 规避字（木仓=枪）。文件名链完全失灵，
  // 时长唯一命中 + 过了 DURATION_MIN_SIM 名字地板 → 匹配器给 auto，归档器照结论搬。
  it('编号错位 + 规避字：时长唯一命中且过名字地板 → 认领进付费,不再当"冗余"问人', () => {
    const input = { ...base(), sourceFiles: [f('/src/455.现代版木仓下留人.mp3', 100, 2605)] }
    expect(actions(input)).toEqual([
      expect.objectContaining({ kind: 'move', dstDir: '/lib/付费', basis: 'authority:L454' }),
    ])
  })

  // 名字地板归档器也要过——**过不了就不算命中**（与匹配器同一把尺）。时长唯一指着 454 只是
  // "容差内恰好独一份",长音频撞时长很常见;凭它把一个名字毫不沾边的文件搬进付费当 454,正是
  // 匹配器按地板拒掉的那一步,归档器不许比它松（P7）。判定记 offline（没落到任何一集头上）,
  // 动作是 pending：证据并排摆出来让人裁,绝不进"可以自动完成"。
  it('名字地板不过 → 不算命中,不认领；出 duration-collision 待裁', () => {
    const input = { ...base(), sourceFiles: [f('/src/601.毫不相干的一集.mp3', 100, 2605)] }
    const plan = actions(input)
    expect(plan).toEqual([
      expect.objectContaining({ kind: 'pending', pendingKind: 'duration-collision' }),
    ])
    const p = plan[0] as Extract<PlanAction, { kind: 'pending' }>
    expect(p.reason).toContain('454.现代版枪下留人') // 问句要说清撞的是哪一集
    expect(p.compare!.authorityDurationS).toBe(2605)
    expect(rowFor(input, '/src/601.毫不相干的一集.mp3')).toMatchObject({ verdict: 'offline', basis: 'ambiguous:name-floor:L454' })
  })

  // 同一集来了两份、名字都沾得上这一集、彼此又太像——匹配器分不出该认哪一份（`no-margin`）。
  // 归档器**不替它裁**：过去这里由归档器"谁先被遍历到谁当正主"，方向纯靠目录顺序（抓阄），
  // 而它裁完还会顺手出一条 replace（删掉先到的那份）。现在摆出并排数据问人，本轮不搬不删。
  it('同一集两份、匹配器分不出该认哪份 → 一张问句卡，一条 move/delete 都不出', () => {
    const input = { ...base(),
      sourceFiles: [f('/srcA/现代版枪下留人 A.mp3', 100, 2605), f('/srcB/现代版枪下留人 B.mp3', 400, 2605)] }
    const plan = actions(input)
    expect(plan.filter((a) => a.kind !== 'pending')).toEqual([])
    const ask = plan.find((a) => a.kind === 'pending') as Extract<PlanAction, { kind: 'pending' }>
    expect(ask).toMatchObject({ pendingKind: 'duration-collision', collidesWith: 'L454', episode: '454.现代版枪下留人' })
    // 并排数据里两份都在——问句的两个选项都得摆出来，否则没法回答
    expect(ask.compare!.candidates.map((c) => c.path).sort()).toEqual(['/srcA/现代版枪下留人 A.mp3', '/srcB/现代版枪下留人 B.mp3'])
    expect(rowFor(input, '/srcA/现代版枪下留人 A.mp3')).toMatchObject({ verdict: 'offline', basis: 'ambiguous:no-margin:L454' })
  })

  // 空槽位的例外：名字指着某一集、时长却和它差出容差 = 证据自相矛盾 → **不算对应**,落回下架。
  // 空槽位时机器要自己把文件搬进货架,矛盾的证据不足以支撑这一步（活体形状:玄关笔记目录里
  // 104 分钟的错身文件,名字叫 `05`、节目单说 36 分钟）。
  it('名字指向空着的那一集、时长差出容差 → 证据矛盾,判下架不认领', () => {
    const input = { ...base(),
      // 匹配器只认 SxxExx（影视那档谱）→ 这份它一条都配不上,认领与否与名字关卡无关;
      // 认集身份却指着 X05,于是走到"空槽位唯一候选"那一步——时长在这里把它拦下。
      matchSpec: { version: 2 as const, stages: [{ by: 'season-episode' as const, fileRegex: '[Ss](\\d{1,2})[Ee](\\d{1,3})', titleStrip: [], threshold: 0, margin: 0.15 }] },
      authority: [{ leftKey: 'X05', title: '05.太极两仪生四象', durationS: 2163 }],
      sourceFiles: [f('/src/05.太极两仪生四象.mp3', 100, 5808)] }
    expect(actions(input)).toEqual([
      expect.objectContaining({ kind: 'move', dstDir: '/lib/下架' }),
    ])
    expect(rowFor(input, '/src/05.太极两仪生四象.mp3')).toMatchObject({ verdict: 'offline', basis: 'no-duration-hit:5808s' })
  })

  // 反例钉一下时长档的边界：系列邻集在字符串上比规避字那一对更像,但时长不同 → 压根进不了时长档
  // 的候选集,不会被"唯一命中免检"抬成 auto。
  // （名字**极像**的邻集另说：`title` 档的 0.85 阈值不看时长，它配错就是配错，改它是匹配器的事——
  //   归档器不许在这里加第二道判据，那正是 P7 禁掉的东西。）
  it('系列邻集时长不同 → 进不了时长档的候选集,照常进下架', () => {
    const input = {
      ...base(),
      authority: [...base().authority, { leftKey: 'L200', title: '200.十四谈身边灵异事', durationS: 3000 }],
      sourceFiles: [f('/src/069.四谈风水局.mp3', 100, 1777)],
    }
    expect(actions(input)[0]).toMatchObject({ kind: 'move', dstDir: '/lib/下架' })
  })

  it('子节目集**清单里也有**时仍进子节目目录,不落付费根（首轮活体拦到）', () => {
    const input = {
      ...base(),
      authority: [...base().authority, '23.正印'],
      sourceFiles: [f('/src/玄关笔记/23.正印.mp3')],
    }
    expect(actions(input)[0]).toMatchObject({ kind: 'move', dstDir: '/lib/付费/玄关笔记' })
  })
})

/**
 * 子节目（独立编号体系 + 独立文件夹）。**numPattern 只选目的地，不豁免匹配**（spec §3.2/P7）。
 * 首版做成"命中即免检的 pre-pass"，活体当场打脸：玄关笔记里三份 104 分钟的错身文件（名字叫
 * `05/20/37`、时长与节目单差 2.6–3 倍）被按名字认领原地不动，正确那三份 `swap-hold` 等一个
 * 永远不腾空的位置 = 死锁。下面 c 那条就是那个死锁的回归测试。
 */
describe('子节目路由只选目的地，不豁免匹配（spec §3.2）', () => {
  const SUB = '/lib/付费/玄关笔记'
  // 玄关笔记那一集，节目单说 2163s（活体 `05.太极两仪生四象` 的真实数）
  const withSub = () => ({ ...base(), authority: [...base().authority, { leftKey: 'X05', title: '05.太极两仪生四象', durationS: 2163 }] })

  it('a. numPattern 命中 + 时长 ±1s 命中清单 → 认领,搬进子节目目录（不是付费根）', () => {
    const input = { ...withSub(), sourceFiles: [f('/src/05.太极两仪生四象.mp3', 100, 2163)] }
    expect(actions(input)).toEqual([
      expect.objectContaining({ kind: 'move', dstDir: SUB, basis: 'authority:X05' }),
    ])
    // basis 是匹配器给的（authority:*），不是"名字像子节目编号"——认领与落点是两件事
    expect(rowFor(input, '/src/05.太极两仪生四象.mp3')).toMatchObject({ verdict: 'claimed', episode: '05.太极两仪生四象' })
  })

  it('a2. 已经躺在子节目目录里的认领文件 → 无动作（账本仍有一行）', () => {
    const input = { ...withSub(), libClaimedFiles: [f(`${SUB}/05.太极两仪生四象.mp3`, 100, 2163)] }
    expect(actions(input)).toEqual([])
    expect(rowFor(input, `${SUB}/05.太极两仪生四象.mp3`)).toMatchObject({ verdict: 'claimed', action: 'none' })
  })

  it('a3. 认领了但躺在付费根 → 搬进子节目目录（保留既有行为）', () => {
    const input = { ...withSub(), libClaimedFiles: [f('/lib/付费/05.太极两仪生四象.mp3', 100, 2163)] }
    expect(actions(input)).toEqual([
      expect.objectContaining({ kind: 'move', dstDir: SUB, src: expect.objectContaining({ path: '/lib/付费/05.太极两仪生四象.mp3' }) }),
    ])
  })

  it('b. numPattern 命中但时长与清单任何一条都不沾（错身文件，来源与库内同等对待）→ offline 出库', () => {
    const input = { ...withSub(),
      sourceFiles: [f('/src/44.来路不明.mp3', 100, 6044)],
      libClaimedFiles: [f(`${SUB}/61.也来路不明.mp3`, 999, 5808)] }
    const plan = actions(input)
    expect(plan).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'move', dstDir: '/lib/下架', src: expect.objectContaining({ path: '/src/44.来路不明.mp3' }) }),
      expect.objectContaining({ kind: 'move', dstDir: '/lib/下架', src: expect.objectContaining({ path: `${SUB}/61.也来路不明.mp3` }) }),
    ]))
    expect(rowFor(input, `${SUB}/61.也来路不明.mp3`)).toMatchObject({ verdict: 'offline', basis: 'no-duration-hit:5808s' })
  })

  it('b2. numPattern 命中 + 没配上 + 时长未知 → hold（未知 ≠ 不符,一步都不许挪）', () => {
    const input = { ...base(), sourceFiles: [f('/src/07.甲木.mp3')] } // 清单里没有它,也没探到时长
    expect(actions(input)[0]).toMatchObject({ kind: 'pending', pendingKind: 'no-duration' })
    expect(rowFor(input, '/src/07.甲木.mp3')).toMatchObject({ verdict: 'hold' })
  })

  // 免检死锁回归（子节目那轮的核心）：子目录里压着一份同名的错身文件。pre-pass 时代它被按名字
  // **认领**、原地不动，正确那份永远 swap-hold 且没人知道为什么。现在错身那份走匹配脑：没被认领、
  // 名字虽指向这一集,但时长差出**量级**（5808s vs 节目单 2163s,差 169%）= 内容矛盾,不算对应
  // （`contradicts`）——它不是这一集的副本,替换/删除都轮不到它,按"清单里没有它"出库进第二货架。
  // 位置同轮腾出,正确那份 swap-hold 一轮、下轮自然落位。
  it('c. 子目录有错身同名 + 来源有正确同名 → 错身那份判下架出库,正确那份 swap-hold', () => {
    const EP = '05.太极两仪生四象.mp3'
    const input = { ...withSub(),
      sourceFiles: [f(`/src/${EP}`, 100, 2163)],   // 节目单说 2163s —— 就是这份
      libClaimedFiles: [f(`${SUB}/${EP}`, 999, 5808)] } // 104 分钟的错身文件
    const out = buildPlan(input)
    expect(out.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'move', src: expect.objectContaining({ path: `${SUB}/${EP}` }), dstDir: '/lib/下架' }),
      expect.objectContaining({ kind: 'pending', pendingKind: 'swap-hold', src: expect.objectContaining({ path: `/src/${EP}` }) }),
    ]))
    // 错身那份绝不产出替换建议——那等于建议删掉正确那份
    expect(out.actions.some((a) => a.kind === 'replace' || a.kind === 'delete-loser')).toBe(false)
    // 账本行齐全 + 守恒律：两个文件两行，一个 claimed（降级 swap-hold）一个 offline
    expect(out.rows).toHaveLength(2)
    expect(rowFor(input, `/src/${EP}`)).toMatchObject({ verdict: 'claimed', basis: 'authority:X05', action: 'pending:swap-hold' })
    expect(rowFor(input, `${SUB}/${EP}`)).toMatchObject({ verdict: 'offline', basis: 'no-duration-hit:5808s' })
    expect(out.counts).toEqual({ input: 2, claimed: 1, offline: 1, copy: 0, hold: 0, dup: 0, exempt: 0 })
    expect(out.conservation).toBe(true)
  })
})

describe('字节数全等 = 就是同一份（唯一允许自动删的情形，spec §3.3）', () => {
  const EP = '750.探秘人体特殊实验.mp3'

  it('付费货架已有同集同 size → 删来源那份,留库内那份', () => {
    const input = { ...base(),
      sourceFiles: [f(`/src/${EP}`, 111)],
      libClaimedFiles: [f(`/lib/付费/${EP}`, 111)] }
    // `episode` = 这两份说的是哪一集（删除行的抬头）。字节全等这一档跑在匹配器之前，能给的
    // 只有"名字自称是清单里的哪一集"——纯抬头，不参与判定。
    expect(actions(input)[0]).toMatchObject({ kind: 'delete-dup', dupOf: `/lib/付费/${EP}`, episode: '750.探秘人体特殊实验' })
    expect(rowFor(input, `/src/${EP}`)).toMatchObject({ verdict: 'dup', basis: `size-dup-of:/lib/付费/${EP}` })
  })

  it('名字不在清单里 → 不带 episode（前端退化成动作标签,绝不拿文件名冒充集名）', () => {
    const input = { ...base(),
      sourceFiles: [f('/src/092.穿衣服.mp3', 111, 777)],
      libSecondaryFiles: [f('/lib/下架/092.穿衣服.mp3', 111)] }
    const a = actions(input)[0]
    expect(a).toMatchObject({ kind: 'delete-dup', dupOf: '/lib/下架/092.穿衣服.mp3' })
    expect(a).not.toHaveProperty('episode')
  })

  it('裁判在场也不越过它：时长明明不同,字节全等仍然是最硬的判据', () => {
    const input = { ...base(),
      sourceFiles: [f(`/src/${EP}`, 111, 1000)],
      libClaimedFiles: [f(`/lib/付费/${EP}`, 111, 2600)] }
    expect(actions(input)[0]).toMatchObject({ kind: 'delete-dup' })
  })

  it('下架货架上有同集同 size → 一样算重复（它不进匹配池,但照样是"这份已经有了"）', () => {
    const input = { ...base(),
      sourceFiles: [f(`/src/${EP}`, 111, 4000)],
      libSecondaryFiles: [f(`/lib/下架/${EP}`, 111)] }
    expect(actions(input)[0]).toMatchObject({ kind: 'delete-dup', dupOf: `/lib/下架/${EP}` })
  })

  it('sourceDirs 与库目录重叠：库内"重复"命中的其实是文件本身 → 不删、原地不动、无动作', () => {
    const same = f(`/lib/付费/${EP}`, 111)
    const input = { ...base(), sourceFiles: [same], libClaimedFiles: [same] }
    expect(actions(input)).toEqual([]) // 唯一副本，绝不能是 delete-dup
    expect(buildPlan(input).rows).toHaveLength(1) // 但账本有它一行
  })

  /**
   * `paid` 集的网盘副本可能是**唯一可播来源**（源站要钱 = 源站自己放不出音频）。`delete-dup` 是
   * 全流程里**唯一不经人眼、`autoExecute` 下即删**的动作（`execute.ts` 的 `losers` 开关管不到它），
   * 于是定时轮能在没人看的情况下把它删掉。降级成确认档 `delete-loser`：同样是"删这份、留那份"，
   * 但定时轮永不执行（`service.ts` 永远传 `losers:false`），必须人点头。
   */
  describe('paid 集的字节全等副本：降级成确认档，定时轮永不自动删', () => {
    const PAID = '801.付费那一集.mp3'
    const paidBase = () => ({
      ...base(),
      authority: [...base().authority, { leftKey: 'L801', title: '801.付费那一集', durationS: 1300, paid: true, needsSupply: true }],
    })

    it('付费集 + 字节全等 → delete-loser（不是 delete-dup）', () => {
      const input = { ...paidBase(),
        sourceFiles: [f(`/src/${PAID}`, 111)],
        libClaimedFiles: [f(`/lib/付费/${PAID}`, 111)] }
      const a = actions(input)[0]
      expect(a).toMatchObject({ kind: 'delete-loser', keptPath: `/lib/付费/${PAID}`, episode: '801.付费那一集' })
      expect(a.kind).not.toBe('delete-dup')
    })

    // 留下的那份在下架货架上：它不进**主**匹配池，每轮的复核又只认 auto 命中（改过名/没时长的
    // 认不回来）——所以"字节还在"仍然不等于"这一集还有音频"，降级照旧。
    // 这一轮的复核恰好认得出它（名字一字不差）→ 它同时回流付费货架，两条动作互不冲突：
    // 删的是来源那份、搬的是货架那份。
    it('留下的那份在下架货架上时同样降级；复核认得出它就顺手把它接回来', () => {
      const input = { ...paidBase(),
        sourceFiles: [f(`/src/${PAID}`, 111)],
        libSecondaryFiles: [f(`/lib/下架/${PAID}`, 111)] }
      const plan = actions(input)
      expect(plan[0]).toMatchObject({ kind: 'delete-loser', keptPath: `/lib/下架/${PAID}` })
      expect(plan).toHaveLength(2)
      expect(plan[1]).toMatchObject({
        kind: 'move', dstDir: '/lib/付费', basis: 'relisted:L801',
        src: expect.objectContaining({ path: `/lib/下架/${PAID}` }),
      })
    })

    it('同轮来源内多份全等：留一份，其余降级成 delete-loser', () => {
      const input = { ...paidBase(),
        sourcePriority: ['/srcGOOD', '/srcBAD'],
        sourceFiles: [f(`/srcBAD/${PAID}`, 111), f(`/srcGOOD/${PAID}`, 111)] }
      const plan = actions(input)
      expect(plan.filter((a) => a.kind === 'delete-dup')).toHaveLength(0)
      expect(plan.filter((a) => a.kind === 'delete-loser')).toHaveLength(1)
      expect((plan.find((a) => a.kind === 'delete-loser') as { src: RFile }).src.path).toBe(`/srcBAD/${PAID}`)
    })

    it('免费集不受影响——这道闸只为 paid 而设，别顺手把整条 dup 路改掉', () => {
      const input = { ...paidBase(),
        sourceFiles: [f(`/src/${EP}`, 111)],
        libClaimedFiles: [f(`/lib/付费/${EP}`, 111)] }
      expect(actions(input)[0]).toMatchObject({ kind: 'delete-dup' })
    })

    it('名字认不出是哪一集 → 认不出就没有保护可言，照旧 delete-dup（不瞎猜）', () => {
      const input = { ...paidBase(),
        sourceFiles: [f('/src/无名文件.mp3', 111)],
        libSecondaryFiles: [f('/lib/下架/无名文件.mp3', 111)] }
      expect(actions(input)[0]).toMatchObject({ kind: 'delete-dup' })
    })
  })

  it('同轮来源内同集多份 size 全等 → 留一份 move,其余 delete-dup；留哪份按 sourcePriority', () => {
    const input = { ...base(),
      sourcePriority: ['/srcGOOD', '/srcBAD'],
      sourceFiles: [f(`/srcBAD/${EP}`, 111), f(`/srcGOOD/${EP}`, 111)] }
    const plan = actions(input)
    expect(plan.filter((a) => a.kind === 'move')).toHaveLength(1)
    expect(plan.filter((a) => a.kind === 'delete-dup')).toHaveLength(1)
    expect((plan.find((a) => a.kind === 'move') as { src: RFile }).src.path).toBe(`/srcGOOD/${EP}`)
  })

  it('sourcePriority 目录名前缀碰撞不误配(/srcGOOD 不匹配 /srcGOODextra)', () => {
    const input = { ...base(),
      sourcePriority: ['/srcGOOD'],
      sourceFiles: [f(`/srcGOODextra/${EP}`, 111), f(`/srcGOOD/${EP}`, 111)] }
    const plan = actions(input)
    expect((plan.find((a) => a.kind === 'move') as { src: RFile }).src.path).toBe(`/srcGOOD/${EP}`)
  })
})

/**
 * 同一集有多份（库内 + 本轮来源）。**判定全在匹配器里**，归档器只把结论落成动作：
 * 命中的那份被认领、占住付费货架；没被认领的那份走名字关卡——名字仍指向这一集的是**副本**
 * （多几秒尾巴/重剪/错版），归步 4 的"重复项"待裁（P6 被替换归宿未拍板）；名字和时长都不沾
 * 清单的才进下架。活体原型：怡乐 `780` 节目单 8274s，来源那份 8274s、库内那份 8279s（5 秒尾巴）。
 */
describe('同一集有多份：认领的占货架，副本待裁，两不沾的进下架（spec §8.1/§8.2）', () => {
  const EP = '750.探秘人体特殊实验.mp3' // 清单说 1000s（见 base()）

  it('来源命中、库内同名那份差 2.6 倍 → 库内那份内容矛盾判下架出库；来源那份 swap-hold', () => {
    const input = { ...base(),
      sourceFiles: [f(`/src/${EP}`, 111, 1000)],
      libClaimedFiles: [f(`/lib/付费/${EP}`, 999, 2600)] }
    const plan = actions(input)
    // 名字虽指向已认领的集,但 2600s vs 节目单 1000s 差出量级 = 不是这一集的内容（`contradicts`）
    // → 不进替换裁决,按"清单里没有它"出库。绝不自动删,更不许建议删掉正确那份。
    expect(plan).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'move', src: expect.objectContaining({ path: `/lib/付费/${EP}` }), dstDir: '/lib/下架' }),
    ]))
    expect(rowFor(input, `/lib/付费/${EP}`)).toMatchObject({ verdict: 'offline', basis: 'no-duration-hit:2600s' })
    // 来源那份认领成立（账本记 claimed），但付费货架上还压着同名的那份 → 降级 swap-hold。
    expect(rowFor(input, `/src/${EP}`)).toMatchObject({ verdict: 'claimed', action: 'pending:swap-hold' })
    expect(plan.some((a) => a.kind === 'delete-loser' || a.kind === 'replace')).toBe(false)
  })

  it('库内那份腾空后（换个名字不撞）→ 来源那份直接搬进付费货架', () => {
    const input = { ...base(),
      sourceFiles: [f(`/src/${EP}`, 111, 1000)],
      libClaimedFiles: [f('/lib/付费/750.探秘人体特殊实验（旧）.mp3', 999, 2600)] }
    const plan = actions(input)
    expect(plan).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'move', dstDir: '/lib/付费', src: expect.objectContaining({ path: `/src/${EP}` }) }),
      expect.objectContaining({ kind: 'move', dstDir: '/lib/下架' }),
    ]))
  })

  it('反向：库内那份才是对的 → 它原地不动（账本仍有一行）,来源同名那份内容矛盾进下架', () => {
    const input = { ...base(),
      sourceFiles: [f(`/src/${EP}`, 111, 2600)],
      libClaimedFiles: [f(`/lib/付费/${EP}`, 999, 1000)] }
    // 来源那份名字撞了已认领的集,但 2600s vs 节目单 1000s 差出量级 → 不是副本,按"清单里没有它"进下架
    expect(actions(input)).toEqual([
      expect.objectContaining({ kind: 'move', src: expect.objectContaining({ path: `/src/${EP}` }), dstDir: '/lib/下架' }),
    ])
    expect(rowFor(input, `/lib/付费/${EP}`)).toMatchObject({ verdict: 'claimed', action: 'none' })
    expect(rowFor(input, `/src/${EP}`)).toMatchObject({ verdict: 'offline', basis: 'no-duration-hit:2600s' })
  })

  it('去向就是该 show 既有的下架库,两个库目录不同父也照样裁（名字不沾清单的才走这条）', () => {
    const input = { ...base(),
      dirs: { claimed: '/treeA/付费', secondary: '/treeB/下架' },
      sourceFiles: [f('/src/092.穿衣服.mp3', 111, 777)] } // 时长和名字都不沾清单
    expect(actions(input)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'move', dstDir: '/treeB/下架', src: expect.objectContaining({ path: '/src/092.穿衣服.mp3' }) }),
    ]))
  })

  // 两份时长都对得上、码率差得出高下（111B/1000s vs 999B/1001s）→ 落选那份直接删（P6 定案）。
  // 留下的是匹配器认领的那份,`keptPath` 指着它——"删这份、留那份"必须在动作里说全。
  it('两份都在 ±1s 内、码率分得出高下 → 落选那份 delete-loser,留正主', () => {
    const input = { ...base(),
      sourceFiles: [f(`/src/${EP}`, 111, 1000)],
      libClaimedFiles: [f(`/lib/付费/${EP}`, 999, 1001)] }
    const plan = actions(input)
    expect(plan).toEqual([
      expect.objectContaining({
        kind: 'delete-loser',
        src: expect.objectContaining({ path: `/src/${EP}` }),
        keptPath: `/lib/付费/${EP}`,
        basis: `quality-loser-of:/lib/付费/${EP}`,
        // 删除行的抬头：说的是**哪一集**。"删一个叫 X 的文件"答不了"这是哪一集的第几份"，
        // 用户对着确认按钮点不下去（前端四行块的第 ① 行）。
        episode: '750.探秘人体特殊实验',
      }),
    ])
    // 判定仍记 copy 筐（同集多份），只是这一轮的动作从"问人"变成了"删"
    expect(rowFor(input, `/src/${EP}`)).toMatchObject({ verdict: 'copy', action: `delete:/lib/付费/${EP}` })
  })

  // 闸门二：清晰度探不出 + 时长缺一侧 = 比不出高下 → 不许自动删，出**替换建议**（`quality-unknown:`）
  // 并带上并排对照。**未知 ≠ 该删**：动作在确认档，定时轮不碰它。
  it('比不出高下（一侧没时长、名字也没清晰度档）→ 替换建议,带并排对照', () => {
    const input = { ...base(),
      authority: [{ leftKey: 'L750', title: '750.探秘人体特殊实验' }], // 无 durationS：认集走文件名链
      sourceFiles: [f(`/src/${EP}`, 111, 1000)],
      libClaimedFiles: [f(`/lib/付费/${EP}`, 999)] } // 库内那份没探到时长
    const plan = actions(input)
    const swap = plan.find((a) => a.kind === 'replace') as Extract<PlanAction, { kind: 'replace' }>
    expect(swap).toMatchObject({ oldPath: `/lib/付费/${EP}`, basis: `quality-unknown:/lib/付费/${EP}` })
    expect(swap.compare!.candidates.map((c) => c.path)).toContain(`/src/${EP}`)
    expect(plan.some((a) => a.kind === 'delete-loser' || a.kind === 'delete-dup')).toBe(false)
  })

  // 副本反而更好（清晰度高一档，但体量小所以没被匹配器选中当正主）→ 替换建议：删旧正主、这份上位。
  // 仍然不自动执行——删不可逆,`losers:false` 的定时轮跳过它。
  it('副本严格更优 → 出替换建议（quality-upgrade）,不自动执行', () => {
    const HI = '/lib/付费/750.探秘人体特殊实验.2160p.mp3'
    const LO = '/lib/付费/750.探秘人体特殊实验.1080p.mp3'
    const input = { ...base(), libClaimedFiles: [f(LO, 999, 1000), f(HI, 111, 1000)] }
    const plan = actions(input)
    const swap = plan.find((a) => a.kind === 'replace' && a.src.path === HI) as Extract<PlanAction, { kind: 'replace' }>
    expect(swap).toMatchObject({ oldPath: LO, dstDir: '/lib/付费', basis: `quality-upgrade:${LO}` })
    expect(plan.some((a) => a.kind === 'delete-loser')).toBe(false)
  })

  // 平手（码率差 3% < 5% 容差）= 两份一样好 → 照样删一份：同集只留一份，留哪份不重要。
  it('码率差在 5% 以内（平手）→ 落选那份照样 delete-loser', () => {
    const input = { ...base(),
      sourceFiles: [f(`/src/${EP}`, 1000, 1000)],
      libClaimedFiles: [f(`/lib/付费/${EP}`, 1030, 1000)] }
    expect(actions(input)).toEqual([
      expect.objectContaining({ kind: 'delete-loser', src: expect.objectContaining({ path: `/src/${EP}` }), keptPath: `/lib/付费/${EP}` }),
    ])
  })

  // 跨画质择优（影视形状）：清晰度档探得出就按档位排，与体量/码率无关。4K 留、1080p 删。
  it('同集两个清晰度档 → 低档那份 delete-loser,高档留', () => {
    const input = { ...base(),
      authority: [{ leftKey: 'tmdb:9:S01E01', title: 'Show S01E01', durationS: 3600 }],
      matchSpec: { version: 2 as const, stages: [{ by: 'season-episode' as const, fileRegex: '[Ss](\\d{1,2})[Ee](\\d{1,3})', titleStrip: [], threshold: 0, margin: 0.15 }] },
      libClaimedFiles: [
        f('/lib/付费/Show.S01E01.2160p.mkv', 2861, 3600),
        f('/lib/付费/Show.S01E01.1080p.mkv', 954, 3600),
      ] }
    const plan = actions(input)
    expect(plan).toEqual([
      expect.objectContaining({
        kind: 'delete-loser',
        src: expect.objectContaining({ path: '/lib/付费/Show.S01E01.1080p.mkv' }),
        keptPath: '/lib/付费/Show.S01E01.2160p.mkv',
      }),
    ])
  })

  // spec §8.5：未知 ≠ 不符。没探到时长的那份只能进 hold，一步都不许挪。
  it('有候选没探到时长 → 它进 hold,不搬任何东西', () => {
    const input = { ...base(),
      sourceFiles: [f(`/src/${EP}`, 111, 1000)],
      libClaimedFiles: [f(`/lib/付费/${EP}`, 999)] } // 库内那份没探到
    const plan = actions(input)
    expect(plan.some((a) => a.kind === 'move')).toBe(false)
    expect(rowFor(input, `/lib/付费/${EP}`)).toMatchObject({ verdict: 'hold', basis: 'no-duration' })
  })

  // 清单一条时长都没给（TMDb 分集索引那类）→ 认集整个退回文件名链。文件名链认下了库内那份，
  // 来源同名那份是**同一集的另一份**（名字关卡）→ copy 待裁,不当"没配上"扔下架——裁判(时长)
  // 不在场时更不该乱扔。compare 照带（authorityDurationS 缺席 = 只列数据不标对错）。
  it('清单没给这一集时长 → 文件名链认下库内那份,来源同名那份出替换建议', () => {
    const input: PlanInput = { ...base(),
      authority: ['750.探秘人体特殊实验'], // 纯标题,无 durationS
      sourceFiles: [f(`/src/${EP}`, 111, 1000)],
      libClaimedFiles: [f(`/lib/付费/${EP}`, 999, 2600)] }
    const out = buildPlan(input)
    expect(out.actions).toEqual([
      expect.objectContaining({ kind: 'replace', src: expect.objectContaining({ path: `/src/${EP}` }), oldPath: `/lib/付费/${EP}` }),
    ])
    expect(rowFor(input, `/lib/付费/${EP}`)).toMatchObject({ verdict: 'claimed', action: 'none' })
    expect(rowFor(input, `/src/${EP}`)).toMatchObject({ verdict: 'copy' })
    expect(out.authority).toEqual({ entries: 1, paid: 0, withDuration: 0, needsSupply: 0 })
  })

  it('同轮来源内同集多份 size 不等 → 匹配器认领体量大的那份,另一份进 hold（不自动删）', () => {
    const input = { ...base(), sourceFiles: [f(`/srcA/${EP}`, 111), f(`/srcB/${EP}`, 222)] }
    const plan = actions(input)
    expect(plan.filter((a) => a.kind === 'move')).toHaveLength(1)
    expect((plan.find((a) => a.kind === 'move') as { src: RFile }).src.path).toBe(`/srcB/${EP}`)
    expect(plan.some((a) => a.kind === 'delete-dup')).toBe(false)
  })
})

/**
 * 第二货架（下架）上的同集择优。这条货架**不进匹配池**（它的契约是"文件自己就是一集"），但
 * "同一集别放两份"照样成立——判下架的文件搬过去之前，先和架上那份比一次。
 *
 * 为什么不能沿用同名/同集占位护栏：那道护栏假设"占着位的那份下一轮会走"，对认领货架成立
 * （它会被裁决/替换），对第二货架不成立——没有任何一轮会去搬走它。干等 = 永不腾空的僵尸位。
 */
describe('第二货架同集择优（搬进去之前先比一次）', () => {
  const EP = '092.穿衣服.mp3' // 时长和名字都不沾清单 → 判下架
  const shelved = (size: number, durationS?: number) => f(`/lib/下架/${EP}`, size, durationS)

  it('新的更差 → 删新的、留架上那份（不是 swap-hold 干等）', () => {
    const input = { ...base(),
      sourceFiles: [f(`/src/${EP}`, 100, 777)],
      libSecondaryFiles: [shelved(400, 777)] }
    expect(actions(input)).toEqual([
      expect.objectContaining({ kind: 'delete-loser', src: expect.objectContaining({ path: `/src/${EP}` }), keptPath: `/lib/下架/${EP}` }),
    ])
    expect(rowFor(input, `/src/${EP}`)).toMatchObject({ verdict: 'offline', action: `delete:/lib/下架/${EP}` })
  })

  it('新的更优 → 换掉架上那份（replace：删旧的 + 新的搬进下架）', () => {
    const input = { ...base(),
      sourceFiles: [f(`/src/${EP}`, 400, 777)],
      libSecondaryFiles: [shelved(100, 777)] }
    expect(actions(input)).toEqual([
      expect.objectContaining({
        kind: 'replace', src: expect.objectContaining({ path: `/src/${EP}` }),
        oldPath: `/lib/下架/${EP}`, dstDir: '/lib/下架', basis: `quality-upgrade:/lib/下架/${EP}`,
      }),
    ])
  })

  it('比不出高下 → pending(replace),带并排对照,一份都不删', () => {
    const input = { ...base(),
      sourceFiles: [f(`/src/${EP}`, 400, 777)],
      libSecondaryFiles: [shelved(100)] } // 架上那份没探到时长 → 码率没得比
    const plan = actions(input)
    const pending = plan.find((a) => a.kind === 'pending') as Extract<PlanAction, { kind: 'pending' }>
    expect(pending).toMatchObject({ pendingKind: 'replace' })
    expect(pending.compare!.candidates.map((c) => c.path).sort()).toEqual([`/lib/下架/${EP}`, `/src/${EP}`])
    expect(plan.some((a) => a.kind === 'delete-loser' || a.kind === 'replace')).toBe(false)
  })

  it('架上没有同集的 → 照常搬进去', () => {
    const input = { ...base(),
      sourceFiles: [f(`/src/${EP}`, 100, 777)],
      libSecondaryFiles: [f('/lib/下架/999.别的集.mp3', 100, 5000)] }
    expect(actions(input)).toEqual([expect.objectContaining({ kind: 'move', dstDir: '/lib/下架' })])
  })

  /**
   * 人裁过「留哪一份」之后，这一对不再出卡——机器比不出来不代表人也比不出来。
   * 决定本身不动文件：它只是把 `pending` 换成一条**照常进「将删清单」等确认**的动作，
   * 预览 → 确认 → 执行这条链一步不破。
   */
  describe('人裁过「留哪一份」→ 不再问，按人说的走', () => {
    const unresolvable = () => ({ ...base(),
      sourceFiles: [f(`/src/${EP}`, 400, 777)],
      libSecondaryFiles: [shelved(100)] }) // 机器比不出：架上那份没探到时长

    it('人说留架上那份 → 删这一份（进将删清单，不是直接删）', () => {
      const input = { ...unresolvable(), preferredOf: (a: string, b: string) =>
        [a, b].includes(`/lib/下架/${EP}`) ? `/lib/下架/${EP}` : undefined }
      expect(actions(input)).toEqual([
        expect.objectContaining({
          kind: 'delete-loser', src: expect.objectContaining({ path: `/src/${EP}` }),
          keptPath: `/lib/下架/${EP}`, basis: `decision:prefer:/lib/下架/${EP}`,
        }),
      ])
    })

    it('人说留这一份 → 换掉架上那份', () => {
      const input = { ...unresolvable(), preferredOf: (a: string, b: string) =>
        [a, b].includes(`/src/${EP}`) ? `/src/${EP}` : undefined }
      expect(actions(input)).toEqual([
        expect.objectContaining({
          kind: 'replace', src: expect.objectContaining({ path: `/src/${EP}` }),
          oldPath: `/lib/下架/${EP}`, dstDir: '/lib/下架', basis: `decision:prefer:/src/${EP}`,
        }),
      ])
    })

    /** 裁的是别的一对（另一份文件）→ 这一对照旧出卡。决定只对它自己那一对成立。 */
    it('裁的是别的一对 → 这一对照旧出卡', () => {
      const input = { ...unresolvable(), preferredOf: () => undefined }
      expect(actions(input).find((a) => a.kind === 'pending')).toMatchObject({ pendingKind: 'replace' })
    })

    /** 机器比得出高下时不问它：人裁只在"比不出"那一档接管，不许倒过来推翻实测证据。 */
    it('机器比得出高下 → 不看人裁，照实测走', () => {
      const input = { ...base(),
        sourceFiles: [f(`/src/${EP}`, 100, 777)],
        libSecondaryFiles: [shelved(400, 777)],
        preferredOf: () => `/src/${EP}` }
      expect(actions(input)).toEqual([
        expect.objectContaining({ kind: 'delete-loser', keptPath: `/lib/下架/${EP}` }),
      ])
    })
  })
})

/**
 * 时长撞上好几集时锚定哪一集。活体（2026-07-31 怡乐）：`37.申与酉.mp3` 100:44 同时命中 37
 * （100:43，名字就是它）和 756（100:43，已经有认领文件）。锚到 756 会把它判成 756 的副本，
 * 接着按码率把它删掉——一笔从头错到尾的账。名字比时长更具体，身份一致的那一集优先。
 */
describe('多集撞时长：锚定身份一致的那一集', () => {
  const DUR = 6043
  const twins = [
    { leftKey: 'L756', title: '756.先来的那一集', durationS: DUR },
    { leftKey: 'L037', title: '37.申与酉', durationS: DUR },
  ]

  it('名字指着 37 → 这份副本记在 37 名下,留下的也是 37 那份', () => {
    const input = { ...base(), authority: twins,
      libClaimedFiles: [f('/lib/付费/756.先来的那一集.mp3', 999, DUR), f('/lib/付费/37.申与酉.mp3', 999, DUR)],
      sourceFiles: [f('/src/37.申与酉.mp3', 100, DUR + 1)] }
    expect(rowFor(input, '/src/37.申与酉.mp3')).toMatchObject({ verdict: 'copy', basis: 'same-episode-copy:L037', episode: '37.申与酉' })
    // 落选副本留下的必须是 37 那份——锚错集时这里会写着 756 那份的路径,一笔糊涂账
    expect(actions(input).filter((a) => a.kind === 'delete-loser')).toEqual([
      expect.objectContaining({ src: expect.objectContaining({ path: '/src/37.申与酉.mp3' }), keptPath: '/lib/付费/37.申与酉.mp3' }),
    ])
  })

  // 活体那条错账的完整形状（2026-07-31 怡楽）：一个名字谁都不沾的文件时长撞上已有正主的那一集。
  // 裸时长比较会把它判成那一集的副本,再比码率出"换正主"——**建议删掉名字与时长都对的那份**。
  // 名字地板拦在前面：不算命中 → 不认领、不自动搬,出 duration-collision 并排给人裁。
  it('名字谁都不像 → 地板拦下,不认给"已经有认领文件的那一集"', () => {
    const input = { ...base(), authority: twins,
      libClaimedFiles: [f('/lib/付费/756.先来的那一集.mp3', 999, DUR)],
      sourceFiles: [f('/src/无名氏.mp3', 100, DUR + 1)] }
    const plan = actions(input)
    // 撞上的是**还空着**的那一集（756 的时长档已经被它自己那份名副其实的文件认走，问句就只剩 37）。
    expect(rowFor(input, '/src/无名氏.mp3')).toMatchObject({ verdict: 'offline', basis: 'ambiguous:name-floor:L037' })
    const p = plan.find((a) => a.kind === 'pending') as Extract<PlanAction, { kind: 'pending' }>
    expect(p).toMatchObject({ pendingKind: 'duration-collision' })
    // 集名 = **撞上的那一集**（卡片标题问的就是"它是不是这一集"）。它必须和 authorityDurationS
    // 同源:标题写这份文件自称的集名、时长却是撞上那一集的,读起来就是"节目单里 X 长 N"的假话。
    expect(p.episode).toBe('37.申与酉')
    expect(p.compare!.candidates.map((c) => c.path)).toEqual(['/src/无名氏.mp3'])
    expect(p.compare!.authorityDurationS).toBe(DUR)
    // 绝不进"可以自动完成"：一条删除/替换都不许出
    expect(plan.some((a) => a.kind === 'replace' || a.kind === 'delete-loser' || a.kind === 'delete-dup')).toBe(false)
    // 正主原地不动,照旧是正主
    expect(rowFor(input, '/lib/付费/756.先来的那一集.mp3')).toMatchObject({ verdict: 'claimed', basis: 'authority:L756', action: 'none' })
  })
})

/**
 * 活体重放（2026-07-31 怡楽播客）——这一条是本轮修正的由来，形状原样搬过来：
 *  · `付费/756.大家都焦虑的这么具体了吗？.mp3` 100:44、128k —— 匹配器认下的 756 正主；
 *  · `付费/玄关笔记/37.申与酉.mp3` 100:44、320k —— 时长与 756 分毫不差，名字一个字不沾；
 *  · `来源/玄关笔记/37.申与酉【公众号】.mp3` 34:01 —— 真正的第 37 集，名字与节目单一致。
 *
 * 出事的那一版：中间那份靠**裸时长比较**被判成 756 的副本，比码率后出「换正主」——删掉名字与
 * 时长都对的 756 正主、换上一份不知道是什么的音频，而且落在「可以自动完成」那一档。
 */
describe('活体重放：时长撞车的错身文件不许换掉正主', () => {
  const SUB = '/lib/付费/玄关笔记'
  const OWNER = '/lib/付费/756.大家都焦虑的这么具体了吗？.mp3'  // 100:44 128k，756 的正主
  const STRANGER = `${SUB}/37.申与酉.mp3`                        // 100:44 320k，名字与 756 毫不沾边
  const REAL37 = '/src/玄关笔记/37.申与酉【公众号】.mp3'          // 34:01，真正的第 37 集
  const input = (): PlanInput => ({ ...base(),
    authority: [
      { leftKey: 'L756', title: '756.大家都焦虑的这么具体了吗？', durationS: 6043, paid: true, needsSupply: true },
      { leftKey: 'L037', title: '37.申与酉', durationS: 2041, paid: true, needsSupply: true },
    ],
    libClaimedFiles: [f(OWNER, 92, 6044), f(STRANGER, 231, 6044)],
    sourceFiles: [f(REAL37, 31, 2041)] })

  // 正主在架、名字与节目单一字不差 → 匹配器直接认下 756。这份错身文件谁都没认领它，但它**不是
  // 残差**：时长命中 756、名字又和 L037 一模一样，两条像样的证据各指一边（I3）。
  //
  // 旧引擎在这儿把它静默搬去下架，卡片理由写「时长和名字都对不上节目单任何一集」——**是假话**，
  // 它的时长恰恰对上了 756。现在出卡等人（spec §4.2 钦定的预期差异）。
  // 不变的那半边照旧钉住：绝不出替换/删除（那才是活体那条错账——删掉名字与时长都对的正主）。
  it('正主名副其实 → 错身那份既不换正主也不删,出证据冲突卡等人裁', () => {
    const out = buildPlan(input())
    expect(out.actions.some((a) => a.kind === 'replace' || a.kind === 'delete-loser' || a.kind === 'delete-dup')).toBe(false)
    expect(out.rows.find((r) => r.path === STRANGER)).toMatchObject({
      verdict: 'offline', basis: 'evidence-conflict:L037,L756', action: 'pending:evidence-conflict',
    })
    // 本轮一步都不动它——静默搬下架那条通道没了，取而代之的是一张摆着证据的卡。
    expect(out.actions.some((a) => a.kind === 'move' && a.src.path === STRANGER)).toBe(false)
    const card = out.actions.find((a) => a.kind === 'pending' && a.src.path === STRANGER) as Extract<PlanAction, { kind: 'pending' }>
    expect(card.conflictsWith).toEqual(['L037', 'L756'])
    // 理由由证据渲染，不是写死的结论句：两集各自靠什么沾上，句子里说得出来。
    // 名字 0 分照样露出来——那正是"光有时长命中不够"的原因，抹掉它这张卡就少了半边理由。
    expect(card.reason).toContain('证据指向 2 个集')
    expect(card.reason).toContain('《37.申与酉》(epnum=37·名字全等·时长矛盾)')
    expect(card.reason).toContain('《756.大家都焦虑的这么具体了吗？》(时长命中·名字 sim 0.00)')
    // 卡片不带 episode：争的是哪几集还没定，写一个上去就是抓阄。
    expect(card.episode).toBeUndefined()
  })

  // 出口：这张卡占着货架上那个名字，没有出口就是死锁。对**每一个**相争的集都答过「不是」之后，
  // 它按"清单里没有它"走下架，位置腾出。少答一个仍然照问（那时它可能还是那一集）。
  it('人对每一个相争的集都答过「不是」→ 按 offline 搬去下架', () => {
    const answered = new Set(['L037', 'L756'])
    const out = buildPlan({ ...input(), notEpisode: (leftKey, path) => path === STRANGER && answered.has(leftKey) })
    expect(out.rows.find((r) => r.path === STRANGER)).toMatchObject({
      verdict: 'offline', basis: 'decision:not-episode:L037,L756', action: 'move:/lib/下架',
    })
    expect(out.actions.some((a) => a.kind === 'pending' && a.pendingKind === 'evidence-conflict')).toBe(false)
  })

  it('只答了其中一个 → 照样问（还剩一集没答，搬走就是替他做决定）', () => {
    const out = buildPlan({ ...input(), notEpisode: (leftKey, path) => path === STRANGER && leftKey === 'L756' })
    expect(out.actions.some((a) => a.kind === 'pending' && a.pendingKind === 'evidence-conflict')).toBe(true)
    expect(out.actions.some((a) => a.kind === 'move' && a.src.path === STRANGER)).toBe(false)
  })

  // 正主还没在架时才有那个问句：756 空着、只有这份时长撞上却名字不沾的文件够得着它。
  const noOwner = (): PlanInput => ({ ...input(), libClaimedFiles: [f(STRANGER, 231, 6044)] })

  it('正主还空着 → 撞时长但名字不沾的那份出待裁,一条 replace/delete 都不出', () => {
    const out = buildPlan(noOwner())
    expect(out.actions.some((a) => a.kind === 'replace' || a.kind === 'delete-loser' || a.kind === 'delete-dup')).toBe(false)
    const p = out.actions.find((a) => a.kind === 'pending' && a.src.path === STRANGER) as Extract<PlanAction, { kind: 'pending' }>
    expect(p).toMatchObject({ pendingKind: 'duration-collision', collidesWith: 'L756' })
    expect(p.compare!.authorityDurationS).toBe(6043)
    expect(out.rows.find((r) => r.path === STRANGER)).toMatchObject({ verdict: 'offline', basis: 'ambiguous:name-floor:L756' })
  })

  // 出口：人对着那条待定答了「不是这一集」→ 下一轮不再问，按"清单里没有它"走下架货架。
  // 位置同轮腾出，等位的第 37 集下一轮自然落位——这个问句必须能收敛，否则两条互相锁死。
  it('人裁过「不是这一集」→ 不再问,按 offline 搬去下架（basis 记着是人裁的）', () => {
    const out = buildPlan({ ...noOwner(), notEpisode: (leftKey, path) => leftKey === 'L756' && path === STRANGER })
    expect(out.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'move', src: expect.objectContaining({ path: STRANGER }), dstDir: '/lib/下架' }),
    ]))
    expect(out.actions.some((a) => a.kind === 'pending' && a.pendingKind === 'duration-collision')).toBe(false)
    expect(out.rows.find((r) => r.path === STRANGER)).toMatchObject({ verdict: 'offline', basis: 'decision:not-episode:L756' })
    expect(out.actions.some((a) => a.kind === 'delete-loser' || a.kind === 'replace')).toBe(false)
  })

  it('人裁的是别的组合（同文件撞别的集 / 同集碰别的文件）→ 照样问', () => {
    const other = buildPlan({ ...noOwner(), notEpisode: (leftKey) => leftKey === 'L037' })
    expect(other.actions.some((a) => a.kind === 'pending' && a.pendingKind === 'duration-collision')).toBe(true)
    const otherFile = buildPlan({ ...noOwner(), notEpisode: (_k, path) => path === OWNER })
    expect(otherFile.actions.some((a) => a.kind === 'pending' && a.pendingKind === 'duration-collision')).toBe(true)
  })

  it('待定行带 collidesWith：前端要把它连同路径回传,自己不许拼那个组合键', () => {
    const p = buildPlan(noOwner()).actions.find((a) => a.kind === 'pending' && a.src.path === STRANGER) as Extract<PlanAction, { kind: 'pending' }>
    expect(p.collidesWith).toBe('L756')
  })

  it('正主照旧是正主（原地不动）,真正的第 37 集照旧认领、照旧 swap-hold', () => {
    expect(rowFor(input(), OWNER)).toMatchObject({ verdict: 'claimed', basis: 'authority:L756', action: 'none' })
    expect(rowFor(input(), REAL37)).toMatchObject({ verdict: 'claimed', basis: 'authority:L037', action: 'pending:swap-hold' })
    expect(buildPlan(input()).conservation).toBe(true)
  })
})

/**
 * 地板判据本身（`DURATION_MIN_SIM = 0.3`）。归档器不自己判集，地板只有匹配器那一把尺——
 * 同一份 titleStrip 清洗口径、同一个 bigram 相似度、同一个阈值。这里钉的是"地板两侧各一份"：
 * 时长完全一样、只有名字沾边程度不同,结论必须分开。
 */
describe('名字地板：时长命中还得名字沾边（与匹配器同一把尺）', () => {
  // 对 `454.现代版枪下留人`（清洗后 `现代版枪下留人`）：
  //  · `下留人在江湖飘` 共 2 个 bigram → 0.333 ≥ 0.3 过；· `留人在江湖飘` 共 1 个 → 0.182 不过。
  const OVER = '/src/下留人在江湖飘.mp3'
  const UNDER = '/src/留人在江湖飘.mp3'

  // 同一把尺的直接证据：过了地板，**匹配器自己就把它认下了**（`authority:`），归档器照结论搬。
  it('刚过地板 → 匹配器认领,归档器照搬', () => {
    const input = { ...base(), sourceFiles: [f(OVER, 100, 2605)] }
    expect(actions(input)).toEqual([
      expect.objectContaining({ kind: 'move', dstDir: '/lib/付费', basis: 'authority:L454' }),
    ])
  })

  it('刚不过地板 → 不算命中,出 duration-collision 待裁', () => {
    const input = { ...base(), sourceFiles: [f(UNDER, 100, 2605)] }
    expect(actions(input)).toEqual([
      expect.objectContaining({ kind: 'pending', pendingKind: 'duration-collision' }),
    ])
    expect(rowFor(input, UNDER)).toMatchObject({ verdict: 'offline', basis: 'ambiguous:name-floor:L454' })
  })

  // 地板（0.3）只管"容差内独一份"那条免检路。同一轮两份都撞上这一集时，免检不成立，
  // 走的是本档的 threshold（0.6）——两份都够不着 → 一张问句卡把两份并排摆出来，一份都不搬。
  it('同一轮两份同时长、都够不着门槛 → 一张问句卡带两份，一条 move/replace 都不出', () => {
    const input = { ...base(), sourceFiles: [f(OVER, 100, 2605), f(UNDER, 400, 2605)] }
    const plan = actions(input)
    expect(plan.filter((a) => a.kind !== 'pending')).toEqual([])
    const p = plan.find((a) => a.kind === 'pending') as Extract<PlanAction, { kind: 'pending' }>
    expect(p).toMatchObject({ pendingKind: 'duration-collision', collidesWith: 'L454' })
    expect(p.compare!.candidates.map((c) => c.path).sort()).toEqual([OVER, UNDER].sort())
    // 体量大就上位是**质量**判据,只在"确定同一集"之后才轮得到；这里连是哪一集都没定
    expect(plan.some((a) => a.kind === 'replace')).toBe(false)
  })
})

/**
 * 错身文件撞上另一集的时长（活体 2026-07-31 怡楽播客）。付费货架上两份文件**字节数与时长完全
 * 相同**（92986927 / 5808s），一份叫 `05.太极两仪生四象`、一份叫 `怡乐播客 - 005.身边那些灵异事`；
 * 节目单里的 05 期只有 2164s——所以前者是**错身文件**，名字说 05、时长说不是 05。
 *
 * 这一集的时长桶里因此蹲着两份，但**只有一份名字沾得上边**（0.571 vs 0）——匹配器的零竞争出口
 * （`soleTouching`）认下沾边那份，错身那份不是竞争者、也**不是这一集的其余份**，原样留在池子里。
 * 它自己名字指的 05 期已被真正的第 05 期（2164s）认走，于是它谁都不是 → 走下架货架
 * （不是删除：文件进去立刻是一条独立可播的集）。归档器一如既往没有自己的判据，只照这个结论办。
 */
describe('错身文件撞上另一集的时长：名字沾边那份落位，错身那份各归各处', () => {
  const SIZE = 89 // MiB（活体那份 92986927 字节）
  const D005 = 5808
  const D05 = 2164
  const YILE = [
    { leftKey: 'L005', title: '005.身边那些灵异事', durationS: D005, paid: true, needsSupply: true },
    { leftKey: 'L05', title: '05.太极两仪生四象', durationS: D05, paid: true, needsSupply: true },
  ]
  // 绑定侧的集号是 1–3 位（两套编号在匹配器眼里同号），这正是活体那条绑定的形状。
  const YILE_SPEC = {
    version: DEFAULT_MATCH_SPEC.version,
    stages: [
      { by: 'epnum' as const, epNumRegex: '^(\\d{1,3})\\.', titleStrip: ['【[^】]*】'], threshold: 0.6, margin: 0.15 },
      { by: 'title' as const, titleStrip: ['【[^】]*】'], threshold: 0.85, margin: 0.15 },
    ],
  }
  const WRONG = '/lib/付费/玄关笔记/05.太极两仪生四象.mp3'   // 错身：名字是 05，内容是 005
  const RIGHT = '/lib/付费/怡楽播客 - 005.身边那些灵异事.mp3' // 名字对得上 005
  // 真正的第 05 期（2164s）在来源里等着落位——它把 L05 占住，错身那份才落到 L005 头上。
  const REAL05 = '/src/玄关笔记/05.太极两仪生四象【耗时整理】.mp3'

  const live = (libOrder: string[]): PlanInput => ({
    ...base(), authority: YILE, matchSpec: YILE_SPEC,
    sourceFiles: [f(REAL05, 29, D05)],
    libClaimedFiles: libOrder.map((p) => f(p, SIZE, D005)),
  })

  // 名字沾边的那份被零竞争出口认下（0.571 够不着 threshold 0.6，但另一份是 0——不是竞争者）。
  // 错身那份**没被算成 005 的其余份**：它留在池子里，名字指的 05 期已被真正的第 05 期认走。
  //
  // 于是它谁都不是——但**不是"清单里没有它"**：时长命中 005、名字与 05 逐字相同，两条证据各指
  // 一边（I3）。旧引擎把它静默搬去下架，理由是句假话；现在出卡等人（spec §6 的触发事故）。
  // 三份文件各有结论，一条删除/替换仍然都不出。
  it('活体重放：沾边那份认领 005，错身那份出证据冲突卡，删除/替换一条不出', () => {
    const input = live([WRONG, RIGHT])
    expect(rowFor(input, RIGHT)).toMatchObject({ verdict: 'claimed', basis: 'authority:L005' })
    expect(rowFor(input, REAL05)).toMatchObject({ verdict: 'claimed', episode: '05.太极两仪生四象' })
    // 错身那份：证据指向两集，本轮不搬不删
    expect(rowFor(input, WRONG)).toMatchObject({ verdict: 'offline', basis: 'evidence-conflict:L05,L005' })
    expect(actions(input).some((a) => a.kind === 'move' && a.src.path === WRONG)).toBe(false)
    // 删/换都不可逆,证据只够说"它不是 005 的另一份",不够说"删掉它"
    expect(actions(input).some((a) => a.kind === 'delete-loser' || a.kind === 'replace' || a.kind === 'delete-dup')).toBe(false)
    // 本轮两条待定：错身那份的证据卡 + 真正的第 05 期还在等位（错身那份仍占着玄关笔记里那个名字）。
    // 那个位置**要等人答完这张卡才腾**——机器不再替他猜，代价是多一次点击，换的是不再搬错。
    expect(actions(input).filter((a) => a.kind === 'pending')).toEqual(expect.arrayContaining([
      expect.objectContaining({ pendingKind: 'evidence-conflict', src: expect.objectContaining({ path: WRONG }) }),
      expect.objectContaining({ pendingKind: 'swap-hold', src: expect.objectContaining({ path: REAL05 }) }),
    ]))
    expect(actions(input).filter((a) => a.kind === 'pending')).toHaveLength(2)
  })

  // 答完那张卡 → 位置腾出，等位的第 05 期下一轮自然落位。死锁没有回来，只是多了一次点头。
  it('人答过「都不是这一集」→ 错身那份搬去下架，位置腾出', () => {
    const input = { ...live([WRONG, RIGHT]), notEpisode: (_k: string, path: string) => path === WRONG }
    expect(rowFor(input, WRONG)).toMatchObject({ verdict: 'offline', basis: 'decision:not-episode:L05,L005' })
    expect(actions(input)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'move', src: expect.objectContaining({ path: WRONG }), dstDir: '/lib/下架' }),
    ]))
  })

  it('处理顺序反过来（名字对的那份排在前面）→ 结论不变', () => {
    const input = live([RIGHT, WRONG])
    expect(rowFor(input, RIGHT)).toMatchObject({ verdict: 'claimed', basis: 'authority:L005' })
    expect(rowFor(input, WRONG)).toMatchObject({ verdict: 'offline', basis: 'evidence-conflict:L05,L005' })
  })

  // 错身那份的体量与 005 正主一模一样（SIZE/D005），但**它不是这一集的其余份**——`losers` 的语义
  // 是"同一集的其余份、归宿是按质量判删"。认错成 loser 就会拿它和正主比码率，比出个"换正主"来。
  it('错身那份不进 005 的 copy 筐（它不是这一集的其余份）', () => {
    const input = live([WRONG, RIGHT])
    expect(rowFor(input, WRONG).verdict).not.toBe('copy')
    expect(buildPlan(input).counts.copy).toBe(0)
  })

  // 两套编号（玄关笔记 05 / 主线 005）同号不同集：时长差出量级，contradicts 闸挡住跨集误判，
  // 各归各的集，谁也不删谁。
  it('两套编号同号不同集 → 各自认领，一条删除都不出', () => {
    const input = {
      ...base(), authority: YILE, matchSpec: YILE_SPEC,
      sourceFiles: [f('/src/05.太极两仪生四象.mp3', 29, D05), f('/src/005.身边那些灵异事.mp3', SIZE, D005)],
    }
    const plan = actions(input)
    expect(plan.filter((a) => a.kind === 'delete-loser' || a.kind === 'delete-dup' || a.kind === 'replace')).toEqual([])
    expect(plan).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'move', dstDir: '/lib/付费/玄关笔记', episode: '05.太极两仪生四象' }),
      expect.objectContaining({ kind: 'move', dstDir: '/lib/付费', episode: '005.身边那些灵异事' }),
    ]))
  })
})

/**
 * 质量分不出高下（`tie` / `incomparable`）时**替换往哪个方向**由节目单裁，不由"谁先被认领"。
 * 正主/副本的身份只取决于匹配器认领了谁，与哪份更像这一集无关——照它定方向就是抓阄。
 *
 * 活体（怡楽 780/796，2026-07-31）：节目单说 8274s，来源那份 8274s 被认领当上正主、库内那份
 * 8279s 判副本；差 5 秒 > 容差 → `incomparable`。固定"副本上位"就是在建议删掉与节目单严丝合缝
 * 的那份、留下多 5 秒尾巴的那份。
 */
describe('质量分不出高下 → 方向由节目单裁（判据阶梯）', () => {
  const A780 = { leftKey: 'L780', title: '780.四十五谈身边灵异事', durationS: 8274, paid: true, needsSupply: true }
  const NAMED = '780.四十五谈身边灵异事.mp3'
  /** 名字沾得上这一集（过得了地板）但不如 NAMED 像 → 匹配器认 NAMED 当正主，这份靠时长进"副本"筐。 */
  const NEAR = '780.四十五谈身边灵异事（补档）.mp3'

  // 第 1 档翻转方向：这次是**副本**贴着节目单（8274s）、正主差 1 秒。方向必须跟着翻，
  // 不能因为"正主就是正主"而留下更远的那份。
  it('副本离节目单更近 → replace：删正主、副本上位（basis 指着被删的正主）', () => {
    const input = { ...base(), authority: [...base().authority, A780],
      sourceFiles: [f(`/src/${NAMED}`, 100, 8275)],       // 名字一字不差 → 匹配器认领它当正主
      libClaimedFiles: [f(`/lib/付费/${NEAR}`, 103, 8274)] } // 时长严丝合缝,码率只差 3%（平手）→ 副本
    const out = buildPlan(input)
    const swap = out.actions.find((a) => a.kind === 'replace') as Extract<PlanAction, { kind: 'replace' }>
    expect(swap).toMatchObject({
      src: expect.objectContaining({ path: `/lib/付费/${NEAR}` }),
      oldPath: `/src/${NAMED}`,
      basis: `authority-duration:/src/${NAMED}`,
    })
    expect(out.actions.some((a) => a.kind === 'delete-loser')).toBe(false)
    // 旧正主本轮就要被删 → 那条 move 撤掉（账本行仍在）
    expect(rowFor(input, `/src/${NAMED}`)).toMatchObject({ verdict: 'claimed', action: 'none' })
    expect(out.conservation).toBe(true)
  })

  // 第 1 档分不出（两份时长一模一样、都贴着节目单）→ 掉到第 2 档：**认集身份**与集标题一致的
  // 那份留下。两份都过得了名字地板（都沾边），差别只在"是不是这一集的编号"。
  it('两份时长完全相同 → 第 1 档裁不出，掉到第 2 档按名字裁', () => {
    const D = 5808
    const SIZE = 89 // MiB（活体那份 92986927 字节）
    const LOOSE = '/lib/付费/身边那些灵异事（无编号转存）.mp3' // 沾边过地板,但集身份不是这一集
    const RIGHT = '/lib/付费/005.身边那些灵异事.mp3'          // 集身份 = 这一集
    const input = { ...base(),
      authority: [{ leftKey: 'L005', title: '005.身边那些灵异事', durationS: D }],
      matchSpec: { version: 2 as const, stages: [{ by: 'epnum' as const, epNumRegex: '^(\\d{1,3})\\.', titleStrip: ['【[^】]*】'], threshold: 0.6, margin: 0.15 }] },
      libClaimedFiles: [f(LOOSE, SIZE, D), f(RIGHT, SIZE, D)] }
    const a = actions(input).find((x) => x.kind === 'delete-loser' || x.kind === 'replace')!
    const gone = a.kind === 'delete-loser' ? a.src.path : a.oldPath
    expect(gone).toBe(LOOSE)
    expect(a.basis).toBe(`name-authority:${LOOSE}`) // 不是 authority-duration：第 1 档没裁出来
  })

  // 两档都分不出高下时的兜底由既有用例守着，这里只钉住"没有第三种结论"：
  // 平手 → `quality-loser-of:` 删副本；比不出 → `quality-unknown:` 换正主。
})

/**
 * 本轮就要被删掉的文件，不许还挂着"等下一轮自然落位"。活体 780/796：来源那份既被选成 replace 的
 * `oldPath`（本轮删），又因为货架被同集占着降级成 `swap-hold`（下轮搬）——同一份文件在账本里
 * 既"删你"又"搬你"，前端的"等下一轮"那一组里于是站着一批本轮就不存在了的文件。
 */
describe('被替换掉的那份不再挂着任何"搬进来"的动作', () => {
  const A780 = { leftKey: 'L780', title: '780.四十五谈身边灵异事', durationS: 8274 }
  const OWNER = '/src/780.四十五谈身边灵异事【耗时整理】.mp3' // 时长严丝合缝 → 匹配器认领它当正主
  const TAIL = '/lib/付费/780.四十五谈身边灵异事.mp3'          // 同集、多 5 秒尾巴 → 占着货架
  const RICH = '/lib/付费/780.四十五谈身边灵异事 320k.mp3'      // 同时长、码率高一大截 → 换掉正主

  const input = (): PlanInput => ({ ...base(), authority: [...base().authority, A780],
    sourceFiles: [f(OWNER, 10, 8274)],
    libClaimedFiles: [f(TAIL, 20, 8279), f(RICH, 900, 8274)] })

  it('既是 replace 的 oldPath、又被降级 swap-hold → 动作撤成 none（账本行仍在，守恒不变）', () => {
    const out = buildPlan(input())
    // 正主确实被换掉了（RICH 码率碾压 → quality-upgrade,与判据阶梯无关）
    expect(out.actions.find((a) => a.kind === 'replace')).toMatchObject({ src: expect.objectContaining({ path: RICH }), oldPath: OWNER })
    // …所以它本轮不该再有任何动作：既不搬,也不"等下一轮落位"
    expect(rowFor(input(), OWNER)).toMatchObject({ verdict: 'claimed', action: 'none' })
    expect(out.actions.some((a) => a.kind === 'pending' && a.src.path === OWNER)).toBe(false)
    expect(out.actions.some((a) => a.src.path === OWNER)).toBe(false)
    // 账本照旧一文件一行,守恒成立
    expect(out.rows).toHaveLength(3)
    expect(out.conservation).toBe(true)
  })

  // 别的 pendingKind 讲的是另一回事（探测没跑完 / 目录熔断），不因为"有份文件要被删"而被撤。
  it('no-duration 的 pending 不受影响', () => {
    const out = buildPlan({ ...input(), sourceFiles: [f(OWNER, 10, 8274), f('/src/未知.mp3', 10)] })
    expect(out.actions.some((a) => a.kind === 'pending' && a.pendingKind === 'no-duration')).toBe(true)
  })
})

describe('运行账本（spec §4/§8.7）', () => {
  it('每个进入本轮的文件恰好一行,input === 各筐之和', () => {
    const input = { ...base(),
      sourceFiles: [
        f('/src/750.探秘人体特殊实验.mp3', 111, 1000), // claimed
        f('/src/092.穿衣服.mp3', 100, 777),            // offline
        f('/src/601.毫不相干的一集.mp3', 100, 2605),    // offline（时长撞上 454，名字过不了地板 → 待裁）
        f('/src/未知.mp3', 100),                        // hold
        f('/src/dup/750.探秘人体特殊实验.mp3', 111, 1000), // dup（与上面同集同 size）
        f('/src/09.豁免.mp3', 100, 900),               // exempt
      ],
      libClaimedFiles: [f('/lib/付费/091.前一集.mp3', 500, 1100)], // claimed,原地不动
      verdictFor: (k: string) => (k.includes('豁免') ? 'exempt' as const : null) }
    const out = buildPlan(input)
    expect(out.rows).toHaveLength(7)
    expect(out.counts).toEqual({ input: 7, claimed: 2, offline: 2, copy: 0, hold: 1, dup: 1, exempt: 1 })
    expect(out.conservation).toBe(true)
    // 无动作的行也在（库内被认领原地不动 / 豁免）——缺行就是账本的 bug
    expect(out.rows.filter((r) => r.action === 'none')).toHaveLength(2)
    // basis 一律机器可读的短标识（闭集前缀），不写中文句子——中文只出现在给人读的 pending reason 里
    // 闭集随"归档器只读匹配器结论"一起收窄了：`sole-candidate:`/`duration-hit:`/`identity-hit:`/
    // `duration-collision:` 都是归档器自己判出来的那一套，已随判据一并删掉。
    const BASIS = /^(authority:|same-episode-copy:|ambiguous:|no-duration-hit:|size-dup-of:|decision:|no-duration$)/
    expect(out.rows.filter((r) => !BASIS.test(r.basis))).toEqual([])
    expect(out.authority).toEqual({ entries: 4, paid: 0, withDuration: 4, needsSupply: 0 })
  })

  it('守恒律属性测试：任意输入,账本行数 === 输入文件数（去重后）', () => {
    // 伪随机但确定的一批文件：时长命中/擦边/缺失/重复/豁免全混在一起
    const files: RFile[] = []
    for (let i = 0; i < 60; i++) {
      const d = [1000, 1001, 777, 2605, undefined, 1100][i % 6]
      files.push(f(`/src/${String(100 + i)}.第${i}集.mp3`, 100 + (i % 7), d))
    }
    const libClaimedFiles = files.slice(0, 10).map((x) => ({ ...x, path: `/lib/付费/${x.name}` }))
    const input: PlanInput = { ...base(),
      sourceFiles: files,
      libClaimedFiles,
      libSecondaryFiles: [files[3]].map((x) => ({ ...x, path: `/lib/下架/${x.name}` })),
      verdictFor: (k: string) => (k.includes('第7集') ? 'tombstone' as const : null) }
    const out = buildPlan(input)
    const uniquePaths = new Set([...files, ...libClaimedFiles].map((x) => x.path))
    expect(out.rows).toHaveLength(uniquePaths.size)
    expect(out.counts.input).toBe(uniquePaths.size)
    expect(out.conservation).toBe(true)
    // 每个文件恰好一行（没有重复行）
    expect(new Set(out.rows.map((r) => r.path)).size).toBe(out.rows.length)
    // 时长未知的一份都没被挪走（未知 ≠ 不符）
    const unknown = new Set([...files, ...libClaimedFiles].filter((x) => x.durationS == null).map((x) => x.path))
    expect(out.actions.some((a) => a.kind === 'move' && unknown.has(a.src.path) && a.dstDir === input.dirs.secondary)).toBe(false)
  })
})

describe('决定账本（人工豁免/墓碑先于一切）', () => {
  it('豁免/墓碑 → 不搬不删不报,但账本有行', () => {
    const input = { ...base(),
      sourceFiles: [f('/src/750.探秘人体特殊实验.mp3'), f('/src/092.穿衣服.mp3', 100, 777)],
      verdictFor: (k: string) => (k.includes('750') ? 'exempt' as const : k.includes('092') ? 'tombstone' as const : null) }
    const out = buildPlan(input)
    expect(out.actions).toEqual([])
    expect(out.rows.map((r) => r.basis)).toEqual(['decision:exempt', 'decision:tombstone'])
  })
})

describe('suspect-dir 熔断（判据维持不变，spec §3.3）', () => {
  const rules = { titleStrip: [], epNumRegex: '^(\\d{3})\\.' }
  const shared = {
    subShows: [], dirs: { claimed: '/lib/付费', secondary: '/lib/下架' },
    verdictFor: () => null, identity: makeIdentity(rules), matchSpec: DEFAULT_MATCH_SPEC,
    libClaimedFiles: [], shelf: OPENLIST_TRAITS,
  }
  const g = (name: string, durationS?: number): RFile => ({ path: `/src/来路不明/${name}`, name, size: 1024 * 1024, durationS })

  it('目录内 6/6 进下架 → 全目录降级 pending suspect-dir', () => {
    const files = ['901.甲', '902.乙', '903.丙', '904.丁', '905.戊', '906.己'].map((n) => g(`${n}.mp3`, 100))
    const plan = actions({ ...shared, authority: [{ title: '001.正主', durationS: 500 }], sourceFiles: files, sourceDirs: ['/src/来路不明'] })
    expect(plan).toHaveLength(6)
    for (const a of plan) {
      expect(a.kind).toBe('pending')
      if (a.kind === 'pending') expect(a.pendingKind).toBe('suspect-dir')
    }
  })

  it('绝对数不足(4 个下架) → 不熔断,保持 move 到下架', () => {
    const files = ['901.甲', '902.乙', '903.丙', '904.丁'].map((n) => g(`${n}.mp3`, 100))
    const plan = actions({ ...shared, authority: [{ title: '001.正主', durationS: 500 }], sourceFiles: files, sourceDirs: ['/src/来路不明'] })
    expect(plan.every((a) => a.kind === 'move' && a.dstDir === '/lib/下架')).toBe(true)
  })

  it('占比不过半(4 可疑 / 10 总) → 不熔断', () => {
    const good = ['101.a', '102.b', '103.c', '104.d', '105.e', '106.f']
    const files = [...good.map((n) => g(`${n}.mp3`, 300)), ...['901.甲', '902.乙', '903.丙', '904.丁'].map((n) => g(`${n}.mp3`, 100))]
    const plan = actions({ ...shared, authority: good.map((t) => ({ title: t, durationS: 300 })), sourceFiles: files, sourceDirs: ['/src/来路不明'] })
    expect(plan.filter((a) => a.kind === 'move' && a.dstDir === '/lib/付费')).toHaveLength(6)
    expect(plan.some((a) => a.kind === 'pending' && a.pendingKind === 'suspect-dir')).toBe(false)
  })

  it('未传 sourceDirs → 永不熔断(向后兼容)', () => {
    const files = ['901.甲', '902.乙', '903.丙', '904.丁', '905.戊', '906.己'].map((n) => g(`${n}.mp3`, 100))
    const plan = actions({ ...shared, authority: [{ title: '001.正主', durationS: 500 }], sourceFiles: files })
    expect(plan.every((a) => a.kind === 'move')).toBe(true)
  })

  // MIN(≥5) 与 RATIO(>50%) 是两个独立门槛——都要过才熔断,判据严格大于(恰好 50% 不算)
  it('bad=5/总12(过 MIN 但占比<50%) → 不熔断', () => {
    const good = ['101.a', '102.b', '103.c', '104.d', '105.e', '106.f', '107.g']
    const bad = ['901.甲', '902.乙', '903.丙', '904.丁', '905.戊']
    const files = [...good.map((n) => g(`${n}.mp3`, 300)), ...bad.map((n) => g(`${n}.mp3`, 100))]
    const plan = actions({ ...shared, authority: good.map((t) => ({ title: t, durationS: 300 })), sourceFiles: files, sourceDirs: ['/src/来路不明'] })
    expect(plan.some((a) => a.kind === 'pending' && a.pendingKind === 'suspect-dir')).toBe(false)
    expect(plan.filter((a) => a.kind === 'move' && a.dstDir === '/lib/下架')).toHaveLength(5)
  })

  it('bad=5/总10(恰好 50%,判据严格大于) → 不熔断', () => {
    const good = ['101.a', '102.b', '103.c', '104.d', '105.e']
    const bad = ['901.甲', '902.乙', '903.丙', '904.丁', '905.戊']
    const files = [...good.map((n) => g(`${n}.mp3`, 300)), ...bad.map((n) => g(`${n}.mp3`, 100))]
    const plan = actions({ ...shared, authority: good.map((t) => ({ title: t, durationS: 300 })), sourceFiles: files, sourceDirs: ['/src/来路不明'] })
    expect(plan.some((a) => a.kind === 'pending' && a.pendingKind === 'suspect-dir')).toBe(false)
    expect(plan.filter((a) => a.kind === 'move' && a.dstDir === '/lib/下架')).toHaveLength(5)
  })

  it('bad=6/总10(>50% 且 ≥5) → 熔断,整目录 10 条全降级,不残留 move', () => {
    const good = ['101.a', '102.b', '103.c', '104.d']
    const bad = ['901.甲', '902.乙', '903.丙', '904.丁', '905.戊', '906.己']
    const files = [...good.map((n) => g(`${n}.mp3`, 300)), ...bad.map((n) => g(`${n}.mp3`, 100))]
    const plan = actions({ ...shared, authority: good.map((t) => ({ title: t, durationS: 300 })), sourceFiles: files, sourceDirs: ['/src/来路不明'] })
    expect(plan).toHaveLength(10)
    expect(plan.every((a) => a.kind === 'pending' && a.pendingKind === 'suspect-dir')).toBe(true)
  })

  it('豁免占大头不误熔断：12 文件里 7 个豁免、5 个进下架 → 5/12 不过半,不熔断', () => {
    const exempt = ['201.a', '202.b', '203.c', '204.d', '205.e', '206.f', '207.g']
    const bad = ['901.甲', '902.乙', '903.丙', '904.丁', '905.戊']
    const exemptKeys = new Set(exempt.map((n) => shared.identity(`${n}.mp3`).key))
    const files = [...exempt.map((n) => g(`${n}.mp3`)), ...bad.map((n) => g(`${n}.mp3`, 100))]
    const plan = actions({
      ...shared,
      verdictFor: (k: string) => (exemptKeys.has(k) ? 'exempt' as const : null),
      authority: [{ title: '001.正主', durationS: 500 }],
      sourceFiles: files,
      sourceDirs: ['/src/来路不明'],
    })
    expect(plan).toHaveLength(5)
    expect(plan.every((a) => a.kind === 'move' && a.dstDir === '/lib/下架')).toBe(true)
  })
})

/**
 * 匹配器判不出的那些原样进账本（`PlanOutcome.ambiguities`）。**归档器本轮不消费它**——它还在用
 * 自己那两个入口（`sole-candidate:`/`identity-hit:`）把其中一部分认下来。先记账是为了量：
 * 拆掉那两个入口之前，得知道歧义有多少条、什么形态、拆了会牵动谁（见 docs/TODO.md「匹配收敛」）。
 */
describe('歧义进账本（只记不消费）', () => {
  it('匹配器判不出的那一集出现在 ambiguities 里，带在场候选与理由', () => {
    // 两份都叫 01、标题沾边程度一模一样 → 拉不开差距。**体量必须相等**：不等的话
    // `reduceByQuality` 先按体量选出唯一赢家，压根到不了标题消歧这一步。
    const input: PlanInput = { ...base(),
      authority: [{ leftKey: 'L01', title: '01.甲乙丙丁', durationS: 100 }],
      sourceFiles: [f('/src/01.甲乙丙丁纯享.mp3', 100, 100), f('/src/01.甲乙丙丁重制.mp3', 100, 100)] }
    const out = buildPlan(input)
    expect(out.ambiguities.map((a) => a.leftKey)).toEqual(['L01'])
    expect(out.ambiguities[0].candidates.length).toBeGreaterThan(1)
    expect(out.ambiguities[0].reason).toBeTruthy()
  })

  it('全都配得上时 ambiguities 是空的（别把"没问题"记成有问题）', () => {
    const input = { ...base(), sourceFiles: [f('/src/750.探秘人体特殊实验.mp3')] }
    expect(buildPlan(input).ambiguities).toEqual([])
  })
})

/**
 * 匹配器判不出 ≠ 清单里没有它。
 *
 * 活体 2026-08-01 怡乐：`112.河南洛阳案.mp3` 等三份文件名与节目单那一集**一字不差**（sim 1.000），
 * 被横向时长闸否掉后掉进"清单里没有它"那条兜底路，被规划成**搬去下架货架**。
 * 而机器分不出「分享者贴错了名字」和「节目单时长不准/文件被截断」——`玄关笔记/05.太极两仪生四象`
 * （确是错身文件）与它们结构完全相同。分不出就别动。
 */
describe('判不出的不许当"清单里没有它"搬走', () => {
  const EP = { leftKey: 'L112', title: '112.河南洛阳案', durationS: 3600, paid: true, needsSupply: true }
  const FILE = '/lib/付费/112.河南洛阳案.mp3'
  const live = (): PlanInput => ({ ...base(), authority: [EP], libClaimedFiles: [f(FILE, 100, 1603)] })

  it('名字一字不差、时长被闸否掉 → 出待裁，不出任何 move/delete', () => {
    const out = buildPlan(live())
    expect(out.actions.some((a) => a.kind === 'move' || a.kind === 'delete-dup' || a.kind === 'delete-loser' || a.kind === 'replace')).toBe(false)
    const p = out.actions.find((a) => a.kind === 'pending') as Extract<PlanAction, { kind: 'pending' }>
    expect(p.src.path).toBe(FILE)
    expect(p.episode).toBe('112.河南洛阳案')
    expect(p.collidesWith).toBe('L112')
    // 并排数据要能回答这个问句：节目单说多长、这份多长
    expect(p.compare!.authorityDurationS).toBe(3600)
    expect(p.compare!.candidates.map((c) => c.durationS)).toEqual([1603])
    expect(rowFor(live(), FILE)).toMatchObject({ verdict: 'offline', basis: 'ambiguous:duration-contradiction:L112' })
  })

  it('人裁过「不是这一集」→ 问句消失，按"清单里没有它"走下架（问句必须能收敛）', () => {
    const out = buildPlan({ ...live(), notEpisode: (leftKey, path) => leftKey === 'L112' && path === FILE })
    expect(out.actions).toEqual([expect.objectContaining({ kind: 'move', dstDir: '/lib/下架' })])
  })

  it('真的谁都不沾（名字时长都不指向任何一集）→ 照旧下架，没被这条闸误伤', () => {
    const out = buildPlan({ ...base(), sourceFiles: [f('/src/092.穿衣服.mp3', 100, 777)] })
    expect(out.actions[0]).toMatchObject({ kind: 'move', dstDir: '/lib/下架' })
  })

  /**
   * **活体那三份的真实形状：那几集源站自己放得出**（`needsSupply:false`）。
   *
   * "不需供货的集不发问句"那道闸（`resolve.ts` 的 `note()`）论证的是"问了也白问：处置都一样（删）"，
   * 而这一档处置**不一样**：时长矛盾的候选被 `liveCandidateKeys` 剔掉，走不到 `delete-redundant`，
   * 于是问句一被吞，文件就掉进兜底路**静默搬去下架**——正是本节要拆的那条通道，只是换了个入口。
   */
  it('源站放得出这一集（needsSupply:false）→ 照样出待裁，绝不静默搬去下架', () => {
    const input: PlanInput = {
      ...base(),
      authority: [{ ...EP, paid: false, needsSupply: false }],
      libClaimedFiles: [f(FILE, 100, 1603)],
    }
    const out = buildPlan(input)
    expect(out.actions.some((a) => a.kind === 'move' || a.kind === 'delete-redundant')).toBe(false)
    const p = out.actions.find((a) => a.kind === 'pending') as Extract<PlanAction, { kind: 'pending' }>
    expect(p).toMatchObject({ pendingKind: 'duration-collision', episode: '112.河南洛阳案', collidesWith: 'L112' })
    // 文案必须是第 3 格那句诚实的话（两种可能都说出口），不是"机器分不出它属于哪一集"。
    expect(p.reason).toContain('可能是分享者贴错了名字')
    expect(rowFor(input, FILE)).toMatchObject({ verdict: 'offline', basis: 'ambiguous:duration-contradiction:L112' })
  })

  /**
   * **另一条来路：这份文件同时还沾着别的集，于是它掉进的是 I3 冲突卡而不是静默下架**
   * （活体 `104.清华大学朱令案.mp3`：名字与 104 一字不差、时长差出量级，又恰好撞上另一集的时长）。
   *
   * 冲突卡问的是"它属于哪一集"，可这里**每条边都被事实级否决或名字为零**——机器真正的判断是
   * "这两集它都不是"。集侧那句话（"可能贴错名字，也可能节目单时长不准或被截断"）才是实话，
   * 而它过去同样被闸吞掉。闸一收窄，这一格自己就回到第 3 格，不需要再给冲突卡加一种分型。
   */
  it('还沾着另一集（I3 冲突卡那条来路）→ 也回到第 3 格，说的是集侧那句实话', () => {
    const FREE = { leftKey: 'L104', title: '104.清华大学朱令案', durationS: 3600, paid: false, needsSupply: false }
    const OTHER = { leftKey: 'L29', title: '29.十神的生克关系', durationS: 1989, paid: true, needsSupply: true }
    const input: PlanInput = {
      ...base(), authority: [FREE, OTHER],
      libClaimedFiles: [f('/lib/付费/104.清华大学朱令案.mp3', 100, 1989), f('/lib/付费/29.十神的生克关系.mp3', 200, 1989)],
    }
    const out = buildPlan(input)
    const p = out.actions.find((a) => a.kind === 'pending') as Extract<PlanAction, { kind: 'pending' }>
    expect(p).toMatchObject({ pendingKind: 'duration-collision', collidesWith: 'L104' })
    expect(p.src.path).toBe('/lib/付费/104.清华大学朱令案.mp3')
    expect(p.reason).toContain('可能是分享者贴错了名字')
    expect(out.actions.some((a) => a.kind === 'pending' && a.pendingKind === 'evidence-conflict')).toBe(false)
  })

  /** 活体 2026-08-02 怡楽那一整组：三份文件、三集、全 `needsSupply:false`——一份都不许静默下架。 */
  it('活体三份（112/116/268）→ 三张卡，一条 move/delete 都不出', () => {
    const eps = [
      { leftKey: 'L112', title: '112.河南洛阳案', durationS: 3600 },
      { leftKey: 'L116', title: '116.安特卫普金库案', durationS: 3600 },
      { leftKey: 'L268', title: '268.三十六年未破悬案', durationS: 3600 },
    ].map((e) => ({ ...e, paid: false, needsSupply: false }))
    const files = eps.map((e) => f(`/lib/付费/${e.title}.mp3`, 100, 1603))
    const out = buildPlan({ ...base(), authority: eps, libClaimedFiles: files })
    expect(out.actions.filter((a) => a.kind !== 'pending')).toEqual([])
    expect(out.actions.map((a) => (a as Extract<PlanAction, { kind: 'pending' }>).collidesWith).sort())
      .toEqual(['L112', 'L116', 'L268'])
    expect(out.rows.every((r) => r.action.startsWith('pending:duration-collision'))).toBe(true)
  })
})

/**
 * **付费货架契约**（2026-08-01 拍板）：那个货架只放「`paid` ∧ 匹配器认领」的文件。认领了、但那一集
 * 源站自己放得出（`paid === false`）→ 网盘这份没有存在价值，直接删（`delete-redundant`）。
 * 不进确认档：分享链接转存成本极低，夸克回收站还兜着底；攒成一屏要人逐条点头反而没人看。
 *
 * 这一节最锋利的边界是 `paid === undefined`——tmdb 影视绑定的清单压根没有 paid 这回事，
 * 而 `undefined` 与 `false` 的区别正是"网盘是唯一来源"与"源站自己能播"。写成 `!entry.paid`
 * 就会把整个影视库判成冗余删光，所以下面那条 undefined 的用例是这一节真正的守门人。
 */
describe('付费货架契约：免费集的网盘副本直接删', () => {
  const FREE = { leftKey: 'LF', title: '600.免费那一集', durationS: 1500, paid: false, needsSupply: false }
  const PAID = { leftKey: 'LP', title: '601.付费那一集', durationS: 1600, paid: true, needsSupply: true }
  /** 影视那支：清单来自 tmdb 分集索引，压根没有 paid 这回事。 */
  const TMDB = { leftKey: 'tmdb:9:S01E01', title: '第一集', durationS: 2700 }
  const withAuthority = (...entries: typeof FREE[]) => ({ ...base(), authority: entries })

  it('来源目录里的免费集副本 → delete-redundant（不搬进货架，也不留在来源）', () => {
    const input = { ...withAuthority(FREE), sourceFiles: [f('/src/600.免费那一集.mp3', 100, 1500)] }
    expect(actions(input)).toEqual([
      expect.objectContaining({ kind: 'delete-redundant', basis: 'redundant-free:LF', episode: '600.免费那一集' }),
    ])
    // 认领结论没变、变的是处置——账本的筐仍是 claimed
    expect(rowFor(input, '/src/600.免费那一集.mp3')).toMatchObject({ verdict: 'claimed', basis: 'redundant-free:LF', action: 'delete-redundant' })
  })

  it('已经躺在付费货架上的免费集副本 → 同样删（货架干净就是契约）', () => {
    const input = { ...withAuthority(FREE), libClaimedFiles: [f('/lib/付费/600.免费那一集.mp3', 100, 1500)] }
    expect(actions(input)).toEqual([
      expect.objectContaining({ kind: 'delete-redundant', src: expect.objectContaining({ path: '/lib/付费/600.免费那一集.mp3' }) }),
    ])
  })

  it('同一集的其余份随集一起清（正主都删了，再比一次质量纯属白比）', () => {
    const input = {
      ...withAuthority(FREE),
      sourceFiles: [f('/src/600.免费那一集.mp3', 100, 1500), f('/src/600.免费那一集（补档）.mp3', 200, 1500)],
    }
    const plan = actions(input)
    expect(plan.filter((a) => a.kind === 'delete-redundant')).toHaveLength(2)
    expect(plan.some((a) => a.kind === 'delete-loser' || a.kind === 'replace')).toBe(false)
    // 一条走认领筐、一条走同集其余份筐（匹配器交出来的 losers），两条都落到同一个处置上
    expect(rowFor(input, '/src/600.免费那一集.mp3')).toMatchObject({ verdict: 'claimed' })
    expect(rowFor(input, '/src/600.免费那一集（补档）.mp3')).toMatchObject({ verdict: 'copy', basis: 'redundant-free:LF' })
  })

  it('paid:true 一份都不删，照常搬进付费货架', () => {
    const input = { ...withAuthority(PAID), sourceFiles: [f('/src/601.付费那一集.mp3', 100, 1600)] }
    expect(actions(input)).toEqual([expect.objectContaining({ kind: 'move', dstDir: '/lib/付费', basis: 'authority:LP' })])
  })

  // 这一条是本节的守门人：影视绑定的清单没有 paid（`undefined`），网盘那份就是唯一来源。
  it('paid 缺席（tmdb 影视）→ 照常搬，绝不删', () => {
    const input = {
      ...base(), authority: [TMDB], matchSpec: DEFAULT_MATCH_SPEC,
      sourceFiles: [f('/src/Show.S01E01.mkv', 9e8, 2700)],
    }
    const plan = actions(input)
    expect(plan).toEqual([expect.objectContaining({ kind: 'move', dstDir: '/lib/付费' })])
    expect(plan.some((a) => a.kind === 'delete-redundant')).toBe(false)
  })

  it('免费集但**没被认领**（判不出/清单里没有它）→ 不删，走原来的问句/下架那条路', () => {
    const input = { ...withAuthority(FREE), sourceFiles: [f('/src/谁都不沾的文件.mp3', 100, 99)] }
    expect(actions(input)).toEqual([expect.objectContaining({ kind: 'move', dstDir: '/lib/下架' })])
  })

  it('守恒不破：每个进本轮的文件恰好一行', () => {
    const input = {
      ...withAuthority(FREE, PAID),
      sourceFiles: [f('/src/600.免费那一集.mp3', 100, 1500), f('/src/601.付费那一集.mp3', 100, 1600), f('/src/谁都不沾.mp3', 100, 99)],
    }
    const out = buildPlan(input)
    expect(out.conservation).toBe(true)
    expect(out.rows).toHaveLength(3)
    expect(out.counts.input).toBe(3)
  })
})

/**
 * **不需供货的集，不值得问也不值得留**（2026-08-02 拍板）。上一节管的是"认领了、但那一集免费"，
 * 这一节管**没被认领**的那一半：证据指着的那几集**全都不需要网盘供货** → 这份文件不论是其中哪一集，
 * 处置都一样（删），"是哪一集"这个问题就不值得占用户一次注意力。
 *
 * 活体（怡楽）：`37.申与酉.mp3` 的时长同时撞上三集，出了一张"是不是《037.三谈身边灵异事》"的卡——
 * 而那三集源站全放得出。卡片无论怎么答都通向同一个动作。
 *
 * 两条护栏各有一条用例守着，都在这一节里：
 *  · **零候选不删**（清单里真的没有它）→ 照旧上下架货架。删的依据是"证据指向的集都不需要供货"，
 *    没有证据就没有依据。
 *  · **`paid === undefined` 不删**（tmdb 影视：网盘是唯一来源）。写成 `!paid` 会把整个影视库删光。
 */
describe('不需供货的集：不发问句，也不留冗余副本', () => {
  /** 37.申与酉 的形状：时长同时撞上两集、名字一个字不沾，谁都没认领它。 */
  const COLLIDE = f('/src/玄关笔记/37.申与酉.mp3', 100, 3000)
  const free = (leftKey: string, title: string) => ({ leftKey, title, durationS: 3000, paid: false, needsSupply: false })
  const paid = (leftKey: string, title: string) => ({ leftKey, title, durationS: 3000, paid: true, needsSupply: true })
  /** 影视那支：清单来自 tmdb 分集索引，`paid` 这个概念压根不在场。 */
  const tmdb = (leftKey: string, title: string) => ({ leftKey, title, durationS: 3000 })

  it('活候选全不需供货 → 直接删，不出卡（37.申与酉 那张卡就此消失）', () => {
    const input = {
      ...base(),
      authority: [free('L037', '037.三谈身边灵异事'), free('L038', '038.四谈身边灵异事')],
      sourceFiles: [COLLIDE],
    }
    const out = buildPlan(input)
    expect(out.actions).toEqual([
      expect.objectContaining({ kind: 'delete-redundant', basis: 'redundant-free-candidates:L037,L038' }),
    ])
    // 判定筐仍是 offline——匹配器确实没把它认到任何一集头上，变的只是处置。
    expect(rowFor(input, COLLIDE.path)).toMatchObject({ verdict: 'offline', action: 'delete-redundant' })
    // `episode` 留空：没有确定的那一集，不许拿其中一个候选冒充。
    expect((out.actions[0] as Extract<PlanAction, { kind: 'delete-redundant' }>).episode).toBeUndefined()
    expect(out.conservation).toBe(true)
    expect(out.rows).toHaveLength(1)
  })

  it('只有一个候选、且不需供货 → 同样删（集侧问句被闸掉了，不该退化成 duration-collision）', () => {
    const input = { ...base(), authority: [free('L037', '037.三谈身边灵异事')], sourceFiles: [COLLIDE] }
    expect(actions(input)).toEqual([
      expect.objectContaining({ kind: 'delete-redundant', basis: 'redundant-free-candidates:L037' }),
    ])
  })

  /**
   * **候选集的标题要跟着 `basis` 一起下发**（`candidateEpisodes`）。`basis` 里那串
   * `redundant-free-candidates:L037,L038` 是机器可读的 leftKey，卡片上摆出来没人读得懂——
   * 活体那张卡的原因句写着"这一集源站自己能播"，而卡上唯一出现的名字是文件名 `37.申与酉`，
   * 用户据此以为是付费判断错了。真正的依据是那几个 leftKey 对应的集，前端一个都拿不到。
   *
   * **顺序必须与 `basis` 里的 leftKey 逐位对齐**：卡片文案要如实说"可能是这几集之一"，
   * 而诊断时要能拿卡上的名字回头对上 `basis` 那串键。两边错位就没法互相校验。
   */
  describe('候选集的标题（candidateEpisodes）——卡片要说得出"推测是哪几集"', () => {
    const redundantOf = (input: PlanInput) =>
      actions(input)[0] as Extract<PlanAction, { kind: 'delete-redundant' }>

    it('多个候选 → 每个 leftKey 的标题都带上，顺序与 basis 逐位对齐', () => {
      const input = {
        ...base(),
        authority: [free('L037', '037.三谈身边灵异事'), free('L038', '038.四谈身边灵异事')],
        sourceFiles: [COLLIDE],
      }
      const a = redundantOf(input)
      expect(a.basis).toBe('redundant-free-candidates:L037,L038')
      expect(a.candidateEpisodes).toEqual(['037.三谈身边灵异事', '038.四谈身边灵异事'])
    })

    it('只有一个候选 → 也带（那一条文案要说得出"实际对应哪一集"）', () => {
      const input = { ...base(), authority: [free('L037', '037.三谈身边灵异事')], sourceFiles: [COLLIDE] }
      expect(redundantOf(input).candidateEpisodes).toEqual(['037.三谈身边灵异事'])
    })

    // 认领成立那一条已经有确定的 `episode` 了，再塞一份候选名单只会让前端多一个岔路口。
    it('认领成立那条（redundant-free:<leftKey>）不带候选名单——它有确定的 episode', () => {
      const input = {
        ...base(),
        authority: [{ leftKey: 'LF', title: '600.免费那一集', durationS: 1500, paid: false, needsSupply: false }],
        sourceFiles: [f('/src/600.免费那一集.mp3', 100, 1500)],
      }
      const a = redundantOf(input)
      expect(a.basis).toBe('redundant-free:LF')
      expect(a.episode).toBe('600.免费那一集')
      expect(a.candidateEpisodes).toBeUndefined()
    })
  })

  // ── 护栏一：没有证据就没有依据 ──────────────────────────────────────────────
  it('零候选（清单里真的没有它）→ 照旧上下架货架，绝不删', () => {
    const input = {
      ...base(),
      authority: [free('L037', '037.三谈身边灵异事'), free('L038', '038.四谈身边灵异事')],
      sourceFiles: [f('/src/谁都不沾的一期.mp3', 100, 99)],
    }
    const plan = actions(input)
    expect(plan.some((a) => a.kind === 'delete-redundant')).toBe(false)
    expect(plan).toEqual([expect.objectContaining({ kind: 'move', dstDir: '/lib/下架' })])
  })

  // 落点守卫（不是行为断言）：这一条钉的是**分支顺序**——把上面那个分支挪到 `no-duration`
  // 之前就会红。时长没探到时证据本身残缺，拿它当"证据指向哪几集"用就是拿未知当已知。
  it('时长还没探到 → 先续探，证据不全不许据此删', () => {
    const input = {
      ...base(),
      authority: [free('L037', '037.三谈身边灵异事'), free('L038', '038.四谈身边灵异事')],
      sourceFiles: [f('/src/玄关笔记/37.申与酉.mp3', 100, undefined)],
    }
    const plan = actions(input)
    expect(plan.some((a) => a.kind === 'delete-redundant')).toBe(false)
    expect(plan).toEqual([expect.objectContaining({ kind: 'pending', pendingKind: 'no-duration' })])
  })

  it('人裁过「不是这一集」的候选不算数：人说了不是，那条证据就作废（照旧走下架）', () => {
    const input = {
      ...base(),
      authority: [free('L037', '037.三谈身边灵异事')],
      sourceFiles: [COLLIDE],
      notEpisode: (leftKey: string, path: string) => leftKey === 'L037' && path === COLLIDE.path,
    }
    const plan = actions(input)
    expect(plan.some((a) => a.kind === 'delete-redundant')).toBe(false)
    expect(plan).toEqual([expect.objectContaining({ kind: 'move', dstDir: '/lib/下架' })])
  })

  // ── 护栏二：undefined 不是 false（影视全库的命） ────────────────────────────
  it('paid 缺席（tmdb 影视）→ 一份都不删，照旧出卡等人', () => {
    const input = {
      ...base(),
      authority: [tmdb('tmdb:9:S01E01', '第一集'), tmdb('tmdb:9:S01E02', '第二集')],
      sourceFiles: [COLLIDE],
    }
    const plan = actions(input)
    expect(plan.some((a) => a.kind === 'delete-redundant')).toBe(false)
    // 集侧问句照发（谁都要供货）→ 先登记的那一集出 duration-collision，与本改动前逐字相同。
    expect(plan).toEqual([expect.objectContaining({ kind: 'pending', pendingKind: 'duration-collision', collidesWith: 'tmdb:9:S01E01' })])
  })

  it('混着一个要供货的候选 → 仍出卡，且卡只问那一集（免费那一集的问句被闸掉了）', () => {
    const input = {
      ...base(),
      authority: [free('L037', '037.三谈身边灵异事'), paid('L038', '038.四谈身边灵异事')],
      sourceFiles: [COLLIDE],
    }
    const plan = actions(input)
    expect(plan.some((a) => a.kind === 'delete-redundant')).toBe(false)
    // 问的是 L038——L037 免费，它是不是那一集不改变任何动作，不该占卡面。
    expect(plan).toEqual([expect.objectContaining({ kind: 'pending', pendingKind: 'duration-collision', collidesWith: 'L038' })])
  })
})

/**
 * **处置层只读 `needsSupply`，一个字都不读 `paid`**（2026-08-02 反转）。
 *
 * 反转的是**默认方向**：原来 `needsSupply = (paid !== false)`——「默认不用供货，只有证明这集要钱
 * 才要供货」。而 `content.paid` 全仓唯一注入点（`content/normalize.ts` 的 `withPaid`）只在
 * `price > 0` 时写 `true`，其余一律不写，于是「源站没给音频地址、但也不要钱」的 app 独占集
 * （活体：怡楽 948/949）被读成 `paid === false` → 网盘那份判冗余删掉，而它是唯一来源。
 *
 * 现在判据在清单那一侧算好（`left-from-stream.ts` 的 `hasPlayableMedia`：这一集自己带没带可播
 * 地址），归档器只消费结论。**这一节钉的就是「读的是哪一个字段」**：两个字段故意给成矛盾值，
 * 谁说了算一目了然。
 */
describe('处置层的那一位是 needsSupply，不是 paid', () => {
  const withAuthority = (...entries: { leftKey: string; title: string; durationS?: number; paid?: boolean; needsSupply?: boolean }[]) =>
    ({ ...base(), authority: entries })
  /** 948/949 的形状：源站没给地址（要供货），也没人说它要钱（`paid: false`）。 */
  const APP_ONLY = { leftKey: 'L948', title: '948.这位特别好玩儿的机车博主', durationS: 5497, paid: false, needsSupply: true }
  /** 真·免费集：源站自带可播地址。 */
  const FREE = { leftKey: 'LF', title: '600.免费那一集', durationS: 1500, paid: false, needsSupply: false }

  it('`paid:false` 但要供货（app 独占集）→ 照常搬进货架，一份都不删', () => {
    const input = { ...withAuthority(APP_ONLY), sourceFiles: [f('/src/948.这位特别好玩儿的机车博主.mp3', 100, 5497)] }
    const plan = actions(input)
    expect(plan.some((a) => a.kind === 'delete-redundant')).toBe(false)
    expect(plan).toEqual([expect.objectContaining({ kind: 'move', dstDir: '/lib/付费', basis: 'authority:L948' })])
  })

  it('`needsSupply:false` → 删（不必也标着 paid:false，判据就它一个）', () => {
    const input = {
      ...withAuthority({ leftKey: 'LX', title: '601.源站放得出的一集', durationS: 1600, needsSupply: false }),
      sourceFiles: [f('/src/601.源站放得出的一集.mp3', 100, 1600)],
    }
    expect(actions(input)).toEqual([expect.objectContaining({ kind: 'delete-redundant', basis: 'redundant-free:LX' })])
  })

  it('同集其余份跟着走 needsSupply：`paid:false` 但要供货 → 出确认档，不是整集清掉', () => {
    const input = {
      ...withAuthority(APP_ONLY),
      sourceFiles: [f('/src/948.这位特别好玩儿的机车博主.mp3', 200, 5497), f('/src/948.这位特别好玩儿的机车博主（补档）.mp3', 100, 5497)],
    }
    const plan = actions(input)
    expect(plan.some((a) => a.kind === 'delete-redundant')).toBe(false)
    expect(plan.some((a) => a.kind === 'delete-loser')).toBe(true)
  })

  it('没人认领时的候选闸也读 needsSupply：候选都 `paid:false` 但都要供货 → 照旧出卡', () => {
    const collide = f('/src/玄关笔记/37.申与酉.mp3', 100, 3000)
    const input = {
      ...withAuthority(
        { leftKey: 'L037', title: '037.三谈身边灵异事', durationS: 3000, paid: false, needsSupply: true },
        { leftKey: 'L038', title: '038.四谈身边灵异事', durationS: 3000, paid: false, needsSupply: true },
      ),
      sourceFiles: [collide],
    }
    const plan = actions(input)
    expect(plan.some((a) => a.kind === 'delete-redundant')).toBe(false)
    expect(plan).toEqual([expect.objectContaining({ kind: 'pending', pendingKind: 'duration-collision' })])
  })

  it('下架货架复核也读 needsSupply：`paid:false` 但要供货 → 回流，不是删', () => {
    const input = { ...withAuthority(APP_ONLY), libSecondaryFiles: [f('/lib/下架/948.这位特别好玩儿的机车博主.mp3', 100, 5497)] }
    const plan = actions(input)
    expect(plan.some((a) => a.kind === 'delete-redundant')).toBe(false)
    expect(plan).toEqual([expect.objectContaining({ kind: 'move', dstDir: '/lib/付费', basis: 'relisted:L948' })])
  })

  // 字节全等那一档的删除闸（`dedupAction`）同样换尺：清单**明说**要供货的集，它的网盘副本可能是
  // 唯一可播来源，`delete-dup`（唯一不经人眼即删的动作）必须降级成确认档。
  it('字节全等副本：明说要供货的集降级成确认档（delete-loser），源站放得出的照旧自动去重', () => {
    // 看的是**来源那份**（字节全等落选的那一份）的处置。FREE 那一路库内那份随后还会被付费货架
    // 契约判 delete-redundant，与这道闸无关，所以按路径取，不按动作条数断言。
    const dedupOf = (entry: typeof APP_ONLY, name: string) => actions({
      ...withAuthority(entry),
      libClaimedFiles: [f(`/lib/付费/${name}`, 100, entry.durationS)],
      sourceFiles: [f(`/src/${name}`, 100, entry.durationS)],
    }).find((a) => a.src.path === `/src/${name}`)
    expect(dedupOf(APP_ONLY, '948.这位特别好玩儿的机车博主.mp3')).toMatchObject({ kind: 'delete-loser' })
    expect(dedupOf(FREE, '600.免费那一集.mp3')).toMatchObject({ kind: 'delete-dup' })
  })

  // 喂进匹配器的那一位（`SpecLeft.needsSupply`）与处置层必须同源——两侧分家就会出现
  // 「没问句、却照旧出卡」这类只在活体现形的错位。
  it('喂进匹配器的 needsSupply 与处置层同源：要供货的集照旧发问句', () => {
    const input = {
      ...withAuthority(APP_ONLY, { leftKey: 'L949', title: '949.趣谈《西游记》', durationS: 5497, paid: false, needsSupply: true }),
      sourceFiles: [f('/src/谁都不沾名字的一期.mp3', 100, 5497)],
    }
    expect(actions(input)).toEqual([expect.objectContaining({ kind: 'pending', pendingKind: 'duration-collision' })])
  })
})

/**
 * **人工覆盖：`matchSpec.needsSupply`**（2026-08-02）。
 *
 * 算出来的那一位有它够不着的情形：源站给了地址、但那地址早失效；或者给的音质差到不能听。
 * 人知道、机器不知道，所以要有一个说了算的口子。
 *
 * **落在 `matchSpec` 上，粒度是整个绑定**。两个理由：
 *  · `matchSpec` 本来就是"这个绑定的特殊规则"所在，而供货与否恰恰按绑定变（同一条 stream 绑到
 *    不同目录，策略可以不同）。放 stream 配置是错的——那是"这个源怎么采"。
 *  · **不做 leftKey 列表**：订阅流的 leftKey 是 `item:<id>`，item id 会随重新采集变
 *    （同 id 重建、renormalize、换 recipe 都动它）。一份按 id 写死的名单会**悄悄失效**——
 *    一个保护用的开关最坏的失败方式就是"看起来还在、其实已经不保护了"。整绑定一刀切没有键可烂。
 *
 * 缺省 = 自动算。填了以填的为准，两个方向都认。
 */
describe('人工覆盖：matchSpec.needsSupply 说了算', () => {
  /** 清单说"源站自己放得出"，但人知道那地址已经失效。 */
  const FREE = { leftKey: 'LF', title: '600.免费那一集', durationS: 1500, paid: false, needsSupply: false }
  /** 清单说"要供货"。 */
  const APP_ONLY = { leftKey: 'L948', title: '948.这位特别好玩儿的机车博主', durationS: 5497, needsSupply: true }
  const withOverride = (entry: typeof FREE | typeof APP_ONLY, needsSupply?: boolean, file?: RFile) => ({
    ...base(),
    authority: [entry],
    matchSpec: { ...DEFAULT_MATCH_SPEC, ...(needsSupply != null ? { needsSupply } : {}) },
    sourceFiles: [file ?? f(`/src/${entry.title}.mp3`, 100, entry.durationS)],
  })

  it('覆盖成"要供货" → 清单说不用也不删（源站地址失效那一类）', () => {
    const plan = actions(withOverride(FREE, true))
    expect(plan.some((a) => a.kind === 'delete-redundant')).toBe(false)
    expect(plan).toEqual([expect.objectContaining({ kind: 'move', dstDir: '/lib/付费', basis: 'authority:LF' })])
  })

  it('覆盖成"不用供货" → 清单说要供货也照删', () => {
    expect(actions(withOverride(APP_ONLY, false))).toEqual([
      expect.objectContaining({ kind: 'delete-redundant', basis: 'redundant-free:L948' }),
    ])
  })

  it('缺省（不填）→ 走自动算，两个方向都是清单说了算', () => {
    expect(actions(withOverride(FREE))).toEqual([expect.objectContaining({ kind: 'delete-redundant' })])
    expect(actions(withOverride(APP_ONLY))).toEqual([expect.objectContaining({ kind: 'move', dstDir: '/lib/付费' })])
  })

  // 覆盖是**整条判据**的覆盖，不是只盖主循环那一处：字节全等的降级闸也跟着走，否则会出现
  // "这条绑定被判成要供货、它的重复副本却照旧自动删"的半截状态。
  it('字节全等的降级闸也跟着覆盖走', () => {
    const dedupOf = (needsSupply?: boolean) => actions({
      ...withOverride(FREE, needsSupply),
      libClaimedFiles: [f('/lib/付费/600.免费那一集.mp3', 100, 1500)],
    }).find((a) => a.src.path === '/src/600.免费那一集.mp3')
    expect(dedupOf(true)).toMatchObject({ kind: 'delete-loser' })   // 覆盖成要供货 → 确认档
    expect(dedupOf(undefined)).toMatchObject({ kind: 'delete-dup' }) // 缺省 → 清单说免费 → 自动去重
  })
})

/**
 * **下架货架每轮回头看**（2026-08-01 拍板）。它过去只进不出：源站把某集重新上架、或免费集副本
 * 被错放进去，抽屉就这么悄悄变脏，没有任何机制会发现。
 *
 * 做法是**同一个匹配脑多调一次**（权威清单为左、只有下架文件为右），不是第二个脑：判据一行没改，
 * 结论只用于货架卫生。**只认 `auto`**——把抽屉里的陈年文件翻成一堆新问句只会把面板淹掉。
 */
describe('下架货架每轮回头看', () => {
  const PAID = { leftKey: 'LP', title: '801.付费那一集', durationS: 1300, paid: true, needsSupply: true }
  const FREE = { leftKey: 'LF', title: '600.免费那一集', durationS: 1500, paid: false, needsSupply: false }
  const shelfOf = (...files: RFile[]) => ({ ...base(), authority: [PAID, FREE], libSecondaryFiles: files })
  const SHELF_PAID = '/lib/下架/801.付费那一集.mp3'

  it('paid 集重新上架、本轮无人认领 → move 回付费货架（relisted:）', () => {
    const input = shelfOf(f(SHELF_PAID, 100, 1300))
    expect(actions(input)).toEqual([
      expect.objectContaining({ kind: 'move', dstDir: '/lib/付费', basis: 'relisted:LP', episode: '801.付费那一集' }),
    ])
    expect(buildPlan(input).secondaryReview).toMatchObject({ checked: 1, rows: [{ verdict: 'claimed', basis: 'relisted:LP' }] })
  })

  it('paid 集已有正主 → 它是同集另一份，出确认档（不自动删）', () => {
    const input = {
      ...shelfOf(f(SHELF_PAID, 100, 1300)),
      libClaimedFiles: [f('/lib/付费/801.付费那一集.mp3', 200, 1300)],
    }
    const plan = actions(input)
    expect(plan).toEqual([
      expect.objectContaining({
        kind: 'delete-loser', keptPath: '/lib/付费/801.付费那一集.mp3', basis: 'shelf-copy-of:/lib/付费/801.付费那一集.mp3',
      }),
    ])
    // 确认档：并排数据必须带全，那个确认按钮才按得下去
    const a = plan[0] as Extract<PlanAction, { kind: 'delete-loser' }>
    expect(a.compare!.authorityDurationS).toBe(1300)
    expect(a.compare!.candidates.map((c) => c.path)).toEqual([SHELF_PAID, '/lib/付费/801.付费那一集.mp3'])
  })

  it('免费集的副本混在下架货架上 → delete-redundant（与主池同一条规则）', () => {
    const input = shelfOf(f('/lib/下架/600.免费那一集.mp3', 100, 1500))
    expect(actions(input)).toEqual([
      expect.objectContaining({ kind: 'delete-redundant', basis: 'redundant-free:LF' }),
    ])
  })

  it('没命中 → 那正是它该在的地方，不动（绝大多数）', () => {
    const input = shelfOf(f('/lib/下架/清单里没有的一集.mp3', 100, 99))
    expect(actions(input)).toEqual([])
    expect(buildPlan(input).secondaryReview).toEqual({ checked: 1, rows: [] })
  })

  /**
   * **这一位缺席的清单（tmdb 影视）现在走「要供货」那条路**——2026-08-02 判据反转前，这里读的是
   * `paid === undefined` → 一律不碰。反转后没有第三态了：答不上来就是要供货，货架上这一份于是
   * 与 app 独占集同路（本轮没人认领 → 回流）。
   *
   * 这不是放松，是补一个真缺口：怡楽有真实的下架货架和 167 条「源站没给地址、也不要钱」的集，
   * 旧判据下它们的文件一旦进了抽屉就永远出不来（`paid !== true` 直接 continue）。方向也安全，
   * 多出来的两种处置一个是搬回来、一个要人点头，没有一条会自动删。
   */
  it('这一位缺席（tmdb 影视）→ 按要供货办：本轮没人认领就回流，不是原地不动', () => {
    const input = {
      ...base(), authority: [{ leftKey: 'tmdb:9:S01E01', title: '第一集', durationS: 2700 }],
      libSecondaryFiles: [f('/lib/下架/Show.S01E01.mkv', 9e8, 2700)],
    }
    const plan = actions(input)
    expect(plan.some((a) => a.kind === 'delete-redundant')).toBe(false)
    expect(plan).toEqual([expect.objectContaining({ kind: 'move', dstDir: '/lib/付费', basis: 'relisted:tmdb:9:S01E01' })])
  })

  // 只认 auto：名字够不着门槛的（问句/没把握）一律无动作——不确定就不折腾。
  it('复核判不出（名字够不着门槛）→ 无动作，也不出问句卡', () => {
    const input = shelfOf(f('/lib/下架/801.付费那一集【某分享者的一长串水印装饰后缀】.mp3', 100, 999))
    expect(actions(input)).toEqual([])
    expect(buildPlan(input).secondaryReview.rows).toEqual([])
  })

  /**
   * **P8 契约不动**：下架货架的文件不和来源/付费货架的文件抢认领。同一集同时有来源文件和下架
   * 文件时，主池的认领结果必须与"根本没有下架货架"完全一致——两次匹配各自独立。
   */
  it('主池认领不受复核影响：有没有下架货架，主池结论一字不差', () => {
    const src = f('/src/801.付费那一集.mp3', 300, 1300)
    const withShelf = buildPlan({ ...shelfOf(f(SHELF_PAID, 100, 1300)), sourceFiles: [src] })
    const without = buildPlan({ ...base(), authority: [PAID, FREE], sourceFiles: [src] })
    expect(withShelf.rows).toEqual(without.rows)
    expect(withShelf.counts).toEqual(without.counts)
    // 来源那份照常认领落位；货架那份成了同集另一份 → 确认档，不是回流
    expect(withShelf.actions.filter((a) => a.kind === 'move')).toEqual(without.actions.filter((a) => a.kind === 'move'))
    expect(withShelf.actions.some((a) => a.kind === 'delete-loser' && a.src.path === SHELF_PAID)).toBe(true)
  })

  it('账本：复核不并进主池的 rows/counts，守恒不破', () => {
    const out = buildPlan({ ...shelfOf(f(SHELF_PAID, 100, 1300)), sourceFiles: [f('/src/谁都不沾.mp3', 100, 77)] })
    expect(out.counts.input).toBe(1)     // 下架文件不在主池 input 里
    expect(out.rows).toHaveLength(1)
    expect(out.conservation).toBe(true)
    expect(out.secondaryReview.checked).toBe(1)
  })
})

/**
 * 等位（`swap-hold`）**必须说得出占位者是谁——用路径，不是文件名**。
 *
 * 为什么是路径而不是 `reason` 里那个名字：前端要拿它去和**本轮其他动作**对上号
 * （「删掉这份 → 那份随即搬入」这句因果，界面上以前一个字没提，用户读不出来）。
 * 而同名文件可以躺在不同目录里，名字对名字必然错配；只有完整路径才是文件的唯一身份。
 */
describe('等位带出占位者路径（blockedBy）', () => {
  it('同名占位 → blockedBy 指着货架上那份同名文件的完整路径', () => {
    const EP = '750.探秘人体特殊实验.mp3'
    const input = { ...base(),
      sourceFiles: [f(`/src/${EP}`, 111, 1000)],
      libClaimedFiles: [f(`/lib/付费/${EP}`, 999, 2600)] }
    const hold = actions(input).find((a) => a.kind === 'pending' && a.pendingKind === 'swap-hold') as Extract<PlanAction, { kind: 'pending' }>
    expect(hold.src.path).toBe(`/src/${EP}`)
    expect(hold.blockedBy).toBe(`/lib/付费/${EP}`)
  })

  it('同集占位（名字不同名）→ blockedBy 指着货架上那份同集文件的完整路径', () => {
    const A780 = { leftKey: 'L780', title: '780.四十五谈身边灵异事', durationS: 8274, paid: true, needsSupply: true }
    const input = {
      ...base(), authority: [...base().authority, A780],
      sourceFiles: [f('/src/780.四十五谈身边灵异事【耗时整理】.mp3', 100, 8274)],
      libClaimedFiles: [f('/lib/付费/780.四十五谈身边灵异事.mp3', 200, 8279)],
    }
    const hold = actions(input).find((a) => a.kind === 'pending' && a.pendingKind === 'swap-hold') as Extract<PlanAction, { kind: 'pending' }>
    expect(hold.src.path).toBe('/src/780.四十五谈身边灵异事【耗时整理】.mp3')
    // 名字不同（装饰后缀）——所以只有路径能把它和本轮那条 delete-loser 对上号
    expect(hold.blockedBy).toBe('/lib/付费/780.四十五谈身边灵异事.mp3')
  })

  /** 换正主路上被**第三份**同名文件挡住的那一档（`settleCopy` 的 `promote`）——它也是等位，
   *  一样要说得出挡路的是谁，否则前端对它只能哑口。 */
  it('换正主撞上第三份同名 → blockedBy 指着那第三份', () => {
    const A = { leftKey: 'LX', title: '300.某一集', durationS: 1000, paid: true, needsSupply: true }
    const input = {
      ...base(), authority: [...base().authority, A],
      // 来源那份认领（时长严丝合缝）；库内子目录里有同集旧正主（差 30 秒，质量比不出 → 换正主）；
      // 目标目录 /lib/付费 里另有一份同名的第三方文件挡着。
      sourceFiles: [f('/src/300.某一集.mp3', 300, 1000)],
      libClaimedFiles: [
        f('/lib/付费/玄关笔记/300.某一集.mp3', 100, 1030),
        f('/lib/付费/300.某一集.mp3', 500, 4000),
      ],
    }
    const hold = actions(input).find((a) => a.kind === 'pending' && a.pendingKind === 'swap-hold') as Extract<PlanAction, { kind: 'pending' }>
    expect(hold?.blockedBy).toBe('/lib/付费/300.某一集.mp3')
  })
})

/**
 * 等位（`swap-hold`）**也要说得出腾的是哪一集**（`episode`）。
 *
 * 走到 `swap-hold` 的前提就是"这一集认领了这份文件"——`place()` 的签名里 `episode` 本来就在场
 * （最后那行 `move` 已经在用），只是两个降级分支没往外带。带上它之后卡片说得出「腾的是《…》
 * 这一集的位置」，而不是只能拿文件名当主角；缺席时前端退化成作品名，一屏几张卡顶着同一个标题。
 *
 * 反面**同样要钉住**：没有任何一集认领的那些（残差下架 `shelve` → `placeSecondary` → `place`）
 * 一个集名都没有，绝不许拿文件名冒充——那正是这条线反复守的那件事。
 */
describe('等位带出集名（episode）', () => {
  it('同名占位 → episode 是认领它的那一集', () => {
    const EP = '750.探秘人体特殊实验.mp3'
    const input = { ...base(),
      sourceFiles: [f(`/src/${EP}`, 111, 1000)],
      libClaimedFiles: [f(`/lib/付费/${EP}`, 999, 2600)] }
    const hold = actions(input).find((a) => a.kind === 'pending' && a.pendingKind === 'swap-hold') as Extract<PlanAction, { kind: 'pending' }>
    expect(hold.episode).toBe('750.探秘人体特殊实验')
  })

  it('同集占位（名字不同名）→ episode 是那一集，不是文件名', () => {
    const A780 = { leftKey: 'L780', title: '780.四十五谈身边灵异事', durationS: 8274, paid: true, needsSupply: true }
    const input = {
      ...base(), authority: [...base().authority, A780],
      sourceFiles: [f('/src/780.四十五谈身边灵异事【耗时整理】.mp3', 100, 8274)],
      libClaimedFiles: [f('/lib/付费/780.四十五谈身边灵异事.mp3', 200, 8279)],
    }
    const hold = actions(input).find((a) => a.kind === 'pending' && a.pendingKind === 'swap-hold') as Extract<PlanAction, { kind: 'pending' }>
    // 文件名带【耗时整理】装饰 —— 集名必须来自节目单那一侧
    expect(hold.episode).toBe('780.四十五谈身边灵异事')
  })

  it('换正主撞上第三份同名 → episode 是要换的那一集', () => {
    const A = { leftKey: 'LX', title: '300.某一集', durationS: 1000, paid: true, needsSupply: true }
    const input = {
      ...base(), authority: [...base().authority, A],
      sourceFiles: [f('/src/300.某一集.mp3', 300, 1000)],
      libClaimedFiles: [
        f('/lib/付费/玄关笔记/300.某一集.mp3', 100, 1030),
        f('/lib/付费/300.某一集.mp3', 500, 4000),
      ],
    }
    const hold = actions(input).find((a) => a.kind === 'pending' && a.pendingKind === 'swap-hold') as Extract<PlanAction, { kind: 'pending' }>
    expect(hold.episode).toBe('300.某一集')
  })

  it('没人认领的残差走下架撞上占位 → 没有集名可带，绝不拿文件名冒充', () => {
    // 两份时长都不沾任何一集 → 都判 offline 下架；同名 → 第二份被下架货架的同名占位拦成 swap-hold。
    const input = { ...base(),
      sourceFiles: [f('/src/A/092.穿衣服.mp3', 100, 777), f('/src/B/092.穿衣服.mp3', 200, 778)] }
    const hold = actions(input).find((a) => a.kind === 'pending' && a.pendingKind === 'swap-hold') as Extract<PlanAction, { kind: 'pending' }>
    expect(hold).toBeDefined()
    expect(hold.episode).toBeUndefined()
  })

  /**
   * 上一条的**有牙版本**：文件名**恰恰对得上清单里某一集**，人却已经答过「不是这一集」。
   *
   * 上一条拦不住"顺手补一个 `titleOfName(f)` 兜底"那版补丁——它那两份文件的名字压根不在清单里，
   * 兜底也返回 `undefined`，两版行为一模一样（突变实测活下来过）。这一条把两版拉开：兜底那版
   * 会把**人刚刚否掉的那个集名**重新贴回卡上，正是这条线一直在守的"绝不拿文件名冒充集名"。
   */
  it('名字对得上清单、但人答过「不是这一集」→ 照旧没有集名（不许拿被否掉的那个名字兜底）', () => {
    const A037 = { leftKey: 'L037', title: '37.申与酉', durationS: 2041, paid: true }
    const A756 = { leftKey: 'L756', title: '756.大家都焦虑的这么具体了吗？', durationS: 6043, paid: true }
    // 两份都叫 `37.申与酉.mp3`（名字自称 L037）、时长却都落在 L756 上 → 证据相争、出问句；
    // 人对两集都答「不是」→ 两份一起走下架，第二份被第一份的同名占位拦成 swap-hold。
    const input = {
      ...base(), authority: [A037, A756],
      sourceFiles: [f('/src/A/37.申与酉.mp3', 100, 6044), f('/src/B/37.申与酉.mp3', 200, 6044)],
      notEpisode: () => true,
    }
    const out = buildPlan(input)
    const hold = out.actions.find((a) => a.kind === 'pending' && a.pendingKind === 'swap-hold') as Extract<PlanAction, { kind: 'pending' }>
    expect(hold).toBeDefined()
    expect(hold.src.path).toBe('/src/B/37.申与酉.mp3') // 第一份先落位、这份被它的同名占位拦住
    expect(hold.episode).toBeUndefined()
  })
})

/**
 * **换槽位一轮做完**：占位那份本轮就要被删，等位那份不必再等下一轮。
 *
 * 过去两轮的成因在两头：计划器的占位表是动手前的磁盘快照（不含"这个位置本轮会腾出来"），
 * 执行器又把删排在搬后面（硬排会先搬、撞名 403）。两头各修一半，这一组钉计划器那一半。
 */
describe('换槽位（占位者本轮就删 → 等位当轮落位）', () => {
  /** 活体形状（2026-08-04 怡楽）：来源那份认领了某一集要搬进付费货架，而货架上同名的那份
   *  没人认领、它够得着的那几集源站自己全放得出 → 本轮删。位置当轮就空得出来。 */
  const freed = () => {
    const A900 = { leftKey: 'L900', title: '900.免费那一集', durationS: 2600, paid: true, needsSupply: false }
    return {
      ...base(), authority: [...base().authority, A900],
      sourceFiles: [f('/src/750.探秘人体特殊实验.mp3', 100, 1000)],
      libClaimedFiles: [f('/lib/付费/750.探秘人体特殊实验.mp3', 999, 2600)],
    }
  }

  it('提升成 move，并带上 evicts 说清前置条件是谁', () => {
    const out = actions(freed())
    expect(out.find((a) => a.kind === 'pending')).toBeUndefined()
    expect(out).toContainEqual(expect.objectContaining({
      kind: 'move', dstDir: '/lib/付费',
      evicts: '/lib/付费/750.探秘人体特殊实验.mp3',
      basis: 'freed-by:/lib/付费/750.探秘人体特殊实验.mp3',
    }))
  })

  /** 账本行跟着走：判定（claimed）没变，变的只是处置——两侧仍出自同一条判定。 */
  it('账本行的处置从 pending:swap-hold 变成 move，判定不动', () => {
    expect(rowFor(freed(), '/src/750.探秘人体特殊实验.mp3'))
      .toMatchObject({ verdict: 'claimed', basis: 'authority:L750', action: 'move:/lib/付费' })
  })

  /**
   * `delete-loser` 是确认档，定时轮（`losers:false`）会跳过它。把等它的搬运摆进
   * 「可以自动完成」就是说了句假话，所以这一档**不提升**——反正它本来就要人点头。
   */
  it('占位者是确认档的删（delete-loser）→ 不提升，照旧等下一轮', () => {
    const A780 = { leftKey: 'L780', title: '780.四十五谈身边灵异事', durationS: 8274, paid: true, needsSupply: true }
    const input = {
      ...base(), authority: [...base().authority, A780],
      sourceFiles: [f('/src/780.四十五谈身边灵异事【耗时整理】.mp3', 100, 8274)],
      libClaimedFiles: [f('/lib/付费/780.四十五谈身边灵异事.mp3', 200, 8279)],
    }
    const out = actions(input)
    expect(out.find((a) => a.kind === 'delete-loser')).toBeDefined()
    expect(out.find((a) => a.kind === 'pending' && a.pendingKind === 'swap-hold')).toBeDefined()
    expect(out.find((a) => a.kind === 'move' && a.evicts)).toBeUndefined()
  })

  /**
   * 同一个位置来了两份 → **先择优、只剩一个等位者**，提升的仍是一条。这一条钉的是
   * "提升不会绕过择优"：两份都进去就是一集两份，违反步 4。
   *
   * （`freeSlotPass` 里"挡着好几条时一条都不提升"那道闸门今天构造不出来：两个分支的
   * 占位判据——同名、同集——都蕴含"等位者与占位者同一个认集身份"，于是几个等位者之间
   * 必然同集，`settleCopy` 在这个 pass 之前就已经把它们收成一胜一负。留着它是因为
   * 择优那条路的判据一变，这里就可能同时来两条，而代价只是一次 `length` 比较。）
   */
  it('同一个位置来了两份 → 先择优，落位的只有胜出那份', () => {
    const A900 = { leftKey: 'L900', title: '900.免费那一集', durationS: 2600, paid: true, needsSupply: false }
    const input = {
      ...base(), authority: [...base().authority, A900],
      sourceFiles: [f('/src/A/750.探秘人体特殊实验.mp3', 100, 1000), f('/src/B/750.探秘人体特殊实验.mp3', 200, 1000)],
      libClaimedFiles: [f('/lib/付费/750.探秘人体特殊实验.mp3', 999, 2600)],
    }
    const out = actions(input)
    const promoted = out.filter((a) => a.kind === 'move' && a.evicts)
    expect(promoted).toHaveLength(1)
    expect(promoted[0].src.path).toBe('/src/B/750.探秘人体特殊实验.mp3') // 体量大的那份胜出
    expect(out).toContainEqual(expect.objectContaining({ kind: 'delete-loser', src: expect.objectContaining({ path: '/src/A/750.探秘人体特殊实验.mp3' }) }))
  })
})

describe('半截文件', () => {
  it('size < MIN_MEDIA_BYTES → hold/size-suspect，不进字节全等签名', () => {
    const out = buildPlan({
      ...base(),
      authority: [{ leftKey: 'L750', title: '750.探秘人体特殊实验', durationS: 1000, needsSupply: true }],
      libClaimedFiles: [{ path: '/lib/付费/750.探秘人体特殊实验.mp3', name: '750.探秘人体特殊实验.mp3', size: 0 }],
      sourceFiles: [{ path: '/src/750.探秘人体特殊实验.mp3', name: '750.探秘人体特殊实验.mp3', size: 0 }],
    })
    const rows = out.rows.filter((r) => r.basis === 'size-suspect')
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.verdict === 'hold')).toBe(true)
    expect(out.actions.some((a) => a.kind === 'delete-dup')).toBe(false) // 两份 0 字节不是"同一份"
    expect(out.conservation).toBe(true)
  })

  it('inProgress:true 同样 hold', () => {
    const out = buildPlan({
      ...base(),
      authority: [], libClaimedFiles: [],
      sourceFiles: [{ path: '/src/a.mp3', name: 'a.mp3', size: 5_000_000, inProgress: true }],
    })
    expect(out.rows[0]).toMatchObject({ verdict: 'hold', basis: 'size-suspect' })
    expect(out.actions[0]).toMatchObject({ kind: 'pending', pendingKind: 'no-duration' })
  })

  /**
   * 第二货架不进主池，所以那道闸够不到它自己的判定——但它的字节签名会参与"这份已经有了"。
   * 架上那份要是还在写，就绝不能当"留下的那一份"：`delete-dup` 是全流程唯一不经人眼的动作，
   * 拿一份半截文件去做掉来源里那份完整的，删完不可逆。
   * （`size < MIN_MEDIA_BYTES` 那一半在这条路上够不着：签名要同 size，来源那份也就一起被主池
   *  闸住了。所以这里只有 `inProgress` 这一种形状能走到。）
   */
  it('第二货架上那份还在写 → 不当"留下的那一份"，来源那份不被 delete-dup', () => {
    const EP = '750.探秘人体特殊实验.mp3'
    const SIZE = 100 * 1024 * 1024
    const input: PlanInput = {
      ...base(),
      sourceFiles: [{ path: `/src/${EP}`, name: EP, size: SIZE, durationS: 1000 }],
      libSecondaryFiles: [{ path: `/lib/下架/${EP}`, name: EP, size: SIZE, inProgress: true }],
    }
    const out = buildPlan(input)
    expect(out.actions.some((a) => a.kind === 'delete-dup')).toBe(false)
    expect(rowFor(input, `/src/${EP}`).basis).not.toMatch(/^size-dup-of:/)
    expect(out.conservation).toBe(true)
  })
})

/**
 * 货架自述表（spec 2026-09-03 §3.1）：规划器**只读 `traits`**，不认来源类型。这两条各钉一格，
 * 且都带负对照——同一份输入换掉那一格，结论必须跟着变，否则断言是在测别的东西。
 */
describe('shelf 自述表', () => {
  /** 动作按"它动的是哪份文件"取（各变体都带 `src`）。 */
  const actionOn = (out: ReturnType<typeof buildPlan>, path: string) =>
    out.actions.find((a) => (a as { src?: RFile }).src?.path === path)

  it('hasTrash:false → 字节全等副本也降为确认档（delete-loser），定时轮不会删', () => {
    const mk = (hasTrash: boolean) => buildPlan({
      ...base(),
      shelf: { caseSensitive: true, hasTrash, listingIsLive: true, reportsInProgress: false },
      authority: [{ leftKey: 'L750', title: '750.x', durationS: 1000, needsSupply: false }],
      libClaimedFiles: [f('/lib/付费/750.x.mp3', 5)],
      sourceFiles: [f('/src/750.x.mp3', 5)],
    })
    const del = actionOn(mk(false), '/src/750.x.mp3')
    expect(del).toMatchObject({ kind: 'delete-loser', keptPath: '/lib/付费/750.x.mp3' })
    expect((del as { basis: string }).basis).toContain('no-trash')
    // 负对照：有回收站的货架上，字节全等仍是那条不经人眼的 `delete-dup`（原行为）。
    expect(actionOn(mk(true), '/src/750.x.mp3')).toMatchObject({ kind: 'delete-dup' })
  })

  /**
   * `delete-redundant`（源站自己放得出的那一集）平时不进确认档，底气是回收站兜底。没有回收站的
   * 货架上规划器必须给它盖 `noTrash`——执行面就靠这一位把它并进 `losers` 那道闸。少了这一位，
   * 定时轮会在一个删不掉的货架上不经人眼直接删，而两边单看都正常。
   */
  it('hasTrash:false → delete-redundant 盖 noTrash（执行面据此并进确认档）', () => {
    const mk = (hasTrash: boolean) => buildPlan({
      ...base(),
      shelf: { caseSensitive: true, hasTrash, listingIsLive: true, reportsInProgress: false },
      authority: [{ leftKey: 'L750', title: '750.x', durationS: 1000, needsSupply: false }],
      sourceFiles: [f('/src/750.x.mp3', 5, 1000)],
    })
    const noTrash = actionOn(mk(false), '/src/750.x.mp3')
    expect(noTrash).toMatchObject({ kind: 'delete-redundant', noTrash: true })
    // 负对照：有回收站时这一位必须**缺席**（不是 false——它是"额外的约束"，不是三态）。
    const withTrash = actionOn(mk(true), '/src/750.x.mp3')
    expect(withTrash).toMatchObject({ kind: 'delete-redundant' })
    expect(withTrash && 'noTrash' in withTrash).toBe(false)
  })

  it('caseSensitive:false → 目标目录已有 A.mp3 时搬 a.mp3 判 swap-hold', () => {
    // 名字只差大小写时，默认 identity 自己就 toLowerCase，两份会折成同一集——同集占位那道闸
    // 先响，断言绿了也证不出 fold 生效。这里注入一份**区分大小写**的 identity 让开同集闸，
    // 只留名字这一道，量到的才是 `caseSensitive` 本身。
    const mk = (caseSensitive: boolean) => buildPlan({
      ...base(),
      identity: (name: string) => ({ key: name, num: null }),
      shelf: { caseSensitive, hasTrash: true, listingIsLive: true, reportsInProgress: false },
      sourceFiles: [f('/src/092.穿衣服.mp3', 5, 777)],
      libSecondaryFiles: [f('/lib/下架/092.穿衣服.MP3', 5, 888)],
    })
    expect(actionOn(mk(false), '/src/092.穿衣服.mp3')).toMatchObject({ kind: 'pending', pendingKind: 'swap-hold' })
    // 负对照：区分大小写的货架上这两个名字不算撞名，照常搬。
    expect(actionOn(mk(true), '/src/092.穿衣服.mp3')).toMatchObject({ kind: 'move', dstDir: '/lib/下架' })
  })
})

describe('多季影视归档（spec 2026-09-03-tv-season-archive）', () => {
  // 影视这一支的 identity 只当分组键用（豁免 / 同目录字节全等），认哪一集全由匹配器答——
  // 所以 titleStrip 空、集号只认「第N期」，与季集号无关。
  const tvIdentity = makeIdentity({ titleStrip: [], epNumRegex: '第(\\d+)期' })
  const ROOT = '/quark/From Stream/tv-261471'
  function tv(): PlanInput {
    return {
      identity: tvIdentity, matchSpec: DEFAULT_MATCH_SPEC, seasonFolders: true,
      authority: [
        { leftKey: 'tmdb:261471:S02E07', title: '第 7 集' },
        { leftKey: 'tmdb:261471:S03E07', title: '第 7 集' },
        { leftKey: 'tmdb:261471:S03E14', title: '第 14 集' },
      ],
      sourceFiles: [], libClaimedFiles: [], subShows: [], dirs: { claimed: ROOT },
      verdictFor: () => null, shelf: OPENLIST_TRAITS,
    }
  }

  it('认领落点 = <root>/S<nn>，名字没带编号 → move 顺手加前缀', () => {
    const input = {
      ...tv(), libClaimedFiles: [f(`${ROOT}/第三季（4K）/第14期.mkv`)],
      pinnedFor: (k: string) => (k === 'tmdb:261471:S03E14' ? `${ROOT}/第三季（4K）/第14期.mkv` : undefined),
    }
    expect(actions(input)).toEqual([
      expect.objectContaining({
        kind: 'move', dstDir: `${ROOT}/S03`, newName: 'S03E14 - 第14期.mkv', basis: 'authority:tmdb:261471:S03E14',
      }),
    ])
  })

  it('已在季目录、名字没前缀 → rename；名字已带正确前缀 → 无动作', () => {
    const a = {
      ...tv(), libClaimedFiles: [f(`${ROOT}/S03/第14期.mkv`)],
      pinnedFor: (k: string) => (k === 'tmdb:261471:S03E14' ? `${ROOT}/S03/第14期.mkv` : undefined),
    }
    expect(actions(a)).toEqual([expect.objectContaining({ kind: 'rename', newName: 'S03E14 - 第14期.mkv' })])
    const b = {
      ...tv(), libClaimedFiles: [f(`${ROOT}/S03/S03E14 - 第14期.mkv`)],
      pinnedFor: (k: string) => (k === 'tmdb:261471:S03E14' ? `${ROOT}/S03/S03E14 - 第14期.mkv` : undefined),
    }
    expect(actions(b)).toEqual([])
    expect(rowFor(b, `${ROOT}/S03/S03E14 - 第14期.mkv`)).toMatchObject({ verdict: 'claimed', action: 'none' })
  })

  /** 把一份文件直接判给某一集的裁决器——**不经 `pinnedFor`**：那是人裁，与"引擎判的"是两回事
   *  （人裁那一档不出冲突卡，见下面那条）。 */
  const engineAssigns = (leftKey: string, path: string): NonNullable<PlanInput['match']> => (left, right) =>
    resultFrom(
      {
        assignments: new Map([[leftKey, { path, confidence: 1, status: 'auto' as const, losers: [], rule: 'injected' }]]),
        asks: [], residual: [], trails: new Map(), missingByLeft: new Map(),
      },
      left,
      right,
    )

  it('名字写着 S03E14、引擎判 S03E07 → evidence-conflict，不搬不改名', () => {
    const P = `${ROOT}/x/S03E14 - 第7期.mkv`
    const input = { ...tv(), libClaimedFiles: [f(P)], match: engineAssigns('tmdb:261471:S03E07', P) }
    expect(actions(input)).toEqual([
      expect.objectContaining({
        kind: 'pending', pendingKind: 'evidence-conflict',
        conflictsWith: ['tmdb:261471:S03E07', 'tmdb:261471:S03E14'],
      }),
    ])
  })

  /**
   * 活体（喜剧之王单口季 map_a3d90e，2026-09-03 a004422b）：引擎把「第4期二」判成 S03E04（清单那一集是
   * 「第1期（四）」），归档器照刻 `S03E04 - ` 前缀——错号一旦写进名字就成了下一轮最强的证据，13 条。
   * 文件名里的期号是分享者写的、清单里的期号是 TMDb 写的，两个都在场却不相等，机器不该替它们二选一。
   */
  it('文件名的「第N期」与清单这一集的「第M期」对不上 → evidence-conflict，绝不刻前缀', () => {
    const P = `${ROOT}/王中王/2026-07-24 第4期二.mkv`
    const input = {
      ...tv(), authority: [{ leftKey: 'tmdb:261471:S03E04', title: '第1期（四）： 李雪琴王建国首搭漫才' }],
      libClaimedFiles: [f(P)], match: engineAssigns('tmdb:261471:S03E04', P),
    }
    expect(actions(input)).toEqual([
      expect.objectContaining({ kind: 'pending', pendingKind: 'evidence-conflict', conflictsWith: ['tmdb:261471:S03E04'] }),
    ])
    expect(rowFor(input, P)).toMatchObject({ basis: 'qi-conflict:tmdb:261471:S03E04' })
  })

  it('文件名与清单的期号一致 → 照常认领加前缀（闸只拦"两边都说了、说得不一样"）', () => {
    const P = `${ROOT}/王中王/2026-07-24 第4期二.mkv`
    const input = {
      ...tv(), authority: [{ leftKey: 'tmdb:261471:S03E15', title: '第4期（二）： 嘻哈霸气回应剧本' }],
      libClaimedFiles: [f(P)], match: engineAssigns('tmdb:261471:S03E15', P),
    }
    expect(actions(input)).toEqual([expect.objectContaining({ kind: 'move', newName: 'S03E15 - 2026-07-24 第4期二.mkv' })])
  })

  it('纯享文件被引擎认成一集、而清单那一集不是纯享 → evidence-conflict，不刻前缀', () => {
    const P = `${ROOT}/x/20250830第8期纯享 刘仁铖模仿付航心算热量.mp4`
    const input = {
      ...tv(), authority: [{ leftKey: 'tmdb:261471:S02E29', title: '第8期（一）：爽文！嘻哈有其父必有其女' }],
      libClaimedFiles: [f(P)], match: engineAssigns('tmdb:261471:S02E29', P),
    }
    expect(actions(input)).toEqual([expect.objectContaining({ kind: 'pending', pendingKind: 'evidence-conflict' })])
  })

  /**
   * 同一个局面、只换了归属的来路：**人已经钉死了这份文件属于哪一集**。这时冲突卡没有出口——
   * 它问的正是人刚刚答过的那个问题，摆出来只会让同一份文件每轮都回来一次。按人裁办：
   * 搬进那一集的季目录，**名字一个字不动**（它已经自带编号，再补前缀就是叠成 `SxxExx - SxxExx - `）。
   */
  it('人钉死的那份：名字自带别的集号也不出卡，按人裁搬进季目录且不叠前缀', () => {
    const P = `${ROOT}/新分享/S03E14 - 第7期.mkv`
    const input = {
      ...tv(),
      authority: [...tv().authority, { leftKey: 'tmdb:261471:S03E15', title: '第 15 集' }],
      libClaimedFiles: [f(P)],
      pinnedFor: (k: string) => (k === 'tmdb:261471:S03E15' ? P : undefined),
    }
    const acts = actions(input)
    expect(acts.filter((a) => a.kind === 'pending')).toHaveLength(0)
    expect(acts).toEqual([expect.objectContaining({ kind: 'move', dstDir: `${ROOT}/S03` })])
    expect(acts[0]).not.toHaveProperty('newName')
  })

  it('跨季同名「第7期」：两份各归各季，不判同集、不出 delete-loser', () => {
    const input = {
      ...tv(),
      libClaimedFiles: [f(`${ROOT}/S02.2025/第7期.mkv`, 100, 3000), f(`${ROOT}/第三季/第7期.mkv`, 120, 3100)],
      pinnedFor: (k: string) =>
        k === 'tmdb:261471:S02E07' ? `${ROOT}/S02.2025/第7期.mkv`
          : k === 'tmdb:261471:S03E07' ? `${ROOT}/第三季/第7期.mkv` : undefined,
    }
    const acts = actions(input)
    expect(acts.map((a) => a.kind)).toEqual(['move', 'move'])
    expect(acts.map((a) => (a as { dstDir: string }).dstDir).sort()).toEqual([`${ROOT}/S02`, `${ROOT}/S03`])
  })

  it('没配上的文件：原地不动；同目录字节全等才 delete-dup，跨目录同名同体量不算', () => {
    const input = {
      ...tv(),
      libClaimedFiles: [
        f(`${ROOT}/a/花絮.mkv`, 50, 600), f(`${ROOT}/a/花絮.mp4`, 50, 600), f(`${ROOT}/b/花絮.mkv`, 50, 600),
      ],
    }
    const acts = actions(input)
    expect(acts.filter((a) => a.kind === 'delete-dup')).toHaveLength(1)
    expect(acts.filter((a) => a.kind === 'delete-loser' || a.kind === 'replace' || a.kind === 'move')).toHaveLength(0)
  })

  it('同集两份（引擎认了正主 + loser）：落选副本 delete-loser 的 keptPath 是同一 leftKey 的正主', () => {
    // DEFAULT_MATCH_SPEC 的 season-episode 阶段按名字里的 SxxExx 认；第二份是 losers
    const input = {
      ...tv(),
      libClaimedFiles: [f(`${ROOT}/S03/S03E14 - 第14期.mkv`, 200, 3000), f(`${ROOT}/新分享/S03E14.第14期.mkv`, 100, 3000)],
    }
    const acts = actions(input)
    expect(acts).toEqual([expect.objectContaining({ kind: 'delete-loser', keptPath: `${ROOT}/S03/S03E14 - 第14期.mkv` })])
  })

  it('loser 的文件名自带 SxxExx、与它被判给的那一集打架 → evidence-conflict，不许 delete-loser', () => {
    // 正主 S03E07 按时长 + 名字（"特别篇"）被 R12 sweep 认下这份 loser；但这份文件自己的名字
    // 写着 S03E14——与它被判给的 S03E07 打架。旧代码在这里直接进 settleCopy 的质量比较
    // （100MiB < 200MiB → worse → delete-loser），把分享者写在文件名里的证据静默删掉。
    const input = {
      ...tv(),
      authority: [{ leftKey: 'tmdb:261471:S03E07', title: '特别篇', durationS: 3000 }],
      libClaimedFiles: [
        f(`${ROOT}/S03/S03E07 - 特别篇.mkv`, 200, 3000),
        f(`${ROOT}/新分享/S03E14 - 特别篇.mkv`, 100, 3000),
      ],
      pinnedFor: (k: string) => (k === 'tmdb:261471:S03E07' ? `${ROOT}/S03/S03E07 - 特别篇.mkv` : undefined),
    }
    const acts = actions(input)
    expect(acts).toEqual([
      expect.objectContaining({
        kind: 'pending', pendingKind: 'evidence-conflict', episode: '特别篇',
        conflictsWith: ['tmdb:261471:S03E07', 'tmdb:261471:S03E14'],
      }),
    ])
    expect(acts.filter((a) => a.kind === 'delete-loser')).toHaveLength(0)
    expect(rowFor(input, `${ROOT}/新分享/S03E14 - 特别篇.mkv`)).toMatchObject({ verdict: 'copy' })
  })

  it('账本行的 replace 带上落地名（顺手加了前缀时）', () => {
    // 换正主时新版没带季集号前缀 → replace 顺手加前缀。账本行只写 oldPath 说不出新那份落到了
    // 哪里，复盘时查无此路径（同 move 那一句道理）。
    const input = {
      ...tv(),
      authority: [{ leftKey: 'tmdb:261471:S03E07', title: '特别篇', durationS: 3000 }],
      libClaimedFiles: [
        f(`${ROOT}/S03/旧版特别篇.mkv`, 100, 3000),
        f(`${ROOT}/新分享/新版特别篇.mkv`, 300, 3000),
      ],
      pinnedFor: (k: string) => (k === 'tmdb:261471:S03E07' ? `${ROOT}/S03/旧版特别篇.mkv` : undefined),
    }
    const replaceAction = actions(input).find((a) => a.kind === 'replace')
    expect(replaceAction).toMatchObject({ newName: 'S03E07 - 新版特别篇.mkv' })
    expect(rowFor(input, `${ROOT}/新分享/新版特别篇.mkv`)).toMatchObject({
      action: `replace:${ROOT}/S03/旧版特别篇.mkv→${ROOT}/S03/S03E07 - 新版特别篇.mkv`,
    })
  })

  it('原地改名撞上目标名已被占 → swap-hold，不许改名', () => {
    // 认领到的那份没带前缀，改名目标 "S03E07 - 裸名.mkv" 恰好已经有一份同名文件躺在同一目录——
    // 硬改就是同轮撞名。占位者本身没被任何一集认下（没有时长，进 no-duration 待探），与本条无关。
    const input = {
      ...tv(),
      authority: [{ leftKey: 'tmdb:261471:S03E07', title: '特别篇' }],
      libClaimedFiles: [
        f(`${ROOT}/S03/裸名.mkv`, 100, 3000),
        f(`${ROOT}/S03/S03E07 - 裸名.mkv`, 50),
      ],
      pinnedFor: (k: string) => (k === 'tmdb:261471:S03E07' ? `${ROOT}/S03/裸名.mkv` : undefined),
    }
    const acts = actions(input)
    expect(acts.filter((a) => a.kind === 'rename')).toHaveLength(0)
    expect(acts).toContainEqual(expect.objectContaining({
      kind: 'pending', pendingKind: 'swap-hold', blockedBy: `${ROOT}/S03/S03E07 - 裸名.mkv`,
    }))
  })

  /** 同集正主 + 落选副本都由调用方钉死（引擎判的，不经 `pinnedFor`）——`settleCopy` 那条路的入口。 */
  const engineAssignsWithLosers = (leftKey: string, path: string, losers: string[]): NonNullable<PlanInput['match']> =>
    (left, right) =>
      resultFrom(
        {
          assignments: new Map([[leftKey, { path, confidence: 1, status: 'auto' as const, losers, rule: 'injected' }]]),
          asks: [], residual: [], trails: new Map(), missingByLeft: new Map(),
        },
        left,
        right,
      )

  const S02E01 = 'tmdb:261471:S02E01'
  const MASTER = `${ROOT}/S02/S02E01 - 第1期上.mkv`
  /** 另一版剪辑，名字里**没有**「纯享」——纯享有自己那条路（见本 describe 末尾几条）。 */
  const CUT = `${ROOT}/x/第1期加长版.mkv`

  /**
   * 活体（2026-09-03 脱口秀 map_c038e1）：归档器给正主加上 `S02E01 - ` 前缀之后，另一版剪辑
   * 被引擎判成同一集的落选副本。两份时长差着 1500 秒 → `incomparable`，
   * 而季目录里正主的名字必然自带前缀 → `name-authority` 恒站在正主那边，于是**只按名字**
   * 下了一条删除令（一轮预览 10 条）。追更循环是 `losers:true` 无人值守跑的，当晚就会真删。
   */
  it('季模式 + 同集副本质量比不出 → 对照卡，不删也不换', () => {
    const input = {
      ...tv(),
      authority: [...tv().authority, { leftKey: S02E01, title: '第 1 集' }],
      libClaimedFiles: [f(MASTER, 200, 4000), f(CUT, 100, 2500)],
      match: engineAssignsWithLosers(S02E01, MASTER, [CUT]),
    }
    const acts = actions(input)
    const cards = acts.filter((a) => a.kind === 'pending' && a.pendingKind === 'replace')
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ src: expect.objectContaining({ path: CUT }), episode: '第 1 集' })
    expect((cards[0] as Extract<PlanAction, { kind: 'pending' }>).compare!.candidates).toHaveLength(2)
    expect(acts.filter((a) => a.kind === 'delete-loser' || a.kind === 'replace')).toHaveLength(0)
    expect(rowFor(input, CUT)).toMatchObject({ verdict: 'copy', basis: `incomparable-copy:${MASTER}` })
  })

  it('季模式 + 同集副本时长体量都一样（平手）→ 照旧 delete-loser', () => {
    const input = {
      ...tv(),
      authority: [...tv().authority, { leftKey: S02E01, title: '第 1 集' }],
      libClaimedFiles: [f(MASTER, 200, 4000), f(CUT, 200, 4000)],
      match: engineAssignsWithLosers(S02E01, MASTER, [CUT]),
    }
    const acts = actions(input)
    expect(acts).toContainEqual(expect.objectContaining({
      kind: 'delete-loser', src: expect.objectContaining({ path: CUT }), keptPath: MASTER,
    }))
    expect(acts.some((a) => a.kind === 'pending' && a.pendingKind === 'replace')).toBe(false)
  })

  /**
   * 「纯享」剪辑是**另一条播放线，不是那一集**（用户拍板 2026-09-03）。季模式下它们各自进
   * `<root>/纯享/S<nn>/`，不加编号前缀（前缀是"这是第几集"的断言，而它恰恰不是任何一集）。
   *
   * 唯一的例外是**引擎把它认成了某一集的正主**——有的节目就把纯享版当正片列进节目单，
   * 那时它就是那一集，照常走 `S<nn>/` 那条路。
   */
  const PURE = `${ROOT}/x/第1期纯享版.mkv`

  /**
   * 活体（脱口秀 map_c038e1，2026-09-03）：六份纯享早先被引擎认成正片、刻了 `S03E11 - ` 前缀；后来裁了
   * 「不是」→ 走纯享货架。前缀不摘，名字就永远自证它是 E11，下一轮 SxxExx 那一档又把它读回去。
   */
  it('清单那一集是正片、文件是同期同段的纯享、名字还刻着它的前缀 → 引擎不认领，归档器直接搬去纯享货架并摘前缀，不出卡', () => {
    const P = `${ROOT}/S03/S03E11 - 2026.07.25-第5期下纯享.mp4`
    const input = {
      ...tv(), authority: [{ leftKey: 'tmdb:261471:S03E11', title: '第5期下：周深丹妮合唱天籁' }],
      libClaimedFiles: [f(P, 100, 3212)], seasonOfDir: new Map<string, number | null>([[`${ROOT}/S03`, 3]]),
    }
    const acts = actions(input)
    expect(acts).toEqual([expect.objectContaining({ kind: 'move', dstDir: `${ROOT}/纯享/S03`, newName: '2026.07.25-第5期下纯享.mp4' })])
  })

  it('纯享残差名字上挂着归档器刻的 SxxExx 前缀 → 进货架时摘掉（move 带 newName）', () => {
    const P = `${ROOT}/S03/S03E11 - 2026.07.25-第5期下纯享.mp4`
    const input = { ...tv(), libClaimedFiles: [f(P, 100, 3212)], seasonOfDir: new Map<string, number | null>([[`${ROOT}/S03`, 3]]) }
    const acts = actions(input)
    expect(acts).toEqual([expect.objectContaining({ kind: 'move', dstDir: `${ROOT}/纯享/S03`, newName: '2026.07.25-第5期下纯享.mp4', basis: 'pure-cut:S03' })])
  })

  it('纯享残差 → 搬进 <root>/纯享/S<nn>，不加前缀，账本记 offline', () => {
    const P = `${ROOT}/S02.2025/2025-06-27 第1期纯享版.mkv`
    const input = {
      ...tv(),
      sourceFiles: [f(P, 100, 2500)],
      seasonOfDir: new Map<string, number | null>([[`${ROOT}/S02.2025`, 2]]),
    }
    const acts = actions(input)
    expect(acts).toEqual([expect.objectContaining({
      kind: 'move', dstDir: `${ROOT}/纯享/S02`, basis: 'pure-cut:S02',
    })])
    expect(acts[0]).not.toHaveProperty('newName')
    expect(rowFor(input, P)).toMatchObject({ verdict: 'offline', basis: 'pure-cut:S02' })
  })

  /**
   * 活体（喜剧之王单口季，2026-09-03）：纯享货架上已经躺着「20250713.第1期纯享上集 .mp4」，分享目录里同名同体积
   * 的另一份每轮都被判成 swap-hold「等它腾空」——而货架那份永远不会腾空，这张卡就永远在。同名同字节 = 同一份，
   * 该走字节全等那一档删掉，不该等位。
   */
  it('纯享残差与货架上同名同体积的那份 = 字节重复 → delete-dup，不再 swap-hold', () => {
    const SHELF = `${ROOT}/纯享/S02/20250713.第1期纯享上集 .mp4`
    const P = `${ROOT}/S02.2025/20250713.第1期纯享上集 .mp4`
    const input = {
      ...tv(),
      libClaimedFiles: [f(SHELF, 1699007795, 5458)],
      sourceFiles: [f(P, 1699007795, 5458)],
      seasonOfDir: new Map<string, number | null>([[`${ROOT}/S02.2025`, 2], [`${ROOT}/纯享/S02`, 2]]),
    }
    const acts = actions(input)
    expect(acts).toEqual([expect.objectContaining({ kind: 'delete-dup', src: expect.objectContaining({ path: P }), dupOf: SHELF })])
    expect(acts.some((a) => a.kind === 'pending')).toBe(false)
  })

  it('引擎判成同集落选副本的纯享 → 照样进纯享货架（季号取 leftKey），不 delete-loser、不出对照卡', () => {
    const input = {
      ...tv(),
      authority: [...tv().authority, { leftKey: S02E01, title: '第 1 集' }],
      libClaimedFiles: [f(MASTER, 200, 4000), f(PURE, 100, 2500)],
      match: engineAssignsWithLosers(S02E01, MASTER, [PURE]),
    }
    const acts = actions(input)
    expect(acts).toContainEqual(expect.objectContaining({
      kind: 'move', src: expect.objectContaining({ path: PURE }), dstDir: `${ROOT}/纯享/S02`, basis: 'pure-cut:S02',
    }))
    expect(acts.filter((a) => a.kind === 'delete-loser')).toHaveLength(0)
    expect(acts.filter((a) => a.kind === 'pending')).toHaveLength(0)
    expect(rowFor(input, PURE)).toMatchObject({ verdict: 'offline', basis: 'pure-cut:S02' })
  })

  it('名字带纯享、但引擎认它当某一集的正主 → 走正常 S<nn> 路，不进纯享货架', () => {
    const P = `${ROOT}/x/第7期纯享版.mkv`
    const input = {
      ...tv(),
      libClaimedFiles: [f(P, 100, 3000)],
      match: engineAssigns('tmdb:261471:S02E07', P),
      seasonOfDir: new Map<string, number | null>([[`${ROOT}/x`, 2]]),
    }
    expect(actions(input)).toEqual([expect.objectContaining({
      kind: 'move', dstDir: `${ROOT}/S02`, newName: 'S02E07 - 第7期纯享版.mkv',
    })])
  })

  it('已经躺在 纯享/S<nn> 里 → 无动作', () => {
    const P = `${ROOT}/纯享/S02/第1期纯享版.mkv`
    const input = {
      ...tv(),
      libClaimedFiles: [f(P, 100, 2500)],
      seasonOfDir: new Map<string, number | null>([[`${ROOT}/纯享/S02`, 2]]),
    }
    expect(actions(input)).toEqual([])
    expect(rowFor(input, P)).toMatchObject({ verdict: 'offline', basis: 'pure-cut:S02', action: 'none' })
  })

  it('文件夹判不出季、又不是谁的落选副本 → 照旧 season-unresolved，不猜一个季号搬走', () => {
    const DIR = `${ROOT}/来路不明`
    const P = `${DIR}/第1期纯享版.mkv`
    const input = {
      ...tv(),
      sourceFiles: [f(P, 100, 2500)],
      unresolvedSeasonDirs: new Set([DIR]),
      seasonOfDir: new Map<string, number | null>([[DIR, null]]),
    }
    expect(actions(input)).toEqual([expect.objectContaining({ kind: 'pending', pendingKind: 'season-unresolved' })])
    expect(rowFor(input, P)).toMatchObject({ basis: `season-unresolved:${DIR}` })
  })
})

/** 播客档（非季模式）不吃上面那条例外：名字那一档在那里是真判据（集号写在文件名里），
 *  比不出时照旧按它裁。断掉这条就说明例外漏进了播客路径。 */
describe('播客档比不出高下 → 仍走 name-authority，不出对照卡', () => {
  const D = 5808
  const LOOSE = '/lib/付费/身边那些灵异事（无编号转存）.mp3' // 沾边，但集身份不是这一集
  const RIGHT = '/lib/付费/005.身边那些灵异事.mp3'          // 集身份 = 这一集

  it('两份时长差出容差（incomparable）→ delete-loser，basis 是 name-authority', () => {
    const injected: NonNullable<PlanInput['match']> = (left, right) =>
      resultFrom(
        {
          assignments: new Map([['L005', { path: RIGHT, confidence: 1, status: 'auto' as const, losers: [LOOSE], rule: 'injected' }]]),
          asks: [], residual: [], trails: new Map(), missingByLeft: new Map(),
        },
        left,
        right,
      )
    const input = {
      ...base(),
      authority: [{ leftKey: 'L005', title: '005.身边那些灵异事' }], // 无 durationS → 第 1 档裁不出
      libClaimedFiles: [f(RIGHT, 89, D), f(LOOSE, 89, D + 500)],
      match: injected,
    }
    const acts = actions(input)
    expect(acts).toContainEqual(expect.objectContaining({
      kind: 'delete-loser', src: expect.objectContaining({ path: LOOSE }), basis: `name-authority:${LOOSE}`,
    }))
    expect(acts.some((a) => a.kind === 'pending' && a.pendingKind === 'replace')).toBe(false)
  })
})

/**
 * `match` 注入口（Task 8）：多季绑定的匹配必须走**季分区**那条路，而分区需要一个异步的季归属，
 * 规划器是同步的。所以裁决器由调用方注入，缺席才落回 `matchByEvidenceResult(input.matchSpec, …)`。
 * 这条守的是"注入真的被用上了"——断掉它不会有别的用例变红（默认那条路照常绿）。
 */
describe('match 注入：规划器用调用方给的裁决器，而不是自己按 matchSpec 再判一次', () => {
  const ORPHAN = '/src/与清单完全不沾边的名字.mp3'

  it('注入的裁决器认领了一份文件 → 规划器照它办；不注入时同一份文件不会被认领', () => {
    const injected: NonNullable<PlanInput['match']> = (left, right) =>
      resultFrom(
        {
          assignments: new Map([['L091', { path: right[0].name, confidence: 1, status: 'auto' as const, losers: [], rule: 'injected' }]]),
          asks: [], residual: [], trails: new Map(), missingByLeft: new Map(),
        },
        left,
        right,
      )
    const input = { ...base(), sourceFiles: [f(ORPHAN)], match: injected }
    expect(actions(input)).toContainEqual(expect.objectContaining({ kind: 'move', dstDir: '/lib/付费', basis: 'authority:L091' }))
    expect(rowFor(input, ORPHAN)).toMatchObject({ verdict: 'claimed' })

    // 负对照：同一份输入不注入 → 走 matchSpec 那条路，这份文件谁都认不出来。
    const plain = { ...base(), sourceFiles: [f(ORPHAN)] }
    expect(rowFor(plain, ORPHAN).verdict).not.toBe('claimed')
  })
})

/**
 * 判不出季的文件夹**整段不参与匹配**（`matchBySeasonResolved` 里 `season == null` 那一 continue）。
 * 它们不是"清单里没有它"，是**没被判过**——账本上必须有自己那一行（`season-unresolved:<dir>`），
 * 不能掉进 `unhandled:` 那条"某个终态漏接了"的兜底，也不能被搬去第二货架、更不能算进
 * suspect-dir 熔断的分子/分母（那道闸问的是"这个目录里的文件认不认得出是本节目的"，
 * 没判过的文件对这个问题一个字都答不上）。
 */
describe('判不出季的文件夹：自己一行账（Task 8 review）', () => {
  const UNRESOLVED = '/src/未定季'
  const six = () => Array.from({ length: 6 }, (_, i) => f(`${UNRESOLVED}/第${i + 1}期.mp3`, 100, 700 + i))

  it('文件原地不动、basis 是 season-unresolved:<dir>，不落 unhandled:', () => {
    const input: PlanInput = {
      ...base(),
      sourceFiles: six(),
      sourceDirs: ['/src'],
      unresolvedSeasonDirs: new Set([UNRESOLVED]),
    }
    const out = buildPlan(input)
    const rows = out.rows.filter((r) => r.path.startsWith(`${UNRESOLVED}/`))
    expect(rows).toHaveLength(6)
    for (const r of rows) {
      expect(r.basis).toBe(`season-unresolved:${UNRESOLVED}`)
      // `hold` 而不是 `offline`：这是一个**状态**（判不出来，等人给文件夹起个带季号的名字），
      // 不是"清单里没有它"那个结论。
      expect(r.verdict).toBe('hold')
    }
    expect(out.rows.some((r) => r.basis.startsWith('unhandled:'))).toBe(false)
    // 不搬不删不改名——但**必须看得见**：`action: null` 的行进不了任何一条 plan / 计数，
    // 用户面前它就是凭空消失的一批文件。所以每一份出一条 `pending`。
    expect(out.actions).toHaveLength(6)
    for (const a of out.actions) expect(a).toMatchObject({ kind: 'pending', pendingKind: 'season-unresolved' })
    expect(out.actions.filter((a) => a.kind === 'pending' && a.pendingKind === 'suspect-dir')).toEqual([])

    // 负对照：同一批文件不申报"判不出季" → 走原来那条路，会被当成"清单里没有它"搬去下架货架，
    // 并把 suspect-dir 熔断顶起来。正是这条要消掉。
    const plain = buildPlan({ ...base(), sourceFiles: six(), sourceDirs: ['/src'] })
    expect(plain.actions.some((a) => a.kind === 'pending' && a.pendingKind === 'suspect-dir')).toBe(true)
  })

  it('没判过的文件也不进 suspect-dir 的分母：同目录里 5 份真认不出的照样熔断', () => {
    // 分子 = 5 份真被判成"不是本节目"的（≥ SUSPECT_MIN），分母若把 6 份没判过的算进去
    // 就是 5/11 = 0.45 < 0.5 —— 熔断哑火，而那 6 份根本没回答过这个问题。
    const input: PlanInput = {
      ...base(),
      sourceFiles: [
        ...Array.from({ length: 5 }, (_, i) => f(`/src/杂目录/无关${i + 1}.mp3`, 100, 5000 + i)),
        ...six(),
      ],
      sourceDirs: ['/src'],
      unresolvedSeasonDirs: new Set([UNRESOLVED]),
    }
    const out = buildPlan(input)
    expect(out.actions.some((a) => a.kind === 'pending' && a.pendingKind === 'suspect-dir')).toBe(true)
  })

  /**
   * 字节全等那一档（`delete-dup`）是全流程**唯一不经人眼**的动作。它必须排在"这个文件夹判不出季"
   * 之后：判不出季的文件夹里两份同名同体量的文件，很可能就是两季各自那一份（跨季同期号是常态），
   * 而这里连它们属不属于同一季都还没答上来，凭什么说它们是同一份。
   */
  it('判不出季的文件夹里，字节全等也不许 delete-dup', () => {
    const A = `${UNRESOLVED}/第7期.mkv`
    const B = `${UNRESOLVED}/第7期.mp4`
    const out = buildPlan({
      ...base(),
      seasonFolders: true,
      sourceFiles: [f(A, 100, 3000), f(B, 100, 3000)],
      sourceDirs: ['/src'],
      unresolvedSeasonDirs: new Set([UNRESOLVED]),
    })
    expect(out.actions.filter((a) => a.kind === 'delete-dup' || a.kind === 'delete-loser')).toEqual([])
    for (const p of [A, B]) {
      expect(out.rows.find((r) => r.path === p)!.basis).toBe(`season-unresolved:${UNRESOLVED}`)
    }
  })
})
