import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { DedupePreview, type DedupeGroup } from './DedupePreview.tsx'
import type { ReconcilePreview } from '../lib/types.ts'

const GiB = 1024 ** 3

/** 一份混合清单：质量落选删一条、字节全等删一条（没带集名，验退化）、换正主两条（质量更优 +
 *  时长择优，删的都是旧那份）、两条待定。
 *  质量落选那条**跨两边**（删来源那份、留库内那份）——「库内/来源」徽标要靠它才验得到。 */
const preview: ReconcilePreview = {
  shelves: { claimed: '/quark/剧集/某剧', secondary: '/quark/剧集/某剧/下架' },
  sourceDirs: ['/quark/来源/某剧'],
  plan: [
    {
      kind: 'delete-loser', key: 'k1', episode: '第 1 集 开局',
      src: { path: '/quark/来源/某剧/Show.S01E01.1080p.mkv', name: 'Show.S01E01.1080p.mkv', size: 2 * GiB, durationS: 2700 },
      keptPath: '/quark/剧集/某剧/Show.S01E01.2160p.mkv',
      basis: 'quality-loser-of:/quark/剧集/某剧/Show.S01E01.2160p.mkv',
      compare: {
        authorityDurationS: 2700,
        candidates: [
          { path: '/quark/来源/某剧/Show.S01E01.1080p.mkv', size: 2 * GiB, durationS: 2700, inLib: false },
          { path: '/quark/剧集/某剧/Show.S01E01.2160p.mkv', size: 4 * GiB, durationS: 2700, inLib: true },
        ],
      },
    },
    {
      // 名字不在节目单里 → 后端没下发 episode，① 只能退化成「动作标签 + 作品名」。
      kind: 'delete-dup', key: 'k2',
      src: { path: '/quark/剧集/某剧/Show.S01E02.mkv', name: 'Show.S01E02.mkv', size: 1 * GiB },
      dupOf: '/quark/剧集/某剧/下架/Show.S01E02.mkv',
      basis: 'size-dup-of:/quark/剧集/某剧/下架/Show.S01E02.mkv',
    },
    {
      kind: 'replace', key: 'k5', episode: '第 4 集 反转',
      src: { path: '/quark/剧集/某剧/Show.S01E04.2160p.mkv', name: 'Show.S01E04.2160p.mkv', size: 3 * GiB },
      oldPath: '/quark/剧集/某剧/Show.S01E04.1080p.mkv',
      dstDir: '/quark/剧集/某剧',
      basis: 'quality-upgrade:/quark/剧集/某剧/Show.S01E04.1080p.mkv',
      compare: { candidates: [
        { path: '/quark/剧集/某剧/Show.S01E04.2160p.mkv', size: 3 * GiB, inLib: true },
        { path: '/quark/剧集/某剧/Show.S01E04.1080p.mkv', size: 1 * GiB, inLib: true },
      ] },
    },
    {
      // 质量比不出（差 5 秒 > 容差）→ 方向由节目单裁：来的这份 100:44 更贴近 100:43。
      kind: 'replace', key: 'k6', episode: '第 5 集 收官',
      src: { path: '/quark/来源/某剧/Show.S01E05.mkv', name: 'Show.S01E05.mkv', size: 2 * GiB, durationS: 6044 },
      oldPath: '/quark/剧集/某剧/Show.S01E05.mkv',
      dstDir: '/quark/剧集/某剧',
      basis: 'authority-duration:/quark/剧集/某剧/Show.S01E05.mkv',
      compare: {
        authorityDurationS: 6043,
        candidates: [
          { path: '/quark/来源/某剧/Show.S01E05.mkv', size: 2 * GiB, durationS: 6044, inLib: false },
          { path: '/quark/剧集/某剧/Show.S01E05.mkv', size: 2 * GiB, durationS: 6049, inLib: true },
        ],
      },
    },
    { kind: 'pending', key: 'k3', src: { path: '/quark/剧集/某剧/花絮.mkv', name: '花絮.mkv', size: 100 }, pendingKind: 'no-duration', reason: '时长没探到' },
    { kind: 'pending', key: 'k4', src: { path: '/quark/剧集/某剧/S01E03.mkv', name: 'S01E03.mkv', size: 100 }, pendingKind: 'replace', reason: '比不出高下' },
  ],
  counts: { move: 0, deleteDup: 1, deleteLoser: 1, replace: 2, pending: 2, moveClaimed: 0, moveSecondary: 0 },
}

