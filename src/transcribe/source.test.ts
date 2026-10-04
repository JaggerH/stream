import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resolveAudioSource, netdiskKeyFor } from './source.ts'
import * as extractAudio from '../netdisk/extract-audio.ts'
import type { Media } from '../content/types.ts'

vi.mock('../netdisk/extract-audio.ts', () => ({ extractNetdiskAudio: vi.fn() }))

/** What an inbox item's media looks like IN STORAGE for a netdisk-bound episode: a poster, no
 *  playable url. The `/api/media/videos/resolve?id=…` url only ever exists in an HTTP response
 *  (serve-time projection, never persisted) — which is exactly why resolution can't depend on it. */
const storedNetdiskItemMedia: Media[] = [{ kind: 'video', poster: 'https://img/cover.jpg' }]

describe('netdiskKeyFor — a handle IS a netdisk leftKey', () => {
  it('passes a tmdb work/episode key through untouched', () => {
    expect(netdiskKeyFor('tmdb:296286:S01E01')).toBe('tmdb:296286:S01E01')
    expect(netdiskKeyFor('tmdb:1368337')).toBe('tmdb:1368337')
  })

  it('wraps a bare item id into the item: form the mapping store uses', () => {
    expect(netdiskKeyFor('7db591bd27a5daa1')).toBe('item:7db591bd27a5daa1')
  })
})

describe('resolveAudioSource — every entry reaches a netdisk-bound video, not just the UI', () => {
  const lookup = vi.fn()
  const getItem = vi.fn()
  const netdisk = { lookup, rawUrl: vi.fn() }
  const deps = { netdisk, getItem }

  beforeEach(() => {
    vi.mocked(extractAudio.extractNetdiskAudio).mockReset()
    lookup.mockReset()
    getItem.mockReset()
  })

  it('resolves a bare item id whose STORED media has no url (the MCP/plain-POST short circuit)', async () => {
    getItem.mockReturnValue({ content: { media: storedNetdiskItemMedia } })
    lookup.mockReturnValue({ dirPath: '/quark/show', rightFile: 'e1.mkv' })
    vi.mocked(extractAudio.extractNetdiskAudio).mockResolvedValue({ bytes: new Uint8Array([1]), mime: 'audio/aac' })

    const out = await resolveAudioSource('7db591bd27a5daa1', undefined, deps)

    expect(lookup).toHaveBeenCalledWith('item:7db591bd27a5daa1')
    expect(extractAudio.extractNetdiskAudio).toHaveBeenCalledWith(netdisk, '/quark/show/e1.mkv', expect.anything())
    expect(out).toEqual({ bytes: new Uint8Array([1]), mime: 'audio/aac' })
  })

  it('resolves a TMDb episode key — which is not an inbox item at all', async () => {
    lookup.mockReturnValue({ dirPath: '/quark/got', rightFile: 'S01E01.mkv' })
    vi.mocked(extractAudio.extractNetdiskAudio).mockResolvedValue({ bytes: new Uint8Array([2]), mime: 'audio/aac' })

    const out = await resolveAudioSource('tmdb:1399:S01E01', undefined, deps)

    expect(lookup).toHaveBeenCalledWith('tmdb:1399:S01E01')
    expect(getItem).not.toHaveBeenCalled() // no itemStore involvement — TMDb episodes have no item
    expect(out?.mime).toBe('audio/aac')
  })

  it('falls back to the stored item media when there is no netdisk binding', async () => {
    lookup.mockReturnValue(undefined)
    // a douyin video with neither page_url nor embed: resolveMediaBytes declines it without
    // touching the network, so this asserts the ROUTING (store consulted, media path entered)
    // rather than any proxy behaviour
    getItem.mockReturnValue({ content: { media: [{ kind: 'video', provider: 'douyin', page_url: 'https://evil.example/x' }] } })

    const out = await resolveAudioSource('some-item', undefined, deps)
    expect(getItem).toHaveBeenCalledWith('some-item')
    expect(out).toBeNull()
  })

  it('returns null for an unknown handle with nothing behind it', async () => {
    lookup.mockReturnValue(undefined)
    getItem.mockReturnValue(undefined)
    expect(await resolveAudioSource('nope', undefined, deps)).toBeNull()
  })

  it('prefers the caller-supplied media hint over a store lookup (the UI fast path)', async () => {
    lookup.mockReturnValue(undefined)
    const hint: Media[] = [{ kind: 'video', provider: 'douyin' }] // no page_url/embed → declines
    const out = await resolveAudioSource('some-item', hint, deps)
    expect(getItem).not.toHaveBeenCalled()
    expect(out).toBeNull()
  })

  it('returns null (never throws) when netdisk extraction blows up, but REPORTS the reason', async () => {
    lookup.mockReturnValue({ dirPath: '/quark/show', rightFile: 'e1.mkv' })
    vi.mocked(extractAudio.extractNetdiskAudio).mockRejectedValue(new Error('[extract] ffmpeg timed out after 900000ms'))
    getItem.mockReturnValue({ content: { media: storedNetdiskItemMedia } })
    const onError = vi.fn()

    await expect(resolveAudioSource('7db591bd27a5daa1', undefined, { ...deps, onError })).resolves.toBeNull()
    // a swallowed reason is how a timeout got reported to the user as "no transcribable media"
    expect(onError).toHaveBeenCalledWith('7db591bd27a5daa1', expect.objectContaining({ message: expect.stringContaining('timed out') }))
  })
})

