import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { HarvestStreamPane } from './HarvestLivePanel.tsx'
import type { Item } from '../lib/types.ts'

const galleryItem = (id: string, title: string, author: string): Item => ({
  id, stream_id: '', type: 'post', title, author, timestamp: '', fetched_at: '',
  content: { archetype: 'gallery', title, media: [{ kind: 'image', url: `http://cdn/${id}.jpg` }] },
})

describe('HarvestStreamPane', () => {
  it('renders streamed cards (title + author) with a running count', () => {
    const { container } = render(<HarvestStreamPane done={false} items={[galleryItem('n1', '露营', 'Iris'), galleryItem('n2', '徒步', 'Milk')]} />)
    expect(screen.getByText('露营')).toBeTruthy()
    expect(screen.getByText('徒步')).toBeTruthy()
    expect(screen.getByText('Iris')).toBeTruthy()
    expect(container.textContent).toContain('实时采集 · 2 条')
  })

  it('badges a video note with a play affordance', () => {
    const video: Item = {
      id: 'v1', stream_id: '', type: 'post', title: '婚礼旅拍', author: 'A', timestamp: '', fetched_at: '',
      content: { archetype: 'video', title: '婚礼旅拍', media: [{ kind: 'video', provider: 'xiaohongshu', poster: 'http://cdn/v1.jpg' }] },
    }
    render(<HarvestStreamPane done={false} items={[video]} />)
    expect(screen.getByLabelText('视频')).toBeTruthy()
  })

  it('shows the done state and a placeholder when empty', () => {
    const { container, rerender } = render(<HarvestStreamPane done={false} items={[]} />)
    expect(container.textContent).toContain('等待抓取…')
    rerender(<HarvestStreamPane done={true} items={[galleryItem('n1', '露营', 'Iris')]} />)
    expect(container.textContent).toContain('采集完成')
  })
})
