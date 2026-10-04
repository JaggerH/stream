/**
 * 头尾采样转写的缓存。**这一层的全部难点是那把 key**。
 *
 * ## 为什么不能拿路径当 key
 *
 * 转写是要花钱的（一段 120 秒窗口一次远端 ASR 调用），所以同一份文件不该被听第二遍。最自然的
 * key 是绝对路径——而**整理这件事的本职就是搬文件**：判完这份是哪一集，下一步就是把它从来源
 * 目录挪上货架。路径一变，同一份文件在缓存里变成两个，重来一次全款。这不是理论上的边角：
 * 「先采样判读、再搬运」是这条链路的正常顺序，每一份被判过的文件都会走到这一步。
 *
 * ## 用的是什么
 *
 * AList 的 `/api/fs/get` 会带回 driver 侧的对象 id（`AlistClient.fileId`；夸克即 fid，转码播放
 * 一直按它定位）。它跟着**文件**走、不跟着路径走，所以搬家之后照样命中。这是首选那一档。
 *
 * **取不到就退成「字节数:路径」**（`durations` 表用的同一把 key，理由也同一个：换了内容字节数
 * 必变）。代价是明确的：这类文件搬一次家就要重付一次转写钱。退档这件事**在日志里说出来**，
 * 不静默——「缓存好像没生效」是那种查起来最费劲、又完全不报错的毛病。
 *
 * ## 命中时还要复核字节数
 *
 * key 撞了（对象 id 被 driver 复用、或路径被换了内容而字节数恰好没变）就会拿一份别的文件的转写
 * 当证据端上去，而它读起来毫无破绽。所以命中要求 `size_bytes` 相等，不等就当没缓存、重新采样。
 * 一份**对不上号的证据比没有证据糟得多**——这条链路后面接的是认领或删除。
 */
import type Database from 'better-sqlite3'
import type { IdentityProbe } from './identity-probe.ts'

/** key 是哪一档。`path` 那档意味着「这份文件一搬家就要重付一次转写」——日志该说得出来。 */
export type SampleKeyKind = 'fid' | 'path'

export interface SampleKey {
  key: string
  kind: SampleKeyKind
}

/**
 * 拼一把 key。`windowS` 进 key：窗口长度不同，采到的就是不同长度的两段话，共用一格会让
 * 「我要 30 秒」拿回一份 120 秒的转写，而没有任何一处会喊。
 */
export function sampleKey(
  file: { path: string; sizeBytes: number },
  windowS: number,
  fileId?: string,
): SampleKey {
  return fileId
    ? { key: `fid:${fileId}:w${windowS}`, kind: 'fid' }
    : { key: `path:${file.sizeBytes}:${file.path}:w${windowS}`, kind: 'path' }
}

interface Row {
  size_bytes: number
  probe: string
}

/** netdisk.db 的 `audio_samples` 表。行不存在、或字节数对不上 → `undefined`（重新采样）。 */
export class SampleCache {
  private readonly byKey: Database.Statement
  private readonly upsert: Database.Statement

  constructor(db: Database.Database) {
    this.byKey = db.prepare('SELECT size_bytes, probe FROM audio_samples WHERE key = ?')
    this.upsert = db.prepare(
      'INSERT OR REPLACE INTO audio_samples (key, at, path, size_bytes, probe) VALUES (?, ?, ?, ?, ?)',
    )
  }

  get(key: string, sizeBytes: number): IdentityProbe | undefined {
    const row = this.byKey.get(key) as Row | undefined
    // 字节数对不上 = 这把 key 指的已经不是当初那份文件。**当没缓存**，别端一份对不上号的证据。
    if (!row || row.size_bytes !== sizeBytes) return undefined
    try {
      return JSON.parse(row.probe) as IdentityProbe
    } catch {
      return undefined // 写坏的一行不该让这条链路整个不能用；重采一次就把它盖掉了。
    }
  }

  set(key: string, file: { path: string; sizeBytes: number }, probe: IdentityProbe): void {
    this.upsert.run(key, Date.now(), file.path, file.sizeBytes, JSON.stringify(probe))
  }
}
