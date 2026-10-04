import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SpeakerSegmentPanel } from './MovieChannel.tsx'
import { ApiError } from '../lib/api.ts'
import type { SpeakerMap } from '../hooks/useSpeakerMap.ts'

// 待确认的抽名(「大家好我叫多多」抽到名字、演职员表查无此人)必须出现在**影视频道**这块面板上,
// 而不只是音频侧的转成文字视图——用户看这一集说话人时人在这里。曾经只接了音频侧,
// 影视侧连 pending 字段都没读,一集有两条待确认也只显示「说话人 1 / 说话人 2」,无从认起。

const listPersons = vi.fn()
const createPerson = vi.fn()
const enroll = vi.fn()
const rejectPending = vi.fn()
const recluster = vi.fn()
const latestConversion = vi.fn()
const toastInfo = vi.fn()
const toastError = vi.fn()

vi.mock('../lib/api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api.ts')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      conversions: { ...actual.api.conversions, latest: (...a: unknown[]) => latestConversion(...a) },
      voiceprint: {
        ...actual.api.voiceprint,
        listPersons: (...a: unknown[]) => listPersons(...a),
        createPerson: (...a: unknown[]) => createPerson(...a),
        enroll: (...a: unknown[]) => enroll(...a),
        rejectPending: (...a: unknown[]) => rejectPending(...a),
        recluster: (...a: unknown[]) => recluster(...a),
      },
    },
  }
})

// toast 要探到「409 走的是 info 不是 error」——那是这条改动的判据之一，不能只看没抛异常。
vi.mock('./acrylic/sonner.tsx', () => ({
  toast: { success: vi.fn(), error: (...a: unknown[]) => toastError(...a), info: (...a: unknown[]) => toastInfo(...a) },
  Toaster: () => null,
}))

const ITEM = 'tmdb:261391:S03E02'

function speakerMap(overrides: Partial<SpeakerMap> = {}): SpeakerMap {
  const blocks = [{ start: 11.46, end: 419.73, label: 'SPEAKER_03' }]
  return {
    blocks,
    people: [{ label: 'SPEAKER_03', seconds: 408, blocks }],
    activeSpeakers: null,
    toggleSpeaker: vi.fn(),
    soloSpeaker: vi.fn(),
    refresh: vi.fn(),
    names: { SPEAKER_03: '说话人 1' },
    unnamed: new Set(['SPEAKER_03']),
    pending: { SPEAKER_03: { name: '多多', evidence: '大家好我叫多多 现在是在上海读研究生三年级' } },
    ...overrides,
  }
}

function renderPanel(map: SpeakerMap, onSeek: (s: number) => void = vi.fn()) {
  return render(
    <SpeakerSegmentPanel itemId={ITEM} map={map} onSeek={onSeek} currentTime={0} duration={3600} />
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  listPersons.mockResolvedValue([])
  createPerson.mockResolvedValue({ id: 'p1', name: '多多' })
  enroll.mockResolvedValue({ ok: true })
  rejectPending.mockResolvedValue(undefined)
  recluster.mockResolvedValue({ status: 'queued' })
  latestConversion.mockResolvedValue(null) // 缺省：本集没有识别任务在跑
})