const group = (over: Partial<DedupeGroup> = {}): DedupeGroup => ({ bindingId: 'map_1', label: '某剧', preview, ...over })

describe('DedupePreview', () => {
  it('汇总：将删份数 + 省下的空间(三类删都算) + 待定条数', () => {
    render(<DedupePreview groups={[group()]} onConfirm={() => {}} />)
    const summary = screen.getByTestId('dedupe-summary').textContent ?? ''
    expect(summary).toContain('将删 4')
    // 2 GiB(质量落选) + 1 GiB(字节全等) + 1 GiB + 2 GiB(两条换正主删掉的**旧那份**,不是上位那份)
    expect(summary).toContain('6.00 GiB')
    expect(summary).toContain('2 条待定')
  })

  /** 一张卡的完整文本——①②③④ 各占一段，断言直接对着整张卡看。 */
  /**
   * 取渲染这条路径的那个元素。**不能用 `getByText(整条路径)`**：路径拆成了「目录段 muted +
   * 文件名 foreground」两段，而 RTL 的文本匹配只看**直接文本子节点**，整条已经不在同一个文本
   * 节点里。按 `textContent` 全等取——这条断言同时守着"整条路径完整摆着、没被 truncate"。
   */
  const pathEl = (path: string) => screen.getByText(
    (_, el) => typeof el?.className === 'string' && el.className.includes('break-all') && el.textContent === path,
  )
  /** 一条动作 = 一张 Card。取"这条路径所在的那张卡"——卡的边界就是一个决定单元。 */
  const cardOf = (path: string) => pathEl(path).closest('[data-slot="card"]') as HTMLElement
  const cardTextOf = (path: string) => cardOf(path).textContent ?? ''
  /** 这条路径那一行的处置方向：`gone`=✗ 要走、`kept`=✓ 留下。**方向断言一律钉在这个抓手上**——
   *  查 lucide 那个 svg 的内部形状既读不出语义，图标库一换又全红。 */
  const toneOf = (path: string) =>
    (pathEl(path).closest('[data-slot="item"]') as HTMLElement)
      .querySelector('[data-slot="item-media"]')
      ?.getAttribute('data-tone') ?? null

  /**
   * 一张卡的**结构固定**：① 集名（`CardTitle`）② 现任 ③ 另一份（各一个 `Item`，一个文件一个）
   * ④ 原因（`CardFooter`）。三类动作同构——位置不随动作变，谁被处置只由行首那个 ✓/✗ 说。
   * 顺序一旦承载语义，`replace`（删的恰恰是"现任"那一行）必然被读反。
   *
   * 「现任 / 另一份」是**行位的名字，不印在界面上**——所以这里拿各自的动作词（`sr-only`，
   * 图标的无障碍名）当锚点验顺序。
   */
  it('一张卡：① 集名 ② 现任 ③ 另一份 ④ 原因，结构固定', () => {
    render(<DedupePreview groups={[group()]} onConfirm={() => {}} />)
    const card = cardOf('/quark/来源/某剧/Show.S01E01.1080p.mkv')
    const t = card.textContent ?? ''
    expect(card.querySelectorAll('[data-slot="card-title"]').length).toBe(1)
    expect(card.querySelectorAll('[data-slot="item"]').length).toBe(2)        // ②③ 一个文件一个，不多不少
    expect(card.querySelectorAll('[data-slot="card-footer"]').length).toBe(1) // ④
    expect(t.indexOf('第 1 集 开局')).toBeLessThan(t.indexOf('保留'))
    expect(t.indexOf('保留')).toBeLessThan(t.indexOf('删除/quark/来源'))
    expect(t.indexOf('删除/quark/来源')).toBeLessThan(t.indexOf('原因：'))
  })

  // 换正主删的是 `oldPath`、留的是 `src`——和另两类正好相反。行位不变（② 永远是现任），
  // 方向靠图标说死：② 现任是 ✗（gone）、③ 上位那份是 ✓（kept）。照 `src` 一律排在同一位
  // 就会把"删旧的换新的"显示成"删新的",用户对着这个按钮点下去的是反的那件事。
  it('换正主行：② 现任标 ✗、③ 上位那份标 ✓，两条路径都完整摆出来', () => {
    render(<DedupePreview groups={[group()]} onConfirm={() => {}} />)
    const card = cardTextOf('/quark/剧集/某剧/Show.S01E04.1080p.mkv')
    // ① 说的是动作类别（这条要干什么），不是判据——判据在 ④ 那句原因里，带具体数字。
    expect(card).toContain('换正主')
    expect(card).toContain('移出/quark/剧集/某剧/Show.S01E04.1080p.mkv') // 被删的那份
    expect(card).toContain('上位/quark/剧集/某剧/Show.S01E04.2160p.mkv') // 上位的那份
    // 方向钉在图标上：现任 ✗ 要走、上位那份 ✓ 留下——和删除类恰好相反。
    expect(toneOf('/quark/剧集/某剧/Show.S01E04.1080p.mkv')).toBe('gone')
    expect(toneOf('/quark/剧集/某剧/Show.S01E04.2160p.mkv')).toBe('kept')
  })

  // 删不可逆——每一条都必须说清"留的是哪份"，否则确认按钮无从按起。删除类里 ② 是 ✓ 保留、③ 是 ✗ 删除。
  it('删除行：② 现任标 ✓ 保留、③ 这份标 ✗ 删除', () => {
    render(<DedupePreview groups={[group()]} onConfirm={() => {}} />)
    const loser = cardTextOf('/quark/来源/某剧/Show.S01E01.1080p.mkv')
    expect(loser).toContain('删除同集副本')
    expect(loser).toContain('保留/quark/剧集/某剧/Show.S01E01.2160p.mkv')
    expect(loser).toContain('删除/quark/来源/某剧/Show.S01E01.1080p.mkv')
    expect(toneOf('/quark/剧集/某剧/Show.S01E01.2160p.mkv')).toBe('kept')
    expect(toneOf('/quark/来源/某剧/Show.S01E01.1080p.mkv')).toBe('gone')

    const dup = cardTextOf('/quark/剧集/某剧/Show.S01E02.mkv')
    expect(dup).toContain('删除重复')
    expect(dup).toContain('保留/quark/剧集/某剧/下架/Show.S01E02.mkv')
    expect(dup).toContain('删除/quark/剧集/某剧/Show.S01E02.mkv')
    expect(toneOf('/quark/剧集/某剧/下架/Show.S01E02.mkv')).toBe('kept')
    expect(toneOf('/quark/剧集/某剧/Show.S01E02.mkv')).toBe('gone')
  })

  /**
   * ① 的集名只认后端下发的 `episode`（节目单里的名字）。缺席时退化成「动作标签 + 作品名」——
   * 不拿文件名冒充集名，也不留一行空的。
   */
  it('① 集名来自 episode；缺 episode 时退化成动作标签 + 作品名，不渲染空标题', () => {
    render(<DedupePreview groups={[group()]} onConfirm={() => {}} />)
    const titleOf = (path: string) => cardOf(path).querySelector('[data-slot="card-title"]')?.textContent ?? ''
    expect(titleOf('/quark/来源/某剧/Show.S01E01.1080p.mkv')).toContain('第 1 集 开局')
    expect(titleOf('/quark/剧集/某剧/Show.S01E05.mkv')).toContain('第 5 集 收官')

    // 名称在前、动作类别标记在后——一屏扫下来先读到的是名称，不是每张卡都一样的类别词。
    const bare = titleOf('/quark/剧集/某剧/Show.S01E02.mkv') // 这条没有 episode
    expect(bare).toBe('某剧删除重复')
  })

  /**
   * ④ 原因由**机器可读的 `basis` 前缀 + compare 数字**组装，绝不解析中文 `reason`：
   * 措辞随后端改，靠字符串分支等于把 UI 挂在没有契约的东西上。
   */
  it('④ 原因：按 basis 各说各的，数字都是现算的', () => {
    render(<DedupePreview groups={[group()]} onConfirm={() => {}} />)
    const reasonOf = (path: string) =>
      cardOf(path).querySelector('[data-slot="card-footer"]')?.textContent ?? ''

    expect(reasonOf('/quark/来源/某剧/Show.S01E01.1080p.mkv'))
      .toBe('原因：现任质量不低于这份（清晰度 2160p ≥ 1080p）')
    expect(reasonOf('/quark/剧集/某剧/Show.S01E04.1080p.mkv'))
      .toBe('原因：这份质量更高（清晰度 2160p > 1080p），换上去')
    expect(reasonOf('/quark/剧集/某剧/Show.S01E02.mkv'))
      .toBe('原因：两份字节数完全相同 = 同一份文件（1.00 GiB）')

    // 时长择优那条：留下那份、节目单、落选那份三个时长都得摆出来，才看得出"贴近"是贴多近。
    const dur = reasonOf('/quark/来源/某剧/Show.S01E05.mkv')
    expect(dur).toContain('100:44')  // 上位那份
    expect(dur).toContain('100:43')  // 节目单
    expect(dur).toContain('现任 100:49，差 6 秒')
  })

  /**
   * 复制按钮：复制的**不是名称，是整条决策**——用户的原话是"主要是我要复制给你看"，只给名称
   * 对面什么都判断不了。所以这里断言的是**完整文本全等**，不是"包含集名"这种松断言：
   * 少一段就是少一份诊断依据，而松断言恰恰看不出少了哪一段。
   *
   * **末行的 `basis` 是关键**：界面上不显示它（那是机器可读的判据，摆出来只会挤掉人话），
   * 但 ④ 那句原因是前端按 basis 现编的，答不了"后端到底走了哪个分支"——不带上它，
   * 复制出去的东西就诊断不了。
   */
  it('复制按钮：整条决策的纯文本，末行带 basis 原文', () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

    render(<DedupePreview groups={[group()]} onConfirm={() => {}} />)
    const card = cardOf('/quark/来源/某剧/Show.S01E01.1080p.mkv')
    fireEvent.click(card.querySelector('button[aria-label="复制这条决策"]') as HTMLElement)

    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText.mock.calls[0][0]).toBe(
      [
        '删除同集副本 · 第 1 集 开局（节目单 45:00）',
        '✓ 保留 /quark/剧集/某剧/Show.S01E01.2160p.mkv',
        '       库内 · 45:00 · 4.00 GiB · 12726k',
        '✗ 删除 /quark/来源/某剧/Show.S01E01.1080p.mkv',
        '       来源 · 45:00 · 2.00 GiB · 6363k',
        '原因：现任质量不低于这份（清晰度 2160p ≥ 1080p）',
        '判据：quality-loser-of:/quark/剧集/某剧/Show.S01E01.2160p.mkv',
      ].join('\n'),
    )
  })

  // 缺字段就少那一段，绝不出 undefined / 空括号。这条没有 episode、没有 authorityDurationS，
  // 留下那份没有并排数据（delete-dup 只带一条路径）所以只剩「库内」一格，删掉那份没时长所以没码率
  // ——每一处缺席各自安静地少一段，而不是留个空位或编一个值。
  it('复制文本：缺的字段整段不出现，不编 undefined / 空括号', () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

    render(<DedupePreview groups={[group()]} onConfirm={() => {}} />)
    const card = cardOf('/quark/剧集/某剧/Show.S01E02.mkv')
    fireEvent.click(card.querySelector('button[aria-label="复制这条决策"]') as HTMLElement)

    const text = writeText.mock.calls[0][0] as string
    expect(text).toBe(
      [
        '删除重复 · 某剧',                                   // 没有 episode → 退化成作品名，没有「节目单」那半句
        '✓ 保留 /quark/剧集/某剧/下架/Show.S01E02.mkv',
        '       库内',                                       // 没并排数据 → 只剩得出的那一格，不编时长体量
        '✗ 删除 /quark/剧集/某剧/Show.S01E02.mkv',
        '       库内 · 1.00 GiB',                            // 没时长 → 没码率
        '原因：两份字节数完全相同 = 同一份文件（1.00 GiB）',
        '判据：size-dup-of:/quark/剧集/某剧/下架/Show.S01E02.mkv',
      ].join('\n'),
    )
    expect(text).not.toContain('undefined')
    expect(text).not.toContain('NaN')
    expect(text).not.toContain('（）')
  })

  /**
   * 用户看不懂旧清单的原话：「我都不知道哪个是库里的文件，哪个 source 里面的文件，而且叙述还不全，
   * 不换行自动 ellipse 了」。三样东西缺一不可：**完整路径**（判据是目录，被 ellipsis 吞掉就没了）、
   * **库内/来源**（判据是货架/来源目录前缀，后端下发）、**时长与码率**（判是不是这一集、谁音质好）。
   */
  it('库内/来源徽标 + 完整路径 + 时长码率：跨两边的那张卡两个主体各自标对', () => {
    render(<DedupePreview groups={[group()]} onConfirm={() => {}} />)
    const card = cardOf('/quark/来源/某剧/Show.S01E01.1080p.mkv')

    // 完整路径整条在 DOM 里（不是 basename，也没有 truncate 类）
    expect(pathEl('/quark/来源/某剧/Show.S01E01.1080p.mkv').className).not.toContain('truncate')
    expect(pathEl('/quark/剧集/某剧/Show.S01E01.2160p.mkv')).toBeTruthy()

    // 删的那份在来源目录下、留的那份在认领货架下
    expect(card.textContent).toContain('删除/quark/来源/某剧/Show.S01E01.1080p.mkv来源')
    expect(card.textContent).toContain('保留/quark/剧集/某剧/Show.S01E01.2160p.mkv库内')

    expect(card.textContent).toContain('节目单 45:00')                 // 2700s
    expect(card.textContent).toContain('6363k')                        // 2GiB×8÷2700÷1000
    expect(card.textContent).toContain('12726k')                       // 4GiB×8÷2700÷1000
  })

  // 后端没下发货架地址（老响应）→ 徽标整格不显示,绝不猜；缺时长/体量也不渲染 NaN。
  it('缺字段不瞎猜：没有 shelves 就不出徽标，没有时长就不出码率', () => {
    const bare: ReconcilePreview = { ...preview, shelves: undefined, sourceDirs: undefined }
    render(<DedupePreview groups={[group({ preview: bare })]} onConfirm={() => {}} />)
    const card = cardOf('/quark/剧集/某剧/Show.S01E02.mkv')
    expect(card.textContent).not.toContain('库内')
    expect(card.textContent).not.toContain('来源')
    expect(card.textContent).not.toContain('NaN')
    expect(card.textContent).not.toContain('undefined')
    expect(card.textContent).not.toContain('（）')
    // 留下那份只有路径（delete-dup 没带并排数据）——那一段就只有路径，不编时长出来
    expect(card.textContent).toContain('保留/quark/剧集/某剧/下架/Show.S01E02.mkv')
  })

  it('待定按 pendingKind 分组简列（不解析中文 reason）', () => {
    render(<DedupePreview groups={[group()]} onConfirm={() => {}} />)
    expect(screen.getByTestId('pending-no-duration').textContent).toContain('时长还没探到')
    expect(screen.getByTestId('pending-replace').textContent).toContain('× 1')
  })

  /**
   * **等位那一句不许承诺时间点。** 它对"卡住"那一档是假话：占位者本轮谁都不动时，
   * 没有任何一条动作会去腾那个位置，它永远不会"自动搬入"、也不存在"下一轮"。
   *
   * 而这个面板**分不出**是哪一档——分档判据是"占位者在不在本轮计划里"（`splitSwapHolds`），
   * 只有整理面板做了那一步。这里只能说对两档都成立的那件事：**位置被什么占着**。
   */
  it('等位那句只说位置被什么占着，不承诺"下一轮自动落位"', () => {
    const withHold = {
      ...group().preview!,
      plan: [
        ...group().preview!.plan,
        { kind: 'pending' as const, key: 'k5', pendingKind: 'swap-hold' as const,
          src: { path: '/quark/剧集/某剧/S01E04.mkv', name: 'S01E04.mkv', size: 100 },
          reason: '目标目录已有同名文件…' },
      ],
    }
    render(<DedupePreview groups={[group({ preview: withHold })]} onConfirm={() => {}} />)
    const text = screen.getByTestId('pending-swap-hold').textContent ?? ''
    expect(text).toContain('占')            // 说得出位置被占着
    expect(text).not.toContain('下一轮')     // 不承诺时间点
    expect(text).not.toContain('自动搬入')   // 更不承诺它会自己发生
    expect(text).not.toContain('自然落位')
  })

  it('确认按钮触发回调；执行中禁用', () => {
    const onConfirm = vi.fn()
    const { rerender } = render(<DedupePreview groups={[group()]} onConfirm={onConfirm} />)
    fireEvent.click(screen.getByRole('button', { name: /确认执行/ }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    rerender(<DedupePreview groups={[group()]} executing onConfirm={onConfirm} />)
    expect(screen.getByRole('button', { name: /执行中/ }).hasAttribute('disabled')).toBe(true)
  })

  // 批量扫时一条绑定算不出来不该拖垮别的：原因如实占一行，别的清单照常摆出来。
  it('多绑定：预览失败那条列出原文，成功的照常渲染并带上作品名', () => {
    render(
      <DedupePreview
        groups={[group(), { bindingId: 'map_2', label: '另一部', preview: null, error: '绑定没有落地目录' }]}
        onConfirm={() => {}}
      />,
    )
    expect(screen.getByText(/绑定没有落地目录/)).toBeTruthy()
    expect(screen.getAllByText('某剧').length).toBeGreaterThan(0)
  })

  it('没有可删的 → 说清楚，并且确认按钮点不动', () => {
    const empty: ReconcilePreview = { plan: [], counts: { move: 0, deleteDup: 0, deleteLoser: 0, replace: 0, pending: 0, moveClaimed: 0, moveSecondary: 0 } }
    render(<DedupePreview groups={[group({ preview: empty })]} onConfirm={() => {}} />)
    expect(screen.getByText(/每一集都只有一份/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /确认执行/ }).hasAttribute('disabled')).toBe(true)
  })

  // 「错误是行，不是日志」：执行的逐条错误原样列出，不汇总成一句「N 条出错」了事。
  it('执行结果逐条呈现，errors 原样列出；执行后不再给确认按钮', () => {
    render(
      <DedupePreview
        groups={[group({ result: { moved: 0, deleted: 1, pending: 2, errors: ['delete /quark/剧集/某剧/Show.S01E02.mkv: alist 500'] } })]}
        executed
        onConfirm={() => {}}
      />,
    )
    expect(screen.getByText(/删除 1，移动 0/)).toBeTruthy()
    expect(screen.getByText(/alist 500/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /确认执行/ })).toBeNull()
  })

  /**
   * 免费集副本（付费货架契约）：**只有一个主体**——留下的那份不是文件，是源站自己。
   * 硬凑成"保留 + 删除"两行就得给"保留"那一格编一个不存在的路径出来。
   */
  it('免费集副本行：只摆这一份 + 一句为什么，不去找不存在的另一半', () => {
    const free: ReconcilePreview = {
      shelves: { claimed: '/quark/剧集/某剧' },
      sourceDirs: [],
      plan: [{
        kind: 'delete-redundant', key: 'kf', episode: '600.免费那一集',
        src: { path: '/quark/剧集/某剧/600.免费那一集.mp3', name: '600.免费那一集.mp3', size: 1 * GiB, durationS: 1500 },
        basis: 'redundant-free:LF',
      }],
      counts: { move: 0, deleteDup: 0, deleteLoser: 0, replace: 0, pending: 0, moveClaimed: 0, moveSecondary: 0, deleteRedundant: 1 },
    }
    render(<DedupePreview groups={[group({ preview: free })]} onConfirm={() => {}} />)
    const card = cardOf('/quark/剧集/某剧/600.免费那一集.mp3')
    expect(card.querySelectorAll('[data-slot="item"]').length).toBe(1) // 一个主体，不是两个
    const t = card.textContent ?? ''
    expect(t).toContain('删除免费集副本')
    expect(t).toContain('源站自己能播')
    expect(t).toContain('回收站')
    expect(toneOf('/quark/剧集/某剧/600.免费那一集.mp3')).toBe('gone')
    // 它照样算进「将删 N / 省下多少」——那一档定时轮真的会删
    expect(screen.getByTestId('dedupe-summary').textContent ?? '').toContain('将删 1')
  })

  it('核对时出的错（探时长失败）随清单可见', () => {
    const withErrors: ReconcilePreview = {
      ...preview,
      ledger: { runId: 'r1', errors: [{ path: '/quark/剧集/某剧/花絮.mkv', stage: 'probe', detail: '探不到时长（凭证/网络/编码）' }] },
    }
    render(<DedupePreview groups={[group({ preview: withErrors })]} onConfirm={() => {}} />)
    expect(screen.getByText(/探不到时长/)).toBeTruthy()
  })
})
