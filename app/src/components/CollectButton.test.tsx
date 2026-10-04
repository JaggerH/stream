import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { CollectButton } from './CollectButton.tsx'

const collectionsMock = vi.hoisted(() => vi.fn())
const whereCollectedMock = vi.hoisted(() => vi.fn())
const addToCollectionMock = vi.hoisted(() => vi.fn())
const removeFromCollectionMock = vi.hoisted(() => vi.fn())
const createCollectionMock = vi.hoisted(() => vi.fn())

vi.mock('../lib/api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api.ts')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      collections: collectionsMock,
      whereCollected: whereCollectedMock,
      addToCollection: addToCollectionMock,
      removeFromCollection: removeFromCollectionMock,
      createCollection: createCollectionMock,
    },
  }
})

const conn = { baseUrl: 'http://api' }
const itemKey = { kind: 'tmdb' as const, id: '1368337', media: 'movie' as const }
const meta = { title: '奥德赛', poster: '/o.jpg' }

describe('CollectButton', () => {
  beforeEach(() => {
    collectionsMock.mockReset().mockResolvedValue([
      { id: 'col_video_following', domain: 'video', label: '正在追的', system: 'following', itemCount: 3, createdAt: 't', updatedAt: 't' },
      { id: 'col_abc123', domain: 'video', label: '想看', itemCount: 1, createdAt: 't', updatedAt: 't' },
    ])
    whereCollectedMock.mockReset().mockResolvedValue({ item: null, collectionIds: [] })
    addToCollectionMock.mockReset().mockResolvedValue({})
    removeFromCollectionMock.mockReset().mockResolvedValue({ ok: true })
    createCollectionMock.mockReset().mockResolvedValue({ id: 'col_new', domain: 'video', label: '经典', itemCount: 0, createdAt: 't', updatedAt: 't' })
  })

  it('shows 收藏 (not collected) until the popover reports membership', async () => {
    render(<CollectButton conn={conn} domain="video" itemKey={itemKey} meta={meta} />)
    expect(screen.getByRole('button', { name: '收藏' })).toBeTruthy()
  })

  it('opening the popover lists the domain\'s collections and fetches current membership', async () => {
    whereCollectedMock.mockResolvedValue({ item: null, collectionIds: ['col_video_following'] })
    render(<CollectButton conn={conn} domain="audio" itemKey={itemKey} meta={meta} />)

    fireEvent.click(screen.getByRole('button', { name: '收藏' }))
    await waitFor(() => expect(collectionsMock).toHaveBeenCalledWith(conn, 'audio'))
    expect(whereCollectedMock).toHaveBeenCalledWith(conn, itemKey)

    expect(await screen.findByText('正在追的')).toBeTruthy()
    expect(screen.getByText('想看')).toBeTruthy()
  })

  it('clicking an un-checked list adds the item and flips the trigger to 已收藏', async () => {
    render(<CollectButton conn={conn} domain="audio" itemKey={itemKey} meta={meta} />)
    fireEvent.click(screen.getByRole('button', { name: '收藏' }))
    fireEvent.click(await screen.findByText('想看'))

    await waitFor(() => expect(addToCollectionMock).toHaveBeenCalledWith(conn, 'col_abc123', itemKey, meta))
    expect(await screen.findByRole('button', { name: '已收藏' })).toBeTruthy()
  })

  it('clicking an already-checked list removes the item', async () => {
    whereCollectedMock.mockResolvedValue({ item: null, collectionIds: ['col_video_following'] })
    render(<CollectButton conn={conn} domain="audio" itemKey={itemKey} meta={meta} />)
    fireEvent.click(screen.getByRole('button', { name: '收藏' }))
    await screen.findByText('正在追的')
    fireEvent.click(screen.getByText('正在追的'))

    await waitFor(() => expect(removeFromCollectionMock).toHaveBeenCalledWith(conn, 'col_video_following', itemKey))
  })

  it('creating a new list adds it to the panel and collects the current item into it', async () => {
    render(<CollectButton conn={conn} domain="audio" itemKey={itemKey} meta={meta} />)
    fireEvent.click(screen.getByRole('button', { name: '收藏' }))
    await screen.findByText('正在追的')

    const input = screen.getByPlaceholderText('新建列表…')
    fireEvent.change(input, { target: { value: '经典' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(createCollectionMock).toHaveBeenCalledWith(conn, 'audio', '经典'))
    await waitFor(() => expect(addToCollectionMock).toHaveBeenCalledWith(conn, 'col_new', itemKey, meta))
    expect(await screen.findByText('经典')).toBeTruthy()
  })

  it('icon variant renders a bare heart button (no visible label)', () => {
    render(<CollectButton conn={conn} domain="audio" itemKey={{ kind: 'track', platform: 'netease', trackId: '1' }} meta={{ title: 'Song' }} variant="icon" />)
    expect(screen.getByTitle('收藏')).toBeTruthy()
  })

  it('video domain hides the "new list" row and shows only system collections', async () => {
    render(<CollectButton conn={conn} domain="video" itemKey={itemKey} meta={meta} />)
    fireEvent.click(screen.getByRole('button', { name: '收藏' }))

    expect(await screen.findByText('正在追的')).toBeTruthy()
    expect(screen.queryByText('想看')).toBeNull()
    expect(screen.queryByPlaceholderText('新建列表…')).toBeNull()
  })
})
