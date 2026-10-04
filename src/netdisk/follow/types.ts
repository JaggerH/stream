export interface ShareTreeFile {
  fid: string
  token: string
  /** 分享里的父目录 fid（根 = '0'；缺席按根算）。转存要按它分组提交——子文件夹里的文件拿根目录
   *  提交会被夸克拒（token校验异常）。 */
  pdirFid?: string
  name: string
  size: number
  path: string
}

export interface ShareRow {
  setId: string
  netdisk: string
  pwdId: string
  passcode?: string
  origin: 'manual' | 'search'
  addedAt: string
  lastCheck?: string
  validity?: 'alive' | 'not-usable' | 'needs-login' | 'unknown'
  seenFiles: ShareTreeFile[]
  savedFids: string[]
}

export interface FollowRunRecord {
  id: string
  setId: string
  at: string
  trigger: 'scheduled' | 'manual'
  missingAired: string[] // leftKey[]
  revisited: Array<{ pwdId: string; validity: string; newFiles: number; picked: number }>
  /** `failed` = 搜到了但列不出来/认不了的分享数（「没验到」，与 alive:0 那种「验过了、不行」区分开）。 */
  searched?: { queries: string[]; hits: number; alive: number; picked: number; failed: number }
  saved: Array<{ pwdId: string; files: string[] }> // 分享内路径
  synced: { matchedBefore: number; matchedAfter: number }
  /** 第 5 步归位（`ReconcileService.executeBinding`）的结果；`gated` 有值 = 被健康闸挡了这一轮。
   *  归档器没装配、或调用本身抛错时不落这个字段——那种情况走 `errors` 里的 `archive:` 行。 */
  archived?: { runId: string; moved: number; deleted: number; renamed: number; gated?: string }
  /**
   * 轮末裁决器（spec 2026-09-03-netdisk-llm-adjudicator §7）的结果——归档之后再问一次模型。
   * 裁决器没装配、节流跳过、或调用本身抛错时不落这个字段（跳过/抛错走 `errors` 里的 `adjudicate:` 行）。
   */
  adjudicated?: { runId: string; asked: number; applied: number; rejected: number; unsure: number; failed?: string }
  errors: string[]
}

/**
 * 一条追更候选（`matchExternalFiles` 判成 `pending` 的那些——分享里有货、但置信度不够自动转存）
 * 交给裁决器的输入。**转存所需的一切都在这儿**（`fid`/`token`/`pdirFid` + 归属哪条分享）——裁决器
 * 采纳 is-episode 之后要自己把这份文件转存到货架，不能再回头问 `FollowService` 要一次。
 */
export interface FollowCandidate {
  netdisk: string
  pwdId: string
  passcode?: string
  file: ShareTreeFile
  /** 转存目的地相对路径（已按分享内父目录分组展开，与 `saveFrom` 同一个拼法，见
   *  `follow/service.ts` 的 `landingSubdirFor`）——裁决器落账时把它与 `file.path` 一起交给
   *  `landingPathOf` 算出绝对落地路径。 */
  subdir: string
  /** 这份文件被判成 pending 的那几个缺集（leftKey）——裁决器据此给模型出 `follow-candidate` 卡。 */
  candidateLeftKeys: readonly string[]
}

/** 追更不认识夸克：验活/列树/按文件转存收在这个接口后面。 */
export interface ShareClient {
  supports(netdisk: string): boolean
  list(netdisk: string, pwdId: string, passcode?: string): Promise<{ validity: ShareRow['validity'] & string; files: ShareTreeFile[]; reason?: string }>
  save(
    netdisk: string,
    pwdId: string,
    opts: { files: Array<{ fid: string; token: string; pdirFid?: string }>; subdir: string; passcode?: string },
  ): Promise<{ saved: boolean; stage: string; message: string }>
}
