// src/audio/download-item.ts

/** recipe 引擎标准 item schema（`author`/`image`，不是 `artist`/`cover`；见 src/replay/recipe-import.ts）
 *  → 下载队列要的业务字段名。**这里没有任何站点知识**，只是字段改名：取歌 recipe 一律按引擎的
 *  标准字段出货，所以哪家平台的下载 item 都走这一条。 */
export interface DownloadItem {
  url?: string
  enclosure_url?: string
  headers?: Record<string, string>
  format?: string
  bitDepth?: number
  title?: string
  author?: string
  album?: string
  image?: string
}

export interface ResolvedDownload {
  url: string
  headers?: Record<string, string>
  format?: string
  title?: string
  artist?: string
  album?: string
  coverUrl?: string
}

export function mapDownloadItem(item: DownloadItem | null): ResolvedDownload | null {
  const url = item?.url ?? item?.enclosure_url
  if (!url) return null
  return {
    url, headers: item?.headers, format: item?.format, title: item?.title,
    artist: item?.author, album: item?.album, coverUrl: item?.image,
  }
}
