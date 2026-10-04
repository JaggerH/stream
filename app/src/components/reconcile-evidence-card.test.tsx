import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { EvidenceCard, VETO_TEXT, vetoText } from './reconcile-evidence-card.tsx'
import { ActionCard, buildActionRows, explainLookup } from './reconcile-action-row.tsx'
import type { MatchVetoReason, ReconcilePlanAction, ReconcilePreview, RowExplain } from '../lib/types.ts'

/**
 * 证据卡（spec `2026-08-02-match-engine-evidence-graph-design.md` §5）。夹具是 **05 案**
 * （§5.2 的样例，数字照抄）：一份文件的名字指向付费的 05、时长却恰好命中免费的 005，
 * 而它与 05 正主字节全等——新引擎下它是一张"到底是哪一集"的出卡。
 *
 * 这一案正是判决书存在的理由：旧引擎把它静默丢成残差，卡片上那句"时长和名字都对不上节目单
 * 任何一集"是**假话**。所以断言盯的是**数字对照有没有摆出来**，而不是版面长什么样。
 */
const explain05: RowExplain = {
  file: { path: '玄关笔记/05.太极两仪生四象.mp3', sizeBytes: 93008691, durationS: 5808, kbps: 128 },
  edges: [
    {
      episode: { leftKey: '005', title: '005.身边那些灵异事', durationS: 5808, paid: false },
      facts: [
        { kind: 'duration', state: 'hit', deltaS: 0, toleranceS: 1 },
        { kind: 'name', method: 'sim', score: 0.06, cleanedLeft: '身边那些灵异事', cleanedRight: '太极两仪生四象', stripId: 'S0' },
      ],
      outcome: 'vetoed',
      vetoReason: 'name-floor',
      rule: 'R3',
    },
    {
      episode: { leftKey: '05', title: '05.太极两仪生四象', durationS: 2163, paid: true },
      facts: [
        { kind: 'name', method: 'identity-exact', score: 1, cleanedLeft: '太极两仪生四象', cleanedRight: '太极两仪生四象', stripId: 'S0' },
        { kind: 'duration', state: 'contradict', deltaS: 3645, toleranceS: 1 },
        { kind: 'byte-identity', peerPath: '来源/05.太极两仪生四象【耗时整理】.mp3' },
      ],
      outcome: 'vetoed',
      vetoReason: 'duration-contradict',
      rule: 'R11',
    },
  ],
  truncatedCount: 3,
  verdict: { rule: 'R13', disposition: 'asked' },
}

/** 跨元素拼出来的一句话（规则行是 span 套 span）：按 `textContent` 全等取。 */
function textEl(tag: string, text: string) {
  return screen.getByText((_, el) => el?.tagName === tag && el.textContent === text)
}