describe('SpeakerSegmentPanel — 待确认的抽名', () => {
  it('把抽到的名字和证据显示在那个簇的行上', async () => {
    renderPanel(speakerMap())
    expect(await screen.findByText('多多')).toBeTruthy() // 名字单独一个 span（证据句在同一段里跟着）
    expect(screen.getByText(/上海读研究生三年级/)).toBeTruthy()
  })

  it('「认」= 新建同名人物再绑这个簇,并让说话人图重读(标签会被改名)', async () => {
    const map = speakerMap()
    renderPanel(map)
    fireEvent.click(await screen.findByRole('button', { name: '认' }))
    await waitFor(() => expect(createPerson).toHaveBeenCalledWith(expect.anything(), '多多'))
    await waitFor(() => expect(enroll).toHaveBeenCalledWith(expect.anything(), ITEM, 'SPEAKER_03', 'p1'))
    await waitFor(() => expect(map.refresh).toHaveBeenCalled())
  })

  it('「不认」= 否决这条待确认,同名同作品不再问', async () => {
    const map = speakerMap()
    renderPanel(map)
    fireEvent.click(await screen.findByRole('button', { name: '不认' }))
    await waitFor(() => expect(rejectPending).toHaveBeenCalledWith(expect.anything(), ITEM, 'SPEAKER_03'))
    await waitFor(() => expect(map.refresh).toHaveBeenCalled())
    expect(enroll).not.toHaveBeenCalled()
  })

  it('没有整段可跳的人(发言零碎)照样在名单里,但「只看」是禁用的', async () => {
    const map = speakerMap({
      people: [{ label: 'SPEAKER_17', seconds: 310, blocks: [] }], // 310s 说满,但没有一个够长的块
      names: { SPEAKER_17: '说话人 1' },
      unnamed: new Set(['SPEAKER_17']),
      pending: {},
    })
    renderPanel(map)
    expect(await screen.findByText('说话人 1')).toBeTruthy()
    expect(screen.getByRole('button', { name: '只看' }).hasAttribute('disabled')).toBe(true)
    // 这一行的时间轴是空的（没有够长的连续块可画）。空着不解释，用户看到的就是一行莫名其妙的
    // 空白——必须当场说明为什么空，理由跟「只看」被禁用是同一个。
    expect(screen.getByText(/发言零碎/)).toBeTruthy()
  })

  // 一段可以长达七分钟（这里的 fixture 就是 11.46→419.73）。只跳段首 = 只能验这段的开头,
  // 而「这段切得连不连贯」要听两头。所以长段左右各是一个热区。
  it('长发言段给两个落点:左半段首,右半段尾(带提前量,听得到收尾)', async () => {
    const onSeek = vi.fn()
    renderPanel(speakerMap(), onSeek)

    fireEvent.click(await screen.findByRole('button', { name: '跳到这段开头 0:11' }))
    expect(onSeek).toHaveBeenLastCalledWith(11.46)

    fireEvent.click(screen.getByRole('button', { name: '跳到这段结尾 6:59' }))
    // 不是 419.73 本身:落在 end 上只听得到静音或下一个人,恰恰验不了这段的收尾。
    expect(onSeek).toHaveBeenLastCalledWith(419.73 - 4)
  })

  it('短段只给一个落点:整段从头听就听完了,分半只会挤出两个点不准的热区', async () => {
    const blocks = [{ start: 30, end: 35, label: 'SPEAKER_03' }]
    const onSeek = vi.fn()
    renderPanel(speakerMap({ blocks, people: [{ label: 'SPEAKER_03', seconds: 5, blocks }] }), onSeek)
    fireEvent.click(await screen.findByRole('button', { name: '跳到 0:30' }))
    expect(onSeek).toHaveBeenCalledWith(30)
    expect(screen.queryByRole('button', { name: /这段结尾/ })).toBeNull()
  })

  it('没有待确认时不出认/不认,只留原来的「认成…」', async () => {
    renderPanel(speakerMap({ pending: {} }))
    expect(await screen.findByRole('button', { name: /认成/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '认' })).toBeNull()
    expect(screen.queryByRole('button', { name: '不认' })).toBeNull()
  })
})

// 识别过一次之后也要能再跑（改了阈值/门控/换了模型、或这一集就是分得不对）。原来入口只长在
// 「还没识别过」那个空状态里，跑过一次就再也点不到,只能让人去手敲 POST /clusters。
describe('SpeakerSegmentPanel — 重新识别入口', () => {
  it('已经识别过（有人）时，头部给「重新识别」，确认后才真跑', async () => {
    renderPanel(speakerMap())
    fireEvent.click(await screen.findByRole('button', { name: '重新识别' }))
    // 确认框没点之前不许发请求——这一跑要几分钟且把本集的簇整份替换掉
    expect(recluster).not.toHaveBeenCalled()
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.textContent).toContain('整份替换')
    fireEvent.click(within(dialog).getByRole('button', { name: '重新识别' }))
    await waitFor(() => expect(recluster).toHaveBeenCalledWith(expect.anything(), ITEM))
  })

  it('还没识别过（空）时不显示头部那个入口——空状态自己有按钮，两个入口会打架', async () => {
    renderPanel(speakerMap({ people: [], blocks: [], pending: {} }))
    expect(await screen.findByRole('button', { name: '识别本集说话人' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '重新识别' })).toBeNull()
  })

  it('后端说 409（已有任务在跑）不算失败：不弹错误，改成「已有任务」并接着轮', async () => {
    recluster.mockRejectedValueOnce(new ApiError('a job for this item is already queued or running', 409, 'conflict'))
    renderPanel(speakerMap())
    fireEvent.click(await screen.findByRole('button', { name: '重新识别' }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: '重新识别' }))
    await waitFor(() => expect(recluster).toHaveBeenCalled())
    await waitFor(() => expect(toastInfo).toHaveBeenCalled())
    expect(toastError).not.toHaveBeenCalled()
  })
})
