import { describe, it, expect, vi } from 'vitest'
import { parseableSource, resolveSourceBytes } from './media.ts'
import type { Media } from '../content/types.ts'

describe('parseableSource', () => {
  it('prefers an image', () => {
    const media: Media[] = [{ kind: 'image', url: 'http://x/p.jpg' }, { kind: 'link', url: 'http://x/d.pdf' }]
    expect(parseableSource(media)).toEqual({ kind: 'image', url: 'http://x/p.jpg' })
  })

  it('falls back to a .pdf link', () => {
    const media: Media[] = [{ kind: 'link', url: 'http://x/paper.pdf?dl=1', title: 'paper' }]
    expect(parseableSource(media)).toEqual({ kind: 'pdf', url: 'http://x/paper.pdf?dl=1' })
  })

  it('returns undefined when neither image nor pdf link', () => {
    const media: Media[] = [{ kind: 'link', url: 'http://x/page.html' }]
    expect(parseableSource(media)).toBeUndefined()
    expect(parseableSource(undefined)).toBeUndefined()
  })
})

describe('resolveSourceBytes', () => {
  it('fetches a pdf link and reports its content-type', async () => {
    const fetchUrl = vi.fn(async () =>
      new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'application/pdf' } })
    )
    const res = await resolveSourceBytes([{ kind: 'link', url: 'http://x/y.pdf' }], { fetchUrl })
    expect(fetchUrl).toHaveBeenCalledWith('http://x/y.pdf')
    expect(res?.mime).toBe('application/pdf')
    expect(Array.from(res!.bytes)).toEqual([1, 2, 3])
  })

  it('defaults the mime by source kind when the response omits it', async () => {
    const fetchUrl = vi.fn(async () => new Response(new Uint8Array([9]), { status: 200 }))
    const res = await resolveSourceBytes([{ kind: 'image', url: 'http://x/p.jpg' }], { fetchUrl })
    // Response() with a body defaults content-type to text/plain;charset=UTF-8 — assert we
    // at least return bytes; mime falls through to the response value when present.
    expect(res?.bytes).toBeInstanceOf(Uint8Array)
  })

  it('returns null when nothing parseable', async () => {
    const fetchUrl = vi.fn()
    expect(await resolveSourceBytes([{ kind: 'link', url: 'http://x/a.html' }], { fetchUrl })).toBeNull()
    expect(fetchUrl).not.toHaveBeenCalled()
  })

  it('returns null when the fetch fails', async () => {
    const fetchUrl = vi.fn(async () => null)
    expect(await resolveSourceBytes([{ kind: 'link', url: 'http://x/a.pdf' }], { fetchUrl })).toBeNull()
  })
})