describe('EvidenceCard — 四段式', () => {
  it('① 文件事实：时长 · 大小 · 码率直渲（码率取后端算好的那个，前端不重算）', () => {
    render(<EvidenceCard explain={explain05} />)
    expect(screen.getByText('96:48 · 88.7 MiB · 128kbps')).toBeTruthy()
    expect(screen.getByText('玄关笔记/05.太极两仪生四象.mp3')).toBeTruthy()
  })

  it('① 缺的字段整格不出现——绝不 NaN / 空括号', () => {
    render(<EvidenceCard explain={{ ...explain05, file: { path: 'x.mp3', sizeBytes: 1024 } }} />)
    expect(screen.getByText('1 KiB')).toBeTruthy()
    expect(screen.queryByText(/NaN|undefined|kbps/)).toBeNull()
  })

  it('② 证据清单：每条边一集，事实带数字对照（两侧时长 + 差值 + 容差）', () => {
    render(<EvidenceCard explain={explain05} />)
    expect(screen.getByText('↔《005.身边那些灵异事》')).toBeTruthy()
    expect(screen.getByText('时长 5808s vs 5808s（差 0s，容差 1s）✓命中')).toBeTruthy()
    expect(screen.getByText('名字 sim 0.06')).toBeTruthy()
    expect(screen.getByText('时长 5808s vs 2163s（差 3645s，容差 1s）✗矛盾')).toBeTruthy()
    expect(screen.getByText('名字 清洗后全等（identity-exact）✓命中')).toBeTruthy()
    // 字节孪生：卡片一行就是一个文件，"它和谁字节全等"必须在这一页答得出来。
    expect(screen.getByText('与 05.太极两仪生四象【耗时整理】.mp3 字节全等')).toBeTruthy()
    // 付费/免费标记跟着集走（P9：它决定这一集有没有货架位）。
    expect(screen.getByText('免费')).toBeTruthy()
    expect(screen.getByText('付费')).toBeTruthy()
  })

  it('② 结构键事实照读键名与键值', () => {
    render(<EvidenceCard explain={{
      ...explain05,
      edges: [{ episode: { leftKey: '37', title: '第37集' }, facts: [{ kind: 'struct-key', key: 'epnum', value: '37' }], outcome: 'won' }],
    }} />)
    expect(screen.getByText('结构键 集号=37')).toBeTruthy()
    expect(screen.getByText('✓ 胜出')).toBeTruthy()
  })

  it('② 被驳回的边显示人话理由 + 是哪条规则驳的', () => {
    render(<EvidenceCard explain={explain05} />)
    expect(textEl('P', '驳回理由：时长撞上了，但名字连地板都不沾——不足以认成这一集（R3 时长唯一命中 × 名字地板不过）')).toBeTruthy()
    expect(textEl('P', '驳回理由：两边时长差出量级，不是同一段内容（R11 横向时长矛盾闸）')).toBeTruthy()
  })

  it('② 缺映射的驳回码**原样露出来**——宁可露码，不许编话', () => {
    render(<EvidenceCard explain={{
      ...explain05,
      edges: [{ ...explain05.edges[0], vetoReason: 'brand-new-code' as MatchVetoReason, rule: undefined }],
    }} />)
    expect(textEl('P', '驳回理由：brand-new-code')).toBeTruthy()
  })

  it('② 截掉的弱证据边如实交代条数，不假装没有过', () => {
    render(<EvidenceCard explain={explain05} />)
    expect(screen.getByText('另有 3 条弱证据边未列（轨迹里有）')).toBeTruthy()
  })

  it('② truncatedCount 缺席 / 为 0 时不出这一行', () => {
    render(<EvidenceCard explain={{ ...explain05, truncatedCount: 0 }} />)
    expect(screen.queryByText(/条弱证据边未列/)).toBeNull()
  })

  it('② 一条边都没有的文件：直说，不留一段空白让人猜', () => {
    render(<EvidenceCard explain={{ ...explain05, edges: [], truncatedCount: undefined }} />)
    expect(screen.getByText('一条证据边都没有——节目单里没有任何一集与它沾边。')).toBeTruthy()
  })

  it('③ 裁决：规则编号 + 短名（镜像后端 RULES）+ 处置去向', () => {
    render(<EvidenceCard explain={explain05} />)
    expect(textEl('P', 'R13 双集冲突 → 出卡（要你决定）')).toBeTruthy()
  })

  it('③ 残差没有规则编号 → 直说没人认领它，不编一个号出来', () => {
    render(<EvidenceCard explain={{ ...explain05, verdict: { disposition: 'residual' } }} />)
    expect(textEl('P', '没有任何规则认领它 → 残差（没配上任何一集）')).toBeTruthy()
  })

  it('③ 没镜像到的规则号只显示号，不编名字', () => {
    render(<EvidenceCard explain={{ ...explain05, verdict: { rule: 'R99', disposition: 'claimed' } }} />)
    expect(textEl('P', 'R99 → 认领（这一集的正主）')).toBeTruthy()
  })

  it('③ 门槛对照：命中值 vs 阈值，过了打 ✓ 没过打 ✗（记号跟着数字走，不跟着处置走）', () => {
    render(<EvidenceCard explain={{
      ...explain05,
      verdict: { rule: 'R5', disposition: 'claimed', thresholds: { sim: { got: 0.571, need: 0.6 }, nameFloor: { got: 0.571, need: 0.3 } } },
    }} />)
    expect(textEl('LI', '相似度 命中 0.571 / 门槛 0.6 ✗')).toBeTruthy()
    expect(textEl('LI', '名字地板 命中 0.571 / 门槛 0.3 ✓')).toBeTruthy()
  })

  it('③ 没镜像到的门槛键原样显示（同露码原则）', () => {
    render(<EvidenceCard explain={{ ...explain05, verdict: { rule: 'R5', disposition: 'claimed', thresholds: { newGate: { got: 2, need: 1 } } } }} />)
    expect(textEl('LI', 'newGate 命中 2 / 门槛 1 ✓')).toBeTruthy()
  })
})

