// shared/extract/plan.ts
//
// 「这条 item 的正文该怎么取」——**唯一**的判定。
//
// 放在 shared/ 而不是后端，是因为两边都要它：后端 extract converter 靠它选分支，前端靠它决定
// 「转成文字」按钮显不显示。这个判断以前被复制在三处（前端两个嗅探 helper + MCP 两个具名工具
// 让模型自己挑），没有一处权威——收敛的整个意义就是它只能有一份。设计见
// docs/superpowers/specs/2026-07-31-extract-unified-content-design.md。
//
// 纯函数：不碰 I/O、不认识 Provider、不知道谁在跑。可用性由调用方以 caps 注入。

/** 与 src/content/types.ts 同源的最小子集——这里只用得着 archetype / text / media / quoted，
 *  声明成结构子集而不是 import 后端类型，才能被前端一样地消费（shared/ 不许依赖任一侧）。 */
export type Archetype = 'text' | 'article' | 'video' | 'audio' | 'gallery' | 'link' | 'forward'

export type Media =
  | { kind: 'image'; url: string }
  | { kind: 'video'; url?: string; vid?: string; embed?: string; page_url?: string; resolveOnly?: boolean }
  | { kind: 'audio'; url?: string; resolveOnly?: boolean; platform?: string; track_id?: string }
  | { kind: 'link'; url: string }

export interface Quoted {
  archetype?: Archetype
  text?: string
  media?: Media[]
}

export interface Content {
  archetype: Archetype
  text?: string
  media?: Media[]
  quoted?: Quoted
  /** 媒体不在描述符里，由**句柄本身**解析（网盘绑定的 `tmdb:…` 分集就是这样：它压根不是
   *  一条 item，字节由 transcribe 的 resolver 按句柄取）。可行性判定据此放行——否则这类
   *  合法目标会被判成「没有可转写的东西」，而它恰恰是转写最典型的输入。 */
  resolvedByHandle?: boolean
}

/** 转成文字的四条分支。`inline` 不打后端——正文已经在 item 上。 */
export type ExtractBranch = 'stt' | 'ocr' | 'article' | 'inline'

/** 各分支的后端此刻配没配（`inline` 不需要，故不在此列）。 */
export interface ExtractCapabilities {
  stt: boolean
  ocr: boolean
  article: boolean
}

export type ExtractPlan =
  | { ok: true; branch: 'inline'; text: string }
  | { ok: true; branch: 'stt' }
  | { ok: true; branch: 'ocr' }
  | { ok: true; branch: 'article'; url: string }
  | {
      ok: false
      /** `no_source` = 这条 item 拿不出该分支要的东西；`branch_unavailable` = 拿得出，但后端没配。 */
      code: 'no_source' | 'branch_unavailable'
      branch: ExtractBranch
      message: string
    }

