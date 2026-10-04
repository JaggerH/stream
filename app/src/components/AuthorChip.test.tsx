import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { api, LOCAL } from '../lib/api.ts'
import { AuthorChip } from './AuthorChip.tsx'

describe('AuthorChip', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('照 author_enrich 现取，拿到 url 就画成链到主页的作者位（地址来自包，不是宿主拼的）', async () => {
    const spy = vi.spyOn(api, 'enrichAuthor').mockResolvedValue({ name: '某人', face: 'https://img/f.jpg', url: 'https://site.example/u/1' })
    render(<AuthorChip name="某人" enrich={{ source: 'demo-user', params: { name: '某人' } }} conn={LOCAL} />)
    expect(screen.getByText('某人')).toBeTruthy()
    await waitFor(() => expect(screen.getByRole('link').getAttribute('href')).toBe('https://site.example/u/1'))
    expect(spy).toHaveBeenCalledWith(LOCAL, 'demo-user', { name: '某人' })
  })

  it('现取失败 → 停在纯名字，不画链接', async () => {
    const spy = vi.spyOn(api, 'enrichAuthor').mockRejectedValue(new Error('400'))
    render(<AuthorChip name="某人" enrich={{ source: 'demo-user', params: { name: '某人' } }} conn={LOCAL} />)
    await waitFor(() => expect(spy).toHaveBeenCalled())
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByText('某人')).toBeTruthy()
  })
})
