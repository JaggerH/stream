import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NetdiskAdvice } from './NetdiskAdvice.tsx'
import type { AuthorityStats } from '../../lib/types.ts'

const fetchMock = vi.hoisted(() => vi.fn())

const stats = (o: Partial<AuthorityStats>): AuthorityStats => ({ entries: 0, paid: 0, withDuration: 0, needsSupply: 0, ...o })

function mockAuthority(res: { ok?: boolean; status?: number; stats?: AuthorityStats }) {
  fetchMock.mockImplementation((url: string) => {
    expect(String(url)).toContain('/api/netdisk/reconcile/streams/')
    return Promise.resolve({
      ok: res.ok ?? true,
      status: res.status ?? 200,
      json: async () => (res.ok === false ? { error: { code: 'not_configured', message: 'x' } } : { stats: res.stats }),
    })
  })
}

describe('NetdiskAdvice — 网盘入口最上面那句「你该用哪个」', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  // 怡楽那种：源站列着一堆放不出来的集 → 网盘那份是来补它们的，走整理。
  it('有集源站放不出来 → 指向「整理」，并报出集数', async () => {
    mockAuthority({ stats: stats({ entries: 240, needsSupply: 40, paid: 38 }) })
    render(<NetdiskAdvice streamId="lizhi-yile" />)
    const box = await screen.findByTestId('netdisk-advice')
    expect(box.textContent).toContain('40')
    expect(box.textContent).toContain('240')
    expect(box.textContent).toContain('整理')
    expect(box.textContent).not.toContain('添加来源')
  })

  // 凹凸电波那种：735 集一集不缺 → 网盘目录里的是另一批节目，该去「添加来源」把那个目录当成
  // 一条来源加进来。指错门会让人白配一轮绑定。
  it('一集都不缺 → 指向「添加来源」，不提整理', async () => {
    mockAuthority({ stats: stats({ entries: 735, needsSupply: 0 }) })
    render(<NetdiskAdvice streamId="lizhi-aotu" />)
    const box = await screen.findByTestId('netdisk-advice')
    expect(box.textContent).toContain('735')
    expect(box.textContent).toContain('添加来源')
    expect(box.textContent).not.toContain('用频道菜单里的「整理」')
  })

  // 判不了就闭嘴：库里一条都没有时给建议纯属瞎猜（空流会被算成 needsSupply=0 → 误指另一扇门）。
  it('这条流库里没条目 → 什么都不显示', async () => {
    mockAuthority({ stats: stats({ entries: 0 }) })
    render(<NetdiskAdvice streamId="s-空" />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(screen.queryByTestId('netdisk-advice')).toBeNull()
  })

  // netdisk 整体没启用 → 503。这时候整个网盘抽屉都是空的，这句更不该冒出来。
  it('后端 503 → 什么都不显示，不报错', async () => {
    mockAuthority({ ok: false, status: 503 })
    render(<NetdiskAdvice streamId="s1" />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(screen.queryByTestId('netdisk-advice')).toBeNull()
  })

  // 换一条订阅要重问：留着上一条的答案 = 拿别人的节目单指路。
  it('换 streamId → 重新取数，且先清掉上一条的结论', async () => {
    mockAuthority({ stats: stats({ entries: 240, needsSupply: 40 }) })
    const { rerender } = render(<NetdiskAdvice streamId="s1" />)
    await screen.findByTestId('netdisk-advice')
    mockAuthority({ stats: stats({ entries: 735, needsSupply: 0 }) })
    rerender(<NetdiskAdvice streamId="s2" />)
    await waitFor(() => expect(screen.getByTestId('netdisk-advice').textContent).toContain('735'))
  })
})
