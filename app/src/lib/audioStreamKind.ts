/**
 * 音频频道 L1 的分类判据：一条订阅来的流是「播客」还是「歌单」。
 *
 * 数据模型上**没有**这个标志位——Stream 层没有任何 podcast/music 字段，音频侧也只有一个
 * 系统频道 `default-audio`（label 就叫「音乐/播客」）。唯一现成的信号是成员 Source 自己
 * 声明的 `categories`，而且只标了一半：荔枝那类明确写着 `podcast`，音乐平台歌单那条是
 * RSSHub 路由合成出来的，categories 是 namespace 粗类 `multimedia`——同一个值下还躺着
 * `imdb-chart` / `bt0-search` 这些跟音乐无关的源。所以判据只能是**正着认播客、反着认歌单**。
 *
 * 这条反向兜底吃的是「音频频道里除了播客就是歌单」这个假设。真接入第三类（电台、有声书…）
 * 时不要在这里堆 if，而是让那个 Source 自己声明类别（manifest 的 `categories`），把判据翻成
 * 正向的——这个函数是那一步之前的过渡形态。
 */

export type AudioStreamKind = 'podcast' | 'music'

/** 判据只吃 `sources[].source.categories`，所以入参按结构收窄，测试不必造整条 ChannelStream。 */
export interface CategorizedStream {
  sources?: { source?: { categories?: string[] } }[]
}

export function audioStreamKind(s: CategorizedStream): AudioStreamKind {
  // 任一成员声明 podcast 即算——实测有一档播客是「电台的用户源(podcast) + alist-audio(resource)」
  // 两个成员，网盘那半补的是同一档播客的集，不该把整条流拉回「歌单」。
  const podcast = (s.sources ?? []).some((m) => (m.source?.categories ?? []).includes('podcast'))
  return podcast ? 'podcast' : 'music'
}

export function splitAudioStreams<T extends CategorizedStream>(streams: T[]): { playlists: T[]; podcasts: T[] } {
  const playlists: T[] = []
  const podcasts: T[] = []
  for (const s of streams) (audioStreamKind(s) === 'podcast' ? podcasts : playlists).push(s)
  return { playlists, podcasts }
}
