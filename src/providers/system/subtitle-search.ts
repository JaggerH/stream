import type { SystemIdentity } from './types.ts'

/**
 * 字幕在线搜刮：网盘视频既无内嵌轨、同目录也无外挂字幕时的最后一条来源。
 *
 * auto 段扇出所有 `provides: [search-subtitle]` 的源——**这里不点名任何一家字幕站**，站点的 API、
 * 过滤规则、主机白名单都住各自的包（今天 `packages/xunlei`、`packages/shooter`）。宿主只留机制：
 * `scrape:` track 命名空间、语言探测、srt/ass → VTT、排序（`src/media/subtitle-search.ts`）。
 *
 * **成员合同**（包的 adapter 从 params 读，对象输入由执行器按字段摊进来）：
 *  - `{ op: 'search', name, size?, read? }` → `[{ id, name, nameHint, label }]`。`read(offset, length)`
 *    是宿主给的「按字节区间读这段视频」的能力（网盘 Range 读），要内容指纹的站自己算；`id` 是包自己
 *    认得的字幕标识（宿主只透传，不解析）；`label` 是菜单上「语言 · 来源」的来源那半。
 *    搜不到 / 出错一律 `[]`（静默降级：这是兜底路径，一家挂了不该拖累另一家）。
 *  - `{ op: 'fetch', id }` → `[{ bytes }]`。**取字节由包做**：包自己校验 id 指向的主机（SSRF 边界
 *    跟着知识一起住包里），宿主从不 fetch 任何字幕站的 URL。取不到就抛。宿主按 `id` 的扩展名
 *    （`.srt` / `.ass` / `.vtt`）挑转换器，没有扩展名按 srt 转——所以 id 能带扩展名就带上。
 *
 * 显示名进 `PROVIDER_CALL_SITES`；两个调用点都在 `GET /api/media/netdisk-subtitle{-list}`。
 */
export const subtitleSearch: SystemIdentity = {
  id: 'subtitle-search',
  category: 'search',
  serveKeys: ['subtitle'],
  fallback: false,
  strategy: 'concurrent',
  contract: null,
  defaultLabel: '字幕搜刮',
  defaultDescription: '视频文件名（+ 可按字节读）→ 在线字幕候选',
  defaultMembers: [
    { mode: 'auto', provides: 'search-subtitle' },
  ],
}
