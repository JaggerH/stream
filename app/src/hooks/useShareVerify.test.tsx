import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { api, type Connection } from '../lib/api.ts'
import { useShareVerify } from './useShareVerify.ts'

const conn = { baseUrl: 'http://x', token: '' } as Connection
const quark = (link: string) => ({ link, sourceType: 'quark' as const })
const alive = (name: string) => ({ validity: 'alive', files: [{ name, is_dir: false, size: 1 }] })

describe('useShareVerify', () => {
  /** 结果是流式到达的：每来一批，links 就换新身份、effect 重跑。前一次 effect 的 cleanup
   *  绝不能把还在飞的探测作废 —— 它们已被记进 started，作废就等于永远停在 checking。 */
  it('新批次到达不作废在飞的探测（否则早批次永久卡在 checking）', async () => {
    let releaseA: () => void = () => {}
    const aInFlight = new Promise<void>((r) => { releaseA = () => r() })

    vi.spyOn(api.netdisk, 'verifyShare').mockImplementation(async (_c, ref) => {
      const { link } = ref as { link: string }
      if (link === 'A') await aInFlight
      return alive(`${link}.mkv`) as never
    })

    const { result, rerender } = renderHook(({ links }) => useShareVerify(conn, links), {
      initialProps: { links: [quark('A')] },
    })
    await waitFor(() => expect(result.current['A']?.kind).toBe('checking'))

    // 下一批结果到达，A 的探测还在飞
    rerender({ links: [quark('A'), quark('B')] })
    await waitFor(() => expect(result.current['B']?.kind).toBe('alive'))

    releaseA()
    await waitFor(() => expect(result.current['A']).toEqual({ kind: 'alive', files: ['A.mkv'] }))
  })

  it('每条只验一次：重跑不会把看过的重探', async () => {
    const spy = vi.spyOn(api.netdisk, 'verifyShare').mockImplementation(async (_c, ref) =>
      alive(`${(ref as { link: string }).link}.mkv`) as never,
    )

    const { result, rerender } = renderHook(({ links }) => useShareVerify(conn, links), {
      initialProps: { links: [quark('A')] },
    })
    await waitFor(() => expect(result.current['A']?.kind).toBe('alive'))

    rerender({ links: [quark('A'), quark('B')] })
    await waitFor(() => expect(result.current['B']?.kind).toBe('alive'))

    expect(spy.mock.calls.map((c) => (c[1] as { link: string }).link).sort()).toEqual(['A', 'B'])
  })

  // 后端说「我没查成」时,绝不能翻译成「链接死了」——死链会被隐藏,活链就此消失。
  it('后端 unknown 不翻译成 dead', async () => {
    vi.spyOn(api.netdisk, 'verifyShare').mockResolvedValue({ validity: 'unknown', files: [] } as never)
    const { result } = renderHook(() => useShareVerify(conn, [quark('A')]))
    await waitFor(() => expect(result.current['A']).toEqual({ kind: 'unknown' }))
  })

  it('卸载后不再写 state', async () => {
    let release: () => void = () => {}
    const inFlight = new Promise<void>((r) => { release = () => r() })
    vi.spyOn(api.netdisk, 'verifyShare').mockImplementation(async () => {
      await inFlight
      return alive('x.mkv') as never
    })

    const { result, unmount } = renderHook(() => useShareVerify(conn, [quark('A')]))
    await waitFor(() => expect(result.current['A']?.kind).toBe('checking'))

    unmount()
    release()
    // 没有 "state update on unmounted component" 报错即可
    await new Promise((r) => setTimeout(r, 20))
  })
})