/**
 * Fixture: the踩雷 scenario from docs/TODO.md (2026-07-24). A residual netdisk binding whose
 * directory is gone (AList `failed get dir: object not found`); the item-id entry
 * (POST /api/conversions {kind:'stt', item:…}) resolves to it and detonates. (b): the binding is marked broken.
 */
describe('resolveAudioSource — item entry hitting a broken (dir-gone) binding marks it broken', () => {
  const GONE = '[alist] code 500: failed get objs: failed get dir: object not found'
  const noteResolveError = vi.fn()
  const noteResolveOk = vi.fn()
  const lookup = vi.fn()
  const netdisk = { lookup, rawUrl: vi.fn(), noteResolveError, noteResolveOk }
  const deps = { netdisk }

  beforeEach(() => {
    vi.mocked(extractAudio.extractNetdiskAudio).mockReset()
    lookup.mockReset(); noteResolveError.mockReset(); noteResolveOk.mockReset()
  })

  it('object-not-found → reports the error against the binding setId (still returns null)', async () => {
    lookup.mockReturnValue({ setId: 'map_gone', dirPath: '/网盘/已删目录', rightFile: '第一集.mkv' })
    vi.mocked(extractAudio.extractNetdiskAudio).mockRejectedValue(new Error(GONE))

    await expect(resolveAudioSource('d0f8487c17f108dd', undefined, deps)).resolves.toBeNull()

    expect(noteResolveError).toHaveBeenCalledWith('map_gone', expect.objectContaining({ message: expect.stringContaining('object not found') }))
    expect(noteResolveOk).not.toHaveBeenCalled()
  })

  it('successful extraction → clears the binding health', async () => {
    lookup.mockReturnValue({ setId: 'map_ok', dirPath: '/网盘/在的目录', rightFile: '第一集.mkv' })
    vi.mocked(extractAudio.extractNetdiskAudio).mockResolvedValue({ bytes: new Uint8Array([1]), mime: 'audio/aac' })

    await resolveAudioSource('d0f8487c17f108dd', undefined, deps)

    expect(noteResolveOk).toHaveBeenCalledWith('map_ok')
    expect(noteResolveError).not.toHaveBeenCalled()
  })
})

/**
 * (c) item 入口回退：一部作品挂多条同 leftKey 绑定（一有效一残留）时，item 入口解析撞坏绑定/
 * object-not-found 时按 `lookupAll` 的健康序换下一条同作品绑定重试。踩雷现场见 docs/TODO.md（2026-07-24）。
 */