const PDF = /\.pdf(\?|#|$)/i

/** 该分支取不取得到东西——**只看这条 item 自己**，与后端配没配无关。 */
function hasSource(branch: Exclude<ExtractBranch, 'inline'>, content: Content, url?: string): boolean {
  const media = content.media ?? []
  if (branch === 'stt') {
    if (content.resolvedByHandle) return true
    // 判据**镜像后端真身**（src/transcribe/media.ts 的 transcribableMedia + resolveMediaBytes）：
    //
    // - 视频：provider 定位（任何平台的 `(provider, vid)`、xhs 的 embed/page_url）或直链/网盘 resolve 的 url。
    //   教训：上一版判据写成 `!!m.url`，把 B 站（vid 定位、无 url）——转写的主战场——判成了没源。
    // - 音频带 `platform+track_id`：喂得进**播放那条统一漏斗**（src/audio/track-source.ts），
    //   四档依次是本地归档 / 网盘绑定（leftKey 就是这串 `<platform>:<track_id>`，与服务期付费闸门
    //   src/content/paid-playability.ts 同一个键）/ 官方 provider 梯子 / 回落原始直链。免费集和
    //   付费集（`resolveOnly`）同吃这一条——**别按 resolveOnly 分叉**，那会把归档档与官方源档
    //   从免费集手里拿走。
    // - 只有裸直链的老形状（既没 platform 也没 track_id，库里 22 条）：后端有一条直链兜底。
    //
    // 仍然不放行：三样都没有的音频（被闸门降级成封面的那种），它确实没有流。
    return media.some((m) =>
      m.kind === 'video'
        ? !!m.url || (!m.resolveOnly && !!(m.vid || m.embed || m.page_url))
        : m.kind === 'audio' && (!!m.url || !!(m.platform && m.track_id)))
  }
  if (branch === 'ocr') return media.some((m) => m.kind === 'image' || (m.kind === 'link' && PDF.test(m.url)))
  return !!articleUrl(content, url)
}

function articleUrl(content: Content, url?: string): string | undefined {
  const linked = (content.media ?? []).find((m): m is Extract<Media, { kind: 'link' }> => m.kind === 'link')
  return linked?.url ?? url
}

const BRANCH_LABEL: Record<ExtractBranch, string> = {
  stt: '语音转文字', ocr: '图片/PDF 识别', article: '网页正文抓取', inline: '直取条目原文',
}

/**
 * 定这条 item 的正文该走哪条分支。
 *
 * **两段判定**：`archetype` 定意图（它是入库时就写好的必填字段，回答的正是「这条 post 是什么」），
 * 然后该分支自查可行性。archetype 说的是意图，**不保证那东西取得到**——一条 `video` post 的
 * 视频可能是 resolveOnly、可能已下架。
 *
 * **不可行时必须失败，绝不换分支。** 一条视频 post 把封面图 OCR 出来当正文，比明确失败更坏：
 * 它会安静产出一份看着成功、实则完全不对的结果，而下游的总结会认真地总结那张封面。
 *
 * @param url item.url —— `article` 分支在 media 里找不到链接时的兜底地址。
 */
export function planExtract(
  content: Content,
  caps: ExtractCapabilities,
  url?: string,
): ExtractPlan {
  // 转发：正文在被转发体上。它没标 archetype 时不猜——退回外层自己的文字（转发理由也是正文）。
  //
  // **这里不需要递归上限**：`Quoted` 没有 `quoted` 字段（见 src/content/types.ts），转发链在类型上
  // 就深不过一层，所以下面这一跳是唯一的一跳。那个类型的文档注释写着「recursive — forward-of-forward」
  // ——注释与类型不符，别照注释加护栏：加了是死代码，还会逼出一条只能断言「没抛异常」的空测试。
  if (content.archetype === 'forward') {
    const q = content.quoted
    if (q?.archetype) return planExtract({ archetype: q.archetype, text: q.text, media: q.media }, caps, url)
    return inlineOf(content)
  }

  if (content.archetype === 'text') {
    const inline = inlineOf(content)
    // 正文为空但有链接 → 退去抓网页。网页搜索源的命中就是这形状(只有标题+链接,没有正文)——
    // 不退的话这类条目 extract 恒 no_source,而它明明指着一篇能抓的页面(2026-08-23 活体:
    // 三条百家号横评全倒在这里)。有正文时仍走 inline,白拿的一档不动。
    if (!inline.ok) {
      const aUrl = articleUrl(content, url)
      if (aUrl !== undefined) {
        if (!caps.article) return { ok: false, code: 'branch_unavailable', branch: 'article', message: `${BRANCH_LABEL.article}未配置` }
        return { ok: true, branch: 'article', url: aUrl }
      }
    }
    return inline
  }

  // `link` 有两种归宿：指着一篇网页 → article；指着一份 PDF → ocr（parse 行本来就吃 PDF）。
  const branch: Exclude<ExtractBranch, 'inline'> =
    content.archetype === 'video' || content.archetype === 'audio' ? 'stt'
      : content.archetype === 'gallery' ? 'ocr'
        : hasSource('ocr', content, url) ? 'ocr'
          : 'article'

  // 可行性先于可用性：源都没有的时候报「后端没配」，会把人支到设置页去白跑一趟。
  if (!hasSource(branch, content, url)) {
    return { ok: false, code: 'no_source', branch, message: `这条内容里没有可${BRANCH_LABEL[branch]}的东西` }
  }
  if (!caps[branch]) {
    return { ok: false, code: 'branch_unavailable', branch, message: `${BRANCH_LABEL[branch]}未配置` }
  }
  return branch === 'article' ? { ok: true, branch, url: articleUrl(content, url)! } : { ok: true, branch }
}

function inlineOf(content: Content): ExtractPlan {
  const text = content.text?.trim()
  // 空正文不返回一个空字符串装成功——那会让下游拿到一份「成功但没内容」的结果去总结。
  if (!text) return { ok: false, code: 'no_source', branch: 'inline', message: '这条内容没有正文' }
  return { ok: true, branch: 'inline', text }
}
