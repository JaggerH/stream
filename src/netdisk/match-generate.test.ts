import { describe, it, expect, vi } from 'vitest'
import { resolveSeasonsByLlm } from './match-generate.ts'
import type { FolderContext } from './match-generate.ts'
import type { InvokeLlm } from './match-generate.ts'

describe('resolveSeasonsByLlm', () => {
  const candidates = [{ season: 1, episodeCount: 8 }, { season: 2, episodeCount: 12 }, { season: 3, episodeCount: 10 }]
  const noContext: FolderContext = { tree: [], extraFiles: [] }
  const folder = (folderName: string, context: FolderContext = noContext) => ({ folderName, context })

  it('resolves multiple folders from one batched JSON response', async () => {
    const invokeLlm: InvokeLlm = vi.fn(async () => JSON.stringify({ a: 2, b: 3 }))
    const out = await resolveSeasonsByLlm([folder('a'), folder('b')], [], candidates, invokeLlm)
    expect(out.get('a')).toBe(2)
    expect(out.get('b')).toBe(3)
    expect(invokeLlm).toHaveBeenCalledTimes(1) // 一次调用判完两个文件夹,不是两次
  })

  it('accepts a season number embedded in a larger JSON blob (markdown fence tolerant)', async () => {
    const invokeLlm: InvokeLlm = vi.fn(async () => '```json\n{"a": 2}\n```')
    const out = await resolveSeasonsByLlm([folder('a')], [], candidates, invokeLlm)
    expect(out.get('a')).toBe(2)
  })

  it('returns null for a folder the model marks unknown', async () => {
    const invokeLlm: InvokeLlm = vi.fn(async () => JSON.stringify({ a: 'unknown' }))
    const out = await resolveSeasonsByLlm([folder('a')], [], candidates, invokeLlm)
    expect(out.get('a')).toBeNull()
  })

  it('returns null for a folder whose answer is not in the candidate list (hallucination guard)', async () => {
    const invokeLlm: InvokeLlm = vi.fn(async () => JSON.stringify({ a: 99 }))
    const out = await resolveSeasonsByLlm([folder('a')], [], candidates, invokeLlm)
    expect(out.get('a')).toBeNull()
  })

  it('returns null for a folder the model silently omitted from its answer', async () => {
    const invokeLlm: InvokeLlm = vi.fn(async () => JSON.stringify({ a: 2 })) // 'b' 没出现在回答里
    const out = await resolveSeasonsByLlm([folder('a'), folder('b')], [], candidates, invokeLlm)
    expect(out.get('a')).toBe(2)
    expect(out.get('b')).toBeNull()
  })

  it('returns all-null when invokeLlm rejects, returns nothing, or replies with unparseable garbage', async () => {
    const nullOut = await resolveSeasonsByLlm([folder('a')], [], candidates, vi.fn(async () => null))
    expect(nullOut.get('a')).toBeNull()
    const throwOut = await resolveSeasonsByLlm([folder('a')], [], candidates, vi.fn(async () => { throw new Error('boom') }))
    expect(throwOut.get('a')).toBeNull()
    const garbageOut = await resolveSeasonsByLlm([folder('a')], [], candidates, vi.fn(async () => '抱歉我无法完成'))
    expect(garbageOut.get('a')).toBeNull()
  })

  it('returns an empty map and never calls invokeLlm when there are no folders to resolve', async () => {
    const invokeLlm = vi.fn<InvokeLlm>()
    const out = await resolveSeasonsByLlm([], [], candidates, invokeLlm)
    expect(out.size).toBe(0)
    expect(invokeLlm).not.toHaveBeenCalled()
  })

  it('passes folder tree/extraFiles, takenSeasons, and candidates through to the model prompt', async () => {
    const invokeLlm: InvokeLlm = vi.fn(async () => JSON.stringify({ a: 1 }))
    const context = { tree: ['S1+S2'], extraFiles: ['S1+S2/脱口秀和Ta的朋友们 第二季.zip'] }
    await resolveSeasonsByLlm([folder('a', context)], [2, 3], candidates, invokeLlm)
    const sent = JSON.parse((invokeLlm as ReturnType<typeof vi.fn>).mock.calls[0][0].messages[1].content)
    expect(sent.folders).toEqual([{ folderName: 'a', tree: ['S1+S2'], extraFiles: ['S1+S2/脱口秀和Ta的朋友们 第二季.zip'] }])
    expect(sent.takenSeasons).toEqual([2, 3])
    expect(sent.candidates).toEqual(candidates)
  })
})
