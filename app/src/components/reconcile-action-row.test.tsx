import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ActionCard, buildActionRows, copyTextOf } from './reconcile-action-row.tsx'
import type { ReconcilePlanAction } from '../lib/types.ts'

afterEach(cleanup)

/**
 * **来路标注**：一张卡要说清这条建议是**怎么来的**——某一集去清单里找自己的文件
 * （"哪个文件是我？"），还是没有任何一集认领这份文件、只能从它自己的证据边反推（"我该怎么办？"）。
 * 两者在产品语义上是两件事，过去卡片长得一模一样。
 *
 * 判据只认后端下发的机器可读 `origin`，**绝不从 `basis` 前缀或中文 `reason` 里推**。
 */

const where = () => null

const claimed: ReconcilePlanAction = {
  kind: 'move', key: 'k1', origin: 'authority',
  src: { path: '/src/037.三谈身边灵异事.mp3', name: '037.三谈身边灵异事.mp3', size: 100, durationS: 1500 },
  dstDir: '/lib/付费', basis: 'authority:L037', episode: '037.三谈身边灵异事',
}
const fromFile: ReconcilePlanAction = {
  kind: 'delete-redundant', key: 'k2', origin: 'file',
  src: { path: '/src/37.申与酉.mp3', name: '37.申与酉.mp3', size: 100, durationS: 3000 },
  basis: 'redundant-free-candidates:L037,L038',
}

const rowOf = (a: ReconcilePlanAction) => buildActionRows([a], { where })[0]