describe('驳回理由映射表', () => {
  /**
   * 后端 `VetoReason` 闭集的全部 10 个值。**这份清单是手抄的镜像**：后端加了值、镜像类型
   * 同步过来时，`VETO_TEXT` 少一条就编译不过（`Record<MatchVetoReason, string>`），
   * 而这条测试守的是另一半——映射表里不许多出后端没有的键，也不许有一条空话。
   */
  const ALL: MatchVetoReason[] = [
    'duration-contradict', 'name-floor', 'zero-competition-loser', 'below-threshold', 'no-margin',
    'left-claimed', 'file-claimed', 'quality-dedup', 'no-adjudicable-fact', 'unevaluated',
  ]

  it('10 个值全有人话，一条不缺', () => {
    for (const r of ALL) {
      expect(VETO_TEXT[r], r).toBeTruthy()
      expect(vetoText(r), r).not.toBe(r) // 有映射就不该露码
    }
  })

  it('映射表不多不少，正好是那个闭集', () => {
    expect(Object.keys(VETO_TEXT).sort()).toEqual([...ALL].sort())
  })
})

// —— ⓘ 在行上的出现条件与开合 ——

const moveAction: ReconcilePlanAction = {
  kind: 'move',
  key: 'k1',
  src: { path: '/来源/05.太极两仪生四象.mp3', name: '05.太极两仪生四象.mp3', size: 93008691, durationS: 5808 },
  dstDir: '/库/付费',
  basis: 'authority:05',
  episode: '05.太极两仪生四象',
}

