// app/src/lib/useExtractConversion.ts
//
// 转写档的全部状态：一条 item 的 extract 转换（起 / 查缓存 / 轮询 / 取消）。
//
// ## 为什么是 hook 挂在 Detail 树内，而不是全局 store
//
// 转写档只活在详情这一棵树里：详情关掉，轮询就该停，没有别处要读这份状态。挂进全局
// store 的代价是「谁负责清」变成一个没有答案的问题（详情关了轮询还在跑，就是那个形状）。
// 粘贴流的「点转成文字」也不需要跨树传状态——它传的是**意图**（openDetail 的
// `extract: true` → Detail 的 autoExtract），转换本身仍由详情树里这一份发起。
//
// ## 两条句柄命名空间，同一个 POST
//
// - 库内 item：后端 `resolveHandle` 认识它，media/content 自己解析（我们照递不误——
//   手里这份 item 就是从库里来的，递过去和后端自己解析是同一份数据）。
// - 粘贴的瞬时句柄（`paste:<url>`，不进库）：后端只认内联 `media` + `options.content`
//   （`conversions-routes.ts` 的未知句柄回退），这里把 from-url 抓到的都递全。
//
// 缓存键是 (item id, extract)：同一条（同一链接再粘一次）第二次 start 命中 200 +
// 既有记录，不重新计费——所以「打开即转写」（autoExtract）不需要先问「转没转过」。
import { useCallback, useEffect, useState } from 'react'

import { api, type Connection } from './api.ts'
import { toExtractContent } from './extract.ts'
import type { Conversion, Item as StreamItem, Media } from './types.ts'

export interface ExtractConversionState {
  /** 这条 item 的 extract 记录（缓存命中时开档即 done + 全文）。null = 还没有。 */
  record: Conversion | null
  /** 开档那次缓存查询还没回来（loading 期间不画「开始转写」——可能下一拍就是全文）。 */
  loading: boolean
  /** start() 本身没起成（网络 / 503 后端未配置）——和记录里的 error 分开：
   *  那是转换跑了没成，这是压根没进去。两档该给的动作不一样（重试 vs 看原因）。 */
  startError?: string
  start: (opts?: { force?: boolean }) => void
  /** 取消并删除（在跑的中止、排队的出队、历史的抹掉——后端 DELETE 的语义）。 */
  remove: () => void
}

/** 快照要的那格封面：视频海报优先，图集退第一张图。 */
function posterOf(media: Media[] | undefined): string | undefined {
  for (const m of media ?? []) {
    if (m.kind === 'video' && m.poster) return m.poster
    if (m.kind === 'image') return m.url
  }
  return undefined
}

export function useExtractConversion(
  conn: Connection,
  item: StreamItem,
  opts?: { enabled?: boolean },
): ExtractConversionState {
  // canExtract 为假（caps 没到 / 这条不支持）时整份 hook 静默：不查缓存、不轮询。
  // start() 仍可用——它的消费者（转写档 / autoExtract）本身就都吃 canExtract 门。
  const enabled = opts?.enabled !== false
  const [record, setRecord] = useState<Conversion | null>(null)
  // 初值跟 enabled 走：disabled 挂载的那条路一个状态都不碰（本来也没有什么可查），
  // 不然 loading true→false 的空翻会多出一轮渲染——消费方里有用 mockReturnValueOnce 钉
  // 单次富化值的测试，多一轮渲染就把那份值吃掉了（表现为正文消失，极难往这想）。
  const [loading, setLoading] = useState(enabled)
  const [startError, setStartError] = useState<string | undefined>()

  // 换条 item 就整套重来：查缓存、清上一条的记录和错误。
  useEffect(() => {
    if (!enabled) {
      setRecord(null)
      setStartError(undefined)
      setLoading(false)
      return
    }
    let cancelled = false
    setRecord(null)
    setStartError(undefined)
    setLoading(true)
    api.conversions
      .latest(conn, item.id, 'extract', { expandResult: true })
      .then((r) => {
        if (!cancelled) setRecord(r)
      })
      .catch(() => {
        // 查不到 ≠ 不能转（比如瞬时句柄第一次来，列表为空是很正常的一档）：start 照常可用。
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [conn, item.id, enabled])

  const start = useCallback(
    (opts?: { force?: boolean }) => {
      setStartError(undefined)
      api.conversions
        .start(conn, 'extract', item.id, {
          media: item.content?.media,
          snapshot: {
            title: item.title || item.url || item.id,
            source: item.stream_id ?? 'paste',
            url: item.url,
            poster: posterOf(item.content?.media),
          },
          options: { content: toExtractContent(item), url: item.url },
          force: opts?.force,
        })
        .then((r) => setRecord(r))
        .catch((e: unknown) => setStartError(e instanceof Error ? e.message : String(e)))
    },
    [conn, item],
  )

  const remove = useCallback(() => {
    const id = record?.id
    if (!id) return
    api.conversions
      .remove(conn, id)
      .then(() => setRecord(null))
      .catch(() => {
        // 删失败不硬清：下一拍轮询/重开详情自然对齐真相。
      })
  }, [conn, record?.id])

  // 排队/运行期间低频轮询兜底。完成那一下用户侧另有通知（`transcribe.done` 走通知
  // 中心），这里只保证开着详情的人最迟 2.5s 后看到终态。
  const active = record?.status === 'queued' || record?.status === 'running'
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => {
      api.conversions
        .latest(conn, item.id, 'extract', { expandResult: true })
        .then((r) => {
          if (r) setRecord(r)
        })
        .catch(() => {})
    }, 2500)
    return () => clearInterval(timer)
  }, [active, conn, item.id])

  return { record, loading, startError, start, remove }
}