describe('resolveAudioSource — (c) item entry falls back across same-work bindings', () => {
  const GONE = '[alist] code 500: failed get objs: failed get dir: object not found'
  const lookupAll = vi.fn()
  const lookup = vi.fn()
  const noteResolveError = vi.fn()
  const noteResolveOk = vi.fn()
  const netdisk = { lookup, lookupAll, rawUrl: vi.fn(), noteResolveError, noteResolveOk }
  const deps = { netdisk }

  beforeEach(() => {
    vi.mocked(extractAudio.extractNetdiskAudio).mockReset()
    lookupAll.mockReset(); lookup.mockReset(); noteResolveError.mockReset(); noteResolveOk.mockReset()
  })

  it('tries candidates in health order, stops at the first that resolves (broken one never touched)', async () => {
    // lookupAll orders healthy-first; the broken residual is last. First succeeds → second untouched.
    lookupAll.mockReturnValue([
      { setId: 'map_good', dirPath: '/网盘/好目录', rightFile: '第一集.mkv' },
      { setId: 'map_broken', dirPath: '/网盘/已删目录', rightFile: '第一集.mkv' },
    ])
    vi.mocked(extractAudio.extractNetdiskAudio).mockResolvedValue({ bytes: new Uint8Array([9]), mime: 'audio/aac' })

    const out = await resolveAudioSource('tmdb:1:S01E01', undefined, deps)

    expect(extractAudio.extractNetdiskAudio).toHaveBeenCalledTimes(1)
    expect(extractAudio.extractNetdiskAudio).toHaveBeenCalledWith(netdisk, '/网盘/好目录/第一集.mkv', expect.anything())
    expect(noteResolveOk).toHaveBeenCalledWith('map_good')
    expect(out).toEqual({ bytes: new Uint8Array([9]), mime: 'audio/aac' })
  })

  it('a not-yet-broken but object-not-found binding → marks it broken and falls back to the next, which succeeds', async () => {
    lookupAll.mockReturnValue([
      { setId: 'map_stale', dirPath: '/网盘/已删目录', rightFile: '第一集.mkv' },
      { setId: 'map_good', dirPath: '/网盘/好目录', rightFile: '第一集.mkv' },
    ])
    vi.mocked(extractAudio.extractNetdiskAudio)
      .mockRejectedValueOnce(new Error(GONE))
      .mockResolvedValueOnce({ bytes: new Uint8Array([7]), mime: 'audio/aac' })

    const out = await resolveAudioSource('tmdb:1:S01E01', undefined, deps)

    // (b): the stale binding is reported (→ marked broken); the good one resolves and clears health.
    expect(noteResolveError).toHaveBeenCalledWith('map_stale', expect.objectContaining({ message: expect.stringContaining('object not found') }))
    expect(noteResolveOk).toHaveBeenCalledWith('map_good')
    expect(extractAudio.extractNetdiskAudio).toHaveBeenCalledTimes(2)
    expect(out).toEqual({ bytes: new Uint8Array([7]), mime: 'audio/aac' })
  })

  it('only one same-work binding and it is gone → fails truthfully, tries it exactly once (no infinite retry)', async () => {
    lookupAll.mockReturnValue([{ setId: 'map_only', dirPath: '/网盘/已删目录', rightFile: '第一集.mkv' }])
    vi.mocked(extractAudio.extractNetdiskAudio).mockRejectedValue(new Error(GONE))
    const onError = vi.fn()

    const out = await resolveAudioSource('tmdb:1:S01E01', undefined, { ...deps, onError })

    expect(out).toBeNull()
    expect(extractAudio.extractNetdiskAudio).toHaveBeenCalledTimes(1)
    expect(noteResolveError).toHaveBeenCalledWith('map_only', expect.objectContaining({ message: expect.stringContaining('object not found') }))
    expect(noteResolveOk).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith('tmdb:1:S01E01', expect.objectContaining({ message: expect.stringContaining('object not found') }))
  })

  it('a transient failure (not object-not-found) does not thrash siblings — degrade to null after the first', async () => {
    lookupAll.mockReturnValue([
      { setId: 'map_a', dirPath: '/网盘/a', rightFile: '第一集.mkv' },
      { setId: 'map_b', dirPath: '/网盘/b', rightFile: '第一集.mkv' },
    ])
    vi.mocked(extractAudio.extractNetdiskAudio).mockRejectedValue(new Error('[extract] ffmpeg timed out after 900000ms'))

    const out = await resolveAudioSource('tmdb:1:S01E01', undefined, deps)

    expect(out).toBeNull()
    expect(extractAudio.extractNetdiskAudio).toHaveBeenCalledTimes(1) // stopped, did not try map_b
    expect(noteResolveError).toHaveBeenCalledWith('map_a', expect.anything()) // reported (internally ignored: not object-not-found)
  })
})
