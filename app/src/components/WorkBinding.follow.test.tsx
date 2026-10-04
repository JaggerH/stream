import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkBinding } from './WorkBinding.tsx'
import type { WorkBindingView, FollowView } from '../lib/types.ts'
import type { Connection } from '../lib/api.ts'

const followGet = vi.fn()
const followSet = vi.fn()
const followRun = vi.fn()
const followCreate = vi.fn()
const rebind = vi.fn()
const create = vi.fn()
const undoRun = vi.fn()
vi.mock('../lib/api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api.ts')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      netdisk: {
        ...actual.api.netdisk,
        follow: {
          get: (...a: unknown[]) => followGet(...a),
          set: (...a: unknown[]) => followSet(...a),
          run: (...a: unknown[]) => followRun(...a),
          create: (...a: unknown[]) => followCreate(...a),
        },
        rebind: (...a: unknown[]) => rebind(...a),
        create: (...a: unknown[]) => create(...a),
      },
      reconcile: {
        ...actual.api.reconcile,
        undoRun: (...a: unknown[]) => undoRun(...a),
      },
    },
  }
})

const conn: Connection = { baseUrl: 'http://x' } as Connection

const followView: FollowView = {
  follow: { enabled: true, dryRuns: 2, lastCheckAt: '2026-08-01T00:00:00Z' },
  missingAired: ['s01e03', 's01e04'],
  upcoming: 1,
  shares: [
    { pwdId: 'p1', netdisk: 'quark', origin: 'manual', validity: 'alive' },
    { pwdId: 'p2', netdisk: 'quark', origin: 'search', validity: 'not-usable' },
  ],
  runs: [
    {
      id: 'r1', setId: 'map_1', at: '2026-08-01T00:00:00Z', trigger: 'scheduled',
      missingAired: ['s01e03'],
      revisited: [],
      saved: [{ pwdId: 'p1', files: ['03.mp4'] }],
      synced: { matchedBefore: 2, matchedAfter: 3 },
      errors: [],
    },
  ],
}

const boundTvWork: WorkBindingView = {
  ref: { id: 'tv1', media: 'tv', title: '三体' },
  binding: {
    id: 'map_1', dirPath: '/夸克/三体', total: 4, matched: 2, unaired: 0, playable: [],
    follow: { enabled: true, dryRuns: 2, lastCheckAt: '2026-08-01T00:00:00Z' },
  },
}

const unboundTvWork: WorkBindingView = {
  ref: { id: 'tv2', media: 'tv', title: '流浪地球番外' },
}

const followViewArchived: FollowView = {
  ...followView,
  runs: [{
    ...followView.runs[0],
    archived: { runId: 'run_1', moved: 3, deleted: 1, renamed: 2 },
  }],
}

beforeEach(() => {
  followGet.mockReset().mockResolvedValue(followView)
  followSet.mockReset().mockResolvedValue({})
  followRun.mockReset().mockResolvedValue(followView.runs[0])
  followCreate.mockReset().mockResolvedValue({})
  undoRun.mockReset().mockResolvedValue({ undone: 5, skipped: 1 })
})

describe('WorkBinding — 追更状态行', () => {
  it('已绑 tv + follow.enabled → 渲染开关与「现在就找」，展示缺集数', async () => {
    render(<WorkBinding conn={conn} work={boundTvWork} onChanged={vi.fn()} />)
    await waitFor(() => expect(followGet).toHaveBeenCalledWith(conn, 'map_1'))
    expect(await screen.findByText('追更')).toBeTruthy()
    expect(screen.getByText('缺 2 集（已播 2 · 待播 1）')).toBeTruthy()
    expect(screen.getByText('现在就找')).toBeTruthy()
  })

  it('点「现在就找」调 api.netdisk.follow.run 并提示', async () => {
    const onChanged = vi.fn()
    render(<WorkBinding conn={conn} work={boundTvWork} onChanged={onChanged} />)
    await screen.findByText('现在就找')
    fireEvent.click(screen.getByText('现在就找'))
    await waitFor(() => expect(followRun).toHaveBeenCalledWith(conn, 'map_1'))
  })

  it('点开关调 api.netdisk.follow.set', async () => {
    render(<WorkBinding conn={conn} work={boundTvWork} onChanged={vi.fn()} />)
    await screen.findByText('追更')
    fireEvent.click(screen.getByLabelText('追更'))
    await waitFor(() => expect(followSet).toHaveBeenCalledWith(conn, 'map_1', false))
  })

  it('未绑但 ref.media === "tv" → 「追这部」按钮调 follow.create', async () => {
    const onChanged = vi.fn()
    render(<WorkBinding conn={conn} work={unboundTvWork} onChanged={onChanged} />)
    fireEvent.click(await screen.findByText('追这部'))
    await waitFor(() =>
      expect(followCreate).toHaveBeenCalledWith(conn, { id: 'tv2', media: 'tv', title: '流浪地球番外' }),
    )
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })

  it('最近一轮带 archived → 渲染「上轮归档」与撤销按钮，点击调 api.reconcile.undoRun', async () => {
    followGet.mockReset().mockResolvedValue(followViewArchived)
    const onChanged = vi.fn()
    render(<WorkBinding conn={conn} work={boundTvWork} onChanged={onChanged} />)
    expect(await screen.findByText('上轮归档：搬 3 · 删 1 · 改名 2')).toBeTruthy()
    fireEvent.click(screen.getByText('撤销这一轮'))
    await waitFor(() => expect(undoRun).toHaveBeenCalledWith(conn, 'run_1'))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })
})
