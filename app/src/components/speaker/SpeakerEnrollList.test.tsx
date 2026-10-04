import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { SpeakerEnrollList } from './SpeakerEnrollList.tsx'

const listClusters = vi.fn()
const listPersons = vi.fn()
const enroll = vi.fn()
const recluster = vi.fn()
vi.mock('../../lib/api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api.ts')>()
  return {
    ...actual,
    api: { ...actual.api, voiceprint: {
      listClusters: (...a: unknown[]) => listClusters(...a),
      listPersons: (...a: unknown[]) => listPersons(...a),
      enroll: (...a: unknown[]) => enroll(...a),
      recluster: (...a: unknown[]) => recluster(...a),
      createPerson: vi.fn(),
      rejectPending: vi.fn(),
    } },
  }
})

beforeEach(() => {
  listClusters.mockResolvedValue([{ cluster: 'SPEAKER_00', seconds: 42, sampleAt: 3 }])
  listPersons.mockResolvedValue([{ id: 'p1', name: '张三' }])
  enroll.mockResolvedValue({ ok: true })
  recluster.mockResolvedValue({ status: 'queued' })
})

describe('SpeakerEnrollList', () => {
  it('列出簇，认成某人时调 enroll', async () => {
    render(<SpeakerEnrollList itemId="i1" />)
    expect(await screen.findByText('SPEAKER_00')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('认成'))
    fireEvent.click(await screen.findByText('张三'))
    await waitFor(() => expect(enroll).toHaveBeenCalledWith(expect.anything(), 'i1', 'SPEAKER_00', 'p1'))
  })

  // 「转写完成了、但没有说话人标签」在音频这条路上一度无解（旧转成文字面板被删，recluster 只剩
  // 影视频道那个视频消费者）。簇为空时必须画出这个入口，不能安静地什么都不显示。
  it('一个簇都没有时给出「补说话人」入口，点它排队 recluster', async () => {
    listClusters.mockResolvedValue([])
    render(<SpeakerEnrollList itemId="i1" />)
    fireEvent.click(await screen.findByText('补说话人'))
    await waitFor(() => expect(recluster).toHaveBeenCalledWith(expect.anything(), 'i1'))
    // 排队之后进等待态：分钟级后台活，唯一的完成信号是簇长出来。
    expect(await screen.findByText('识别发言人中…')).toBeTruthy()
  })

  it('有簇时不出现「补说话人」——已经有说话人了，没什么可补', async () => {
    render(<SpeakerEnrollList itemId="i1" />)
    expect(await screen.findByText('SPEAKER_00')).toBeTruthy()
    expect(screen.queryByText('补说话人')).toBeNull()
  })
})
