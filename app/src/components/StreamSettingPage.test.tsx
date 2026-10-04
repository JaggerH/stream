import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { StreamSettingPage } from './StreamSettingPage.tsx'
import type { ChannelStream } from '../lib/types.ts'

const fetchMock = vi.hoisted(() => vi.fn())

const base: ChannelStream = {
  id: 's1', description: '怡乐播客', sources: [], cadence_seconds: 1800, vault_subdir: 'v', strategy: 'fanout',
}

function renderSheet(stream: ChannelStream) {
  return render(
    <StreamSettingPage open onOpenChange={() => {}} conn={{ baseUrl: '' }} channelId="c1" stream={stream} />,
  )
}

describe('StreamSettingPage · 更多设置 (harvest)', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    fetchMock.mockImplementation((url: string) => {
      const u = String(url)
      if (u.includes('/api/netdisk/mappings')) {
        return Promise.resolve({ ok: true, json: async () => [] })
      }
      return Promise.resolve({ ok: true, json: async () => ({ ok: true }) })
    })
    vi.stubGlobal('fetch', fetchMock)
  })

  it('collapses 更多设置 when harvest is the default (1000/50)', () => {
    renderSheet({ ...base, harvest: { backfillLimit: 1000, incrementalLimit: 50 } })
    expect(screen.getByText(/更多设置/)).toBeTruthy()
    // collapsed → the depth fields are not mounted
    expect(screen.queryByLabelText('回填深度')).toBeNull()
  })

  it('auto-expands when harvest is non-default (so the user sees it)', () => {
    renderSheet({ ...base, harvest: { backfillLimit: 2000, incrementalLimit: 100 } })
    expect(screen.getByLabelText('回填深度')).toBeTruthy()
    expect((screen.getByLabelText('增量条数') as HTMLInputElement).value).toBe('100')
  })

  it('unset harvest is treated as default (collapsed)', () => {
    renderSheet(base)
    expect(screen.queryByLabelText('回填深度')).toBeNull()
  })

  it('saves options.harvest via PATCH /api/streams/:id', async () => {
    renderSheet({ ...base, harvest: { backfillLimit: 2000, incrementalLimit: 100 } })
    fireEvent.change(screen.getByLabelText('回填深度'), { target: { value: '500' } })
    fireEvent.click(screen.getByText('保存并返回'))
    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        ([u, i]) => String(u).includes('/api/streams/s1') && (i as RequestInit)?.method === 'PATCH',
      )
      expect(patch).toBeTruthy()
      expect(JSON.parse(String((patch![1] as RequestInit).body)).options.harvest).toEqual({ backfillLimit: 500, incrementalLimit: 100 })
    })
  })
})