describe('来路标注：一条建议是从清单出发还是从网盘文件出发', () => {
  it('后端的 origin 原样带到卡片数据上（不解析 basis）', () => {
    expect(rowOf(claimed).origin).toBe('authority')
    expect(rowOf(fromFile).origin).toBe('file')
  })

  it('两类卡各自渲染出可区分的标识', () => {
    render(<ActionCard row={rowOf(claimed)} />)
    const a = screen.getByTestId('action-origin')
    expect(a.getAttribute('data-origin')).toBe('authority')
    expect(a.textContent).toBe('从清单出发')

    cleanup()
    render(<ActionCard row={rowOf(fromFile)} />)
    const b = screen.getByTestId('action-origin')
    expect(b.getAttribute('data-origin')).toBe('file')
    expect(b.textContent).toBe('从网盘文件出发')
  })

  // 「要你决定」那一档同样要标——那正是两条来路问的问题最不一样的地方
  // （集侧问"是不是这一集"，文件侧问"到底是哪一集"）。
  it('待定卡也带来路', () => {
    const ask: ReconcilePlanAction = {
      kind: 'pending', key: 'k3', origin: 'authority', pendingKind: 'duration-collision',
      src: { path: '/src/无名氏.mp3', name: '无名氏.mp3', size: 100, durationS: 6044 },
      episode: '037.三谈身边灵异事', collidesWith: 'L037', reason: '时长对得上、名字完全不沾',
      basis: 'ambiguous:name-floor:L037',
    }
    render(<ActionCard row={rowOf(ask)} />)
    expect(screen.getByTestId('action-origin').getAttribute('data-origin')).toBe('authority')
  })

  // 老后端没有这个字段 → 不渲染标识，绝不猜一个（同 `explain` / `shelves` 那条优雅降级约定）。
  it('后端没下发 origin → 整格不显示', () => {
    const { origin: _drop, ...legacy } = claimed
    render(<ActionCard row={rowOf(legacy)} />)
    expect(screen.queryByTestId('action-origin')).toBeNull()
  })

  /**
   * **文件侧卡片的标题 = 那份网盘文件的文件名。**
   *
   * 活体 2026-08-02：一张 `delete-redundant` 卡的标题印着「怡楽播客」——那是**整个节目**的名字，
   * 不是这张卡的主角。它之所以顶上来当标题，是因为这一条填不出集名（判据里三个候选集，机器
   * 并不知道是哪一集），而卡片是照"只有一集"设计的、集名缺席就退化成作品名。
   *
   * 从文件出发的卡，主角本来就是**那份文件**：这条建议针对的是它，用户要判断的也是它。
   * 从清单出发的卡不动——那一档的主角确实是那一集（下面那条回归钉着它）。
   */
  describe('从网盘文件出发的卡：主角是那份文件', () => {
    it('origin=file → 标题是文件名（不是节目名，也不是全路径）', () => {
      render(<ActionCard row={rowOf(fromFile)} />)
      expect(screen.getByTestId('action-subject').textContent).toBe('37.申与酉.mp3')
    })

    // 回归：从清单出发的那一档一个字都不许变——它的主角就是那一集。
    it('origin=authority → 标题仍是集名', () => {
      render(<ActionCard row={rowOf(claimed)} />)
      expect(screen.getByTestId('action-subject').textContent).toBe('037.三谈身边灵异事')
    })

    /**
     * 文件侧**也有**确定集名的那一档（`size-dup-of:`：字节全等，判据是这两份文件自己，
     * 所以来路是 file，但它确实知道是哪一集）。主角换成文件名，**集名不许因此丢掉**——
     * 它退成定语，和聚合视图里的作品名同一个位置。
     */
    it('文件侧但有集名 → 文件名当标题，集名退成定语（不丢）', () => {
      const sizeDup: ReconcilePlanAction = {
        kind: 'delete-dup', key: 'k4', origin: 'file',
        src: { path: '/src/600.那一集.mp3', name: '600.那一集.mp3', size: 100, durationS: 1500 },
        dupOf: '/lib/付费/600.那一集.mp3', basis: 'size-dup-of:/lib/付费/600.那一集.mp3',
        episode: '600.那一集',
      }
      const { container } = render(<ActionCard row={rowOf(sizeDup)} />)
      expect(screen.getByTestId('action-subject').textContent).toBe('600.那一集.mp3')
      expect(container.textContent).toContain('600.那一集')
    })

    // 老后端没有 origin → 照旧拿集名/作品名当标题，绝不猜一个文件名上去。
    it('没有 origin → 标题照旧是集名', () => {
      const { origin: _drop, ...legacy } = claimed
      render(<ActionCard row={rowOf(legacy)} />)
      expect(screen.getByTestId('action-subject').textContent).toBe('037.三谈身边灵异事')
    })

    /**
     * **卡住的等位**同一个形状：主角是等着的那份文件（一屏几张卡，退化成作品名就分不出谁是谁），
     * 而后端现在会带上**腾的是哪一集**——那句"位置被占着"少了集名就说不清占的是谁的位置。
     * 集名退成定语，一个字都不丢。缺席（没有集认领它的那些）照旧只剩文件名。
     */
    it('卡住的等位：文件名当主角，后端给的集名退成定语（不丢）', () => {
      const hold: ReconcilePlanAction = {
        kind: 'pending', key: 'k6', origin: 'authority', pendingKind: 'swap-hold',
        src: { path: '/quark/来源/玄关笔记/20.七杀.mp3', name: '20.七杀.mp3', size: 100, durationS: 2390 },
        blockedBy: '/quark/付费/玄关笔记/20.七杀.mp3', episode: '20.七杀',
        reason: '目标目录已有同名文件…',
      }
      const { container } = render(<ActionCard row={rowOf(hold)} />)
      expect(screen.getByTestId('action-subject').textContent).toBe('20.七杀.mp3')
      expect(container.textContent).toContain('20.七杀')
    })

    it('卡住的等位没有集名（没集认领它）→ 只剩文件名，绝不退化成作品名', () => {
      const hold: ReconcilePlanAction = {
        kind: 'pending', key: 'k7', origin: 'file', pendingKind: 'swap-hold',
        src: { path: '/quark/来源/092.穿衣服.mp3', name: '092.穿衣服.mp3', size: 100, durationS: 777 },
        blockedBy: '/quark/下架/092.穿衣服.mp3', reason: '目标目录已有同名文件…',
      }
      render(<ActionCard row={rowOf(hold)} />)
      expect(screen.getByTestId('action-subject').textContent).toBe('092.穿衣服.mp3')
    })
  })

  /**
   * **原因里要说出"推测对应哪一集"。**
   *
   * 活体那张卡的原因句是一句写死的常量（所有 `delete-redundant` 共用）：「这一集源站自己能播，
   * 网盘这份是冗余」。而卡上唯一出现的名字是 `37.申与酉`（一集**付费**的），用户读完以为是付费
   * 判断出错了——真正的依据是判据里那三个 leftKey 对应的集，卡片一个都没显示。
   *
   * **不许把不确定的说成确定的**：三个候选时机器并不知道是哪一集，它的逻辑是"这几集都不需要
   * 网盘供货，所以不论是哪一集都该删"。文案必须如实反映这一点。
   */
  describe('原因：说出推测对应的是哪一集', () => {
    const redundant = (candidateEpisodes?: string[]): ReconcilePlanAction => ({
      kind: 'delete-redundant', key: 'k5', origin: 'file',
      src: { path: '/lib/付费/玄关笔记/37.申与酉.mp3', name: '37.申与酉.mp3', size: 100, durationS: 6044 },
      basis: `redundant-free-candidates:${(candidateEpisodes ?? []).map((_, i) => `L${i}`).join(',')}`,
      ...(candidateEpisodes ? { candidateEpisodes } : {}),
    })

    it('只有一个候选 → 说得出是哪一集', () => {
      const reason = rowOf(redundant(['037.三谈身边灵异事'])).reason
      expect(reason).toContain('037.三谈身边灵异事')
      expect(reason).toContain('实际对应')
    })

    it('多个候选 → 全部列出来，且措辞不暗示已经定了是哪一集', () => {
      const eps = ['037.三谈身边灵异事', '756.大家都焦虑的这么具体了吗？', '857.夜半敲门声']
      const reason = rowOf(redundant(eps)).reason
      for (const e of eps) expect(reason).toContain(e)
      // 「实际对应」是单集那句的措辞——多候选时用它就是替机器把话说死了。
      expect(reason).not.toContain('实际对应')
      // 「不论是哪一集都该删」才是机器真正的逻辑，得写在明面上。
      expect(reason).toMatch(/哪一集/)
    })

    /**
     * **名单要截**。活体见过一份文件沾上二十几集——全列出来那句话长到没法读。
     * 上限跟后端 `evidence-conflict` 卡片那处同一个（`plan.ts` 的 `MAX_CARD_EPISODES = 3`）：
     * 同一个面板里两张卡对"列几个"给出两个答案，读的人会以为它们说的是两件事。
     *
     * **只截文案**。机器可读的那两份（`candidateEpisodes` 字段、`basis` 里那串 leftKey）
     * 一个都不许跟着截——它们是回传/诊断的凭据，少一个就对不回去。
     */
    it('候选超过上限 → 文案只点名头几个，其余说「等 N 个集」', () => {
      const eps = ['037.三谈', '756.焦虑', '857.夜半', '901.第四', '902.第五', '903.第六']
      const reason = rowOf(redundant(eps)).reason
      for (const e of eps.slice(0, 3)) expect(reason).toContain(e)
      for (const e of eps.slice(3)) expect(reason).not.toContain(e)
      expect(reason).toContain('等 6 个集')
    })

    it('截断只影响文案 —— candidateEpisodes 与 basis 保持全量', () => {
      const eps = ['037.三谈', '756.焦虑', '857.夜半', '901.第四', '902.第五', '903.第六']
      const a = redundant(eps)
      const row = rowOf(a)
      // basis 是复制出去做诊断的唯一凭据，照抄后端原文、一个 key 都不许少
      expect(row.basis).toBe('redundant-free-candidates:L0,L1,L2,L3,L4,L5')
      // 前端不许就地改后端给的对象
      expect(a.candidateEpisodes).toHaveLength(6)
    })

    it('截断后措辞照旧不许暗示已经定了是哪一集', () => {
      const eps = ['037.三谈', '756.焦虑', '857.夜半', '901.第四', '902.第五', '903.第六']
      const reason = rowOf(redundant(eps)).reason
      expect(reason).not.toContain('实际对应')
      expect(reason).toMatch(/哪一集/)
    })

    // 认领成立那一档（后端给确定的 `episode`、不给候选名单）→ 照旧那句，集名已经在标题上了。
    it('没有候选名单 → 原因句照旧（不编一个集名出来）', () => {
      const { candidateEpisodes: _drop, ...legacy } = redundant(['X'])
      const reason = rowOf(legacy).reason
      expect(reason).toBe('这一集源站自己能播，网盘这份是冗余——删除，夸克回收站里还能捞回来')
    })
  })

  /**
   * **试听：一条删除建议对不对，最后只有耳朵能裁。**
   *
   * 活体 2026-08-02：用户是自己去听了音频，才确认 `玄关笔记/37.申与酉.mp3` 里装的其实是
   * 《037.三谈身边灵异事》——编号是当初搬文件时按名字错配上去的。文件名、时长、体量、码率
   * **全都看不出这件事**。这个验证动作本来就该在卡片上做得了。
   */
  describe('试听：直接听这份网盘文件的内容', () => {
    // jsdom 没实现 <audio> 的播放（裸调 play() 会 "Not implemented"）——桩掉，只看有没有被调到。
    let played: HTMLMediaElement[]
    let paused: HTMLMediaElement[]
    beforeEach(() => {
      played = []
      paused = []
      vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
        played.push(this)
        return Promise.resolve()
      })
      vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLMediaElement) {
        paused.push(this)
      })
    })
    afterEach(() => vi.restoreAllMocks())

    const srcOf = (path: string) => `/api/netdisk/raw?path=${encodeURIComponent(path)}`

    it('点一下就播，取的是这份文件自己的路径', () => {
      const { container } = render(<ActionCard row={rowOf(fromFile)} />)
      fireEvent.click(screen.getByTestId('action-play'))
      expect(played).toHaveLength(1)
      expect(container.querySelector('audio')?.getAttribute('src')).toBe(srcOf('/src/37.申与酉.mp3'))
    })

    it('再点一下暂停（同一个按钮，状态跟着翻）', () => {
      render(<ActionCard row={rowOf(fromFile)} />)
      const btn = screen.getByTestId('action-play')
      expect(btn.getAttribute('data-playing')).toBe('false')
      fireEvent.click(btn)
      expect(btn.getAttribute('data-playing')).toBe('true')
      fireEvent.click(btn)
      expect(paused).toHaveLength(1)
      expect(btn.getAttribute('data-playing')).toBe('false')
    })

    // 一屏摞着五六张卡，两个音频叠着响就什么都听不出来了——而"听"正是这个按钮存在的全部理由。
    it('播第二张 → 第一张停', () => {
      const other: ReconcilePlanAction = {
        ...fromFile, key: 'k9',
        src: { path: '/src/38.另一份.mp3', name: '38.另一份.mp3', size: 100, durationS: 3000 },
      }
      render(
        <div>
          <ActionCard row={rowOf(fromFile)} />
          <ActionCard row={rowOf(other)} />
        </div>,
      )
      const [first, second] = screen.getAllByTestId('action-play')
      fireEvent.click(first)
      fireEvent.click(second)
      expect(played).toHaveLength(2)
      expect(first.getAttribute('data-playing')).toBe('false')
      expect(second.getAttribute('data-playing')).toBe('true')
      // 停的必须是第一张那个音频元素本身，不是"状态翻了但声音还在响"。
      expect(paused.map((el) => el.getAttribute('src'))).toEqual([srcOf('/src/37.申与酉.mp3')])
    })

    /**
     * **只对音频出这个按钮**。`<audio>` 只保证放得了音频容器：mkv 这类它压根解不了，
     * 给一个点下去必然失败的按钮比没有更糟（用户会以为是文件坏了）。视频那一侧的验证
     * 走播放器那条路，不是这里。
     */
    it('视频文件不出试听按钮（<audio> 放不了）', () => {
      const video: ReconcilePlanAction = {
        ...fromFile, key: 'k10',
        src: { path: '/lib/付费/S01E03.1080p.mkv', name: 'S01E03.1080p.mkv', size: 100, durationS: 2600 },
      }
      render(<ActionCard row={rowOf(video)} />)
      expect(screen.queryByTestId('action-play')).toBeNull()
    })
  })

  // 复制出去那段是拿来贴给人看/做诊断的，来路必须跟着走——界面上有、复制走没有就对不上了。
  it('复制文本的抬头带上来路', () => {
    expect(copyTextOf(rowOf(fromFile)).split('\n')[0]).toContain('从网盘文件出发')
    expect(copyTextOf(rowOf(claimed)).split('\n')[0]).toContain('从清单出发')
    const { origin: _drop, ...legacy } = claimed
    expect(copyTextOf(rowOf(legacy)).split('\n')[0]).not.toContain('出发')
  })
})
