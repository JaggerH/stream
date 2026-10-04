/**
 * 「这条 item 的转写是哪一条 extract 记录」——**前后端同吃这一份**。
 *
 * 后端 `ConversionRunner`（声纹归名、时间轴、出现账都从这里取 segments）和前端详情页的转写档
 * 都要下这条判据。两份实现漂移了不会有任何测试报警：前端挑错记录的表现是「转写档空着、
 * 或显示的是一条 OCR 的字」，两边单看都正常。
 *
 * 判据是**带不带 `detail.segments`**，不是新不新：收敛之后同一条 item 可能有多条 extract
 * （先转写、后来又 OCR 了一张图），取「最新的一条」会被 OCR 结果盖掉真正的转写，而 OCR
 * 产不出时间轴。
 */

/** 一段转写。字段与后端 `TranscriptSegment`（src/transcribe/client.ts）逐字一致——它要能直接
 *  赋回去，多一个可选字段就不行了。 */
export interface TranscriptSegmentLike {
  start: number
  end: number
  text: string
  speaker?: string
}

/** 一条转换记录里这条判据用得到的那几格（后端 `ConversionRecord` / 前端 `Conversion` 都满足）。 */
export interface ExtractRecordLike {
  kind: string
  status: 'queued' | 'running' | 'done' | 'error'
  result?: unknown
}

/** 一条 extract 记录里的时间轴——**只有转写分支产得出**，所以它同时是「这条是不是转写」的判据。
 *  `undefined` = 这条不是转写（或还没产物）；空数组 = 是转写但一段都没切出来，两者必须分得开。 */
export function segmentsIn(rec: ExtractRecordLike): TranscriptSegmentLike[] | undefined {
  const detail = (rec.result as { detail?: { segments?: TranscriptSegmentLike[] } } | undefined)?.detail
  return detail?.segments
}

/**
 * 挑出这条 item 的转写记录；没有就是 `null`。
 *
 * **前提：`records` 按新→旧排序**（ConversionStore.list 与 `GET /api/conversions` 的返回顺序就是
 * 这个），所以「第一个命中的」= 最新那条转写。别传一个自己重排过的数组进来。
 *
 * 未完成的那条是例外：它还没有产物，分支无从得知，这里一并返回（调用方只读它的 status），
 * 代价是一次在跑的 OCR 会被报成「转写进行中」——只影响一个进度字样，不影响任何产物。
 */
export function pickTranscript<T extends ExtractRecordLike>(records: readonly T[]): T | null {
  return records.find((r) => r.kind === 'extract' && (r.status !== 'done' || segmentsIn(r) !== undefined)) ?? null
}
