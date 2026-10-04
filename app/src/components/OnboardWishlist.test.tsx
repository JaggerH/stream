import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { OnboardWishlist } from './OnboardWishlist.tsx'

const conn = { baseUrl: 'http://x' }

describe('OnboardWishlist', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn(async (_url: unknown, init?: { method?: string }) => {
      if (init?.method === 'DELETE') return new Response(JSON.stringify({ ok: true }), { status: 200 })
      return new Response(
        JSON.stringify({
          entries: [
            { id: 'wl_1', url: 'https://blog.example', goal: '想追这个博客', at: '2026-08-13T00:00:00.000Z' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }) as unknown as typeof fetch
  })

  it('列出条目：显示当时在找什么 + 地址', async () => {
    render(<OnboardWishlist conn={conn} />)
    expect(await screen.findByText('想追这个博客')).toBeTruthy()
    expect(screen.getByText('https://blog.example')).toBeTruthy()
  })

  it('空清单时整块不画（没接不上的站就不该占位置）', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ entries: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    ) as unknown as typeof fetch
    const { container } = render(<OnboardWishlist conn={conn} />)
    await waitFor(() => expect(container.textContent).toBe(''))
  })

  it('删一条之后它从列表里消失', async () => {
    render(<OnboardWishlist conn={conn} />)
    fireEvent.click(await screen.findByLabelText('删掉这条'))
    await waitFor(() => expect(screen.queryByText('想追这个博客')).toBeNull())
  })

  it('DELETE 失败时条目保留在列表里（UI 不能骗用户）', async () => {
    globalThis.fetch = vi.fn(async (_url: unknown, init?: { method?: string }) => {
      if (init?.method === 'DELETE') return new Response(JSON.stringify({ error: 'boom' }), { status: 500 })
      return new Response(
        JSON.stringify({
          entries: [
            { id: 'wl_1', url: 'https://blog.example', goal: '想追这个博客', at: '2026-08-13T00:00:00.000Z' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }) as unknown as typeof fetch
    render(<OnboardWishlist conn={conn} />)
    fireEvent.click(await screen.findByLabelText('删掉这条'))
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled())
    // 给失败分支留出处理时间，再确认条目仍在
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.getByText('想追这个博客')).toBeTruthy()
  })
})
