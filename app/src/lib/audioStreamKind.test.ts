import { describe, expect, it } from 'vitest'
import { audioStreamKind, splitAudioStreams } from './audioStreamKind.ts'

const stream = (id: string, ...categories: string[][]) => ({
  id,
  sources: categories.map((c) => ({ source: { id: id + ':' + c.join('-'), categories: c } })),
})

describe('audioStreamKind', () => {
  it('marks a stream whose source declares the podcast category', () => {
    expect(audioStreamKind(stream('lizhi', ['podcast']))).toBe('podcast')
  })

  it('marks a mixed-member stream as podcast when ANY member declares it', () => {
    // 怡乐播客 = lizhi-user(podcast) + alist-audio(resource):网盘补集的成员没有类别，
    // 但它补的是同一档播客的集。
    expect(audioStreamKind(stream('yile', ['podcast'], ['resource']))).toBe('podcast')
  })

  it('falls back to music for anything else', () => {
    // 网易云歌单是 RSSHub 合成的 source，categories 是 namespace 粗类 multimedia
    // (同值的还有 imdb-chart / bt0-search),不能正着认「是歌单」,只能反着认「不是播客」。
    expect(audioStreamKind(stream('163', ['multimedia']))).toBe('music')
    expect(audioStreamKind({})).toBe('music')                        // 没有 sources
    expect(audioStreamKind({ sources: [{ source: {} }] })).toBe('music') // 有成员但没声明类别
  })
})

describe('splitAudioStreams', () => {
  it('splits into playlists + podcasts, preserving input order within each', () => {
    const a = stream('a', ['multimedia'])
    const b = stream('b', ['podcast'])
    const c = stream('c', ['multimedia'])
    expect(splitAudioStreams([a, b, c])).toEqual({ playlists: [a, c], podcasts: [b] })
  })

  it('returns two empty buckets for no streams', () => {
    expect(splitAudioStreams([])).toEqual({ playlists: [], podcasts: [] })
  })
})