describe('ActionCard 上的 ⓘ', () => {
  it('有判决书 → 出 ⓘ；点开是那张四段式的卡', () => {
    const [row] = buildActionRows([moveAction], { where: () => null, explainOf: () => explain05 })
    render(<ActionCard row={row} />)
    const btn = screen.getByLabelText('这条判定的证据')
    expect(screen.queryByTestId('evidence-card')).toBeNull() // 没点之前不占地方
    fireEvent.click(btn)
    expect(screen.getByTestId('evidence-card')).toBeTruthy()
    expect(textEl('P', 'R13 双集冲突 → 出卡（要你决定）')).toBeTruthy()
  })

  /**
   * 上一条走的是**没有 hover 能力**那一档（jsdom 的 matchMedia 恒 false → Popover，点开）。
   * 桌面才是这张卡的主场，那一档是 HoverCard：悬上去就出，不用点。判据是指针能力，
   * 所以这里把 `(hover: hover)` 顶成 true 来选那一支。
   */
  it('有鼠标 → 走 HoverCard：悬上去就出卡', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('hover: hover'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }))
    try {
      const [row] = buildActionRows([moveAction], { where: () => null, explainOf: () => explain05 })
      render(<ActionCard row={row} />)
      fireEvent.pointerEnter(screen.getByLabelText('这条判定的证据'), { pointerType: 'mouse' })
      await waitFor(() => expect(screen.getByTestId('evidence-card')).toBeTruthy())
    } finally {
      vi.unstubAllGlobals()
    }
  })

  /**
   * 弹层的**装配**，不是它落在屏幕哪里——jsdom 没有布局，量坐标只会量出一堆 0，
   * 写"卡片没超出视口"那种断言是**假装量过**。真正的定位由 floating-ui 在浏览器里算，
   * 这里守的是喂给它的那几件东西还在不在（活体验证见 commit 说明）：
   *
   * - 高度上限跟着 `--radix-popper-available-height`（Radix `size` 现量的空档）。写死的
   *   `60vh` 正是缺陷①的成因：那个常数和空档没有任何关系，两边放不下时卡片就画到屏幕外。
   * - 背景是比面板更实的 `--acr-panel-solid`（缺陷②：同材质叠同材质，底层行文字透上来）。
   */
  it('弹层带着「按可用高度收口 + 比面板更实一档」的装配', () => {
    const [row] = buildActionRows([moveAction], { where: () => null, explainOf: () => explain05 })
    render(<ActionCard row={row} />)
    fireEvent.click(screen.getByLabelText('这条判定的证据'))
    // popper content 认 `data-side`（Radix 的稳定契约）——acrylic 的 popover 没打 data-slot。
    const content = screen.getByTestId('evidence-card').closest('[data-side]')
    expect(content).toBeTruthy()
    const cls = content!.className
    expect(cls).toContain('max-h-[var(--radix-popper-available-height)]')
    expect(cls).not.toContain('max-h-[60vh]')
    expect(cls).toContain('bg-[var(--acr-panel-solid)]')
    expect(cls).toContain('overflow-y-auto') // 收口之后超出的部分要能自己滚
  })

  it('没有判决书 → **连图标都不渲染**，不留占位', () => {
    const [row] = buildActionRows([moveAction], { where: () => null })
    render(<ActionCard row={row} />)
    expect(screen.queryByLabelText('这条判定的证据')).toBeNull()
    // 复制按钮照旧在——ⓘ 缺席不许把这一角一起端走。
    expect(screen.getByLabelText('复制这条决策')).toBeTruthy()
  })

  it('查不到这一份的判决书（豁免/字节全等那两档）→ 同样不出 ⓘ', () => {
    const [row] = buildActionRows([moveAction], { where: () => null, explainOf: () => undefined })
    render(<ActionCard row={row} />)
    expect(screen.queryByLabelText('这条判定的证据')).toBeNull()
  })
})

describe('explainLookup', () => {
  const preview = (ledger: ReconcilePreview['ledger']): ReconcilePreview => ({
    plan: [],
    counts: { move: 0, deleteDup: 0, deleteLoser: 0, replace: 0, pending: 0, moveClaimed: 0, moveSecondary: 0 },
    ledger,
  })

  it('主池的行按路径查得到', () => {
    const at = explainLookup(preview({
      runId: 'r1',
      rows: [{ path: '/a.mp3', size: 1, verdict: 'claimed', basis: 'authority:1', action: 'none', explain: explain05 }],
    }))
    expect(at('/a.mp3')).toBe(explain05)
    expect(at('/b.mp3')).toBeUndefined()
  })

  it('**下架复核那一趟的行一起合进来**——漏了这一半，复核出来的卡片永远没有 ⓘ', () => {
    const at = explainLookup(preview({
      runId: 'r1',
      rows: [],
      secondaryReview: { checked: 1, rows: [{ path: '/下架/x.mp3', size: 1, verdict: 'copy', basis: 'shelf-copy-of:/库/x.mp3', action: 'none', explain: explain05 }] },
    }))
    expect(at('/下架/x.mp3')).toBe(explain05)
  })

  it('老响应没有 rows → 恒查不到（优雅降级，绝不补算）', () => {
    expect(explainLookup(preview({ runId: 'r1' }))('/a.mp3')).toBeUndefined()
    expect(explainLookup(null)('/a.mp3')).toBeUndefined()
    expect(explainLookup(undefined)('/a.mp3')).toBeUndefined()
  })
})
