// src/audio/download-item.test.ts
import { describe, it, expect } from 'vitest'
import { mapDownloadItem } from './download-item.ts'

describe('mapDownloadItem', () => {
  it('maps author → artist and image → coverUrl (the field-name bug this fixes)', () => {
    const result = mapDownloadItem({
      url: 'https://cdn/song.flac', format: 'flac', title: '屋顶',
      author: '周杰伦/温岚/吴宗宪', album: '男女情歌对唱冠军全记录', image: 'https://cdn/cover.jpg',
    })
    expect(result).toEqual({
      url: 'https://cdn/song.flac', headers: undefined, format: 'flac', title: '屋顶',
      artist: '周杰伦/温岚/吴宗宪', album: '男女情歌对唱冠军全记录', coverUrl: 'https://cdn/cover.jpg',
    })
  })

  it('falls back to enclosure_url when url is absent', () => {
    const result = mapDownloadItem({ enclosure_url: 'https://cdn/fallback.mp3', format: 'mp3' })
    expect(result?.url).toBe('https://cdn/fallback.mp3')
  })

  it('returns null when neither url nor enclosure_url is present', () => {
    expect(mapDownloadItem({ title: 'x' })).toBeNull()
  })

  it('returns null for a null item', () => {
    expect(mapDownloadItem(null)).toBeNull()
  })

  it('leaves artist/album/coverUrl undefined when the source item lacks them', () => {
    const result = mapDownloadItem({ url: 'https://cdn/song.flac', format: 'flac' })
    expect(result).toEqual({ url: 'https://cdn/song.flac', headers: undefined, format: 'flac', title: undefined, artist: undefined, album: undefined, coverUrl: undefined })
  })
})
