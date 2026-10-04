/**
 * `extract` —— 取一条 item 的正文。产出形状（见 `src/mcp/tool-catalog.ts` 的 extract 条）：
 * `{status: running|done|error, result?: {text, format, branch, detail?}}`。
 *
 * 深链：**没有**。Stream 没有「打开任意一条 item」的路由（通知中心走的是应用内事件，不经
 * 地址栏），拿一个裸 itemId 去拼 `/video/item/<id>` 会做出一个点了落空的死链——理由写在
 * `src/deep-links.ts` 头注里。（条目**自己的**原文地址不受这条限制：那是站点的 URL，
 * 由回执的 `snapshot.url` 原样给出。）
 *
 * ## 「这是哪一条」由这张卡回答，不由提示语回答
 *
 * 「转成文字」发进对话的那一句只有句柄和标题（`app/src/lib/askExtract.ts`）——作者、来源、
 * 链接一格都不进去，因为它们不是 `extract` 的入参，倒进提示语只会把用户的那条消息撑成
 * 一屏 query string（抖音分享链接单条 500+ 字符）。条目长什么样在**这里**画：回执本身就是
 * 一条 ConversionRecord，`snapshot` 是后端起转换那一刻钉下的 `{title, source, url}`。
 */
import { useState, type ReactNode } from 'react'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { readToolCall, asRecord, str } from '../../tool-result.ts'
import { Badge, Card, DeepLink, FallbackText, Muted } from './frame.tsx'

/** digest 档的「查看全文」：全文不经过模型上下文,卡片自己从 API 拉给人眼看
 *  (spec 2026-08-24-digest-authority——模型面没有全文开关,人读全文走这里)。 */
function useFullText(item: string | undefined): { fullText: string | undefined; state: 'idle' | 'loading' | 'error'; load: () => void } {
  const [fullText, setFullText] = useState<string | undefined>(undefined)
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle')
  const load = (): void => {
    if (item === undefined || state === 'loading') return
    setState('loading')
    void fetch(`/api/conversions?item=${encodeURIComponent(item)}&kind=extract&status=done&expand=result&limit=1`)
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status))
        const body = (await res.json()) as { items?: Array<{ result?: { text?: string } }> }
        const text = body.items?.[0]?.result?.text
        if (typeof text !== 'string') throw new Error('no text')
        setFullText(text)
        setState('idle')
      })
      .catch(() => setState('error'))
  }
  return { fullText, state, load }
}

/** 正文超过这个长度就折起来——一整篇转写稿能有几万字，整份摊在对话里就是刷屏。 */
const PREVIEW_CHARS = 1200

/** 分支名 → 人话。未知分支原样显示（不猜）。 */
const BRANCH_LABEL: Record<string, string> = {
  stt: '语音识别',
  ocr: '文字识别',
  article: '网页正文',
  inline: '帖子原文',
}

/**
 * 条目身份行：标题 +（来源 · 原文）。
 *
 * `snapshot` 读不出来、或它的标题就是句柄本身（网盘绑定的 `tmdb:…` 那档，后端拿不到标题时
 * 回落成句柄）→ 退回原来那行 `item <句柄>`。**绝不空着**：这张卡的一半意义就是说清"这是哪一条"。
 * @param data - 回执的结构化形态（一条 ConversionRecord）。
 * @param item - 调用参数里的句柄，退化时显示它。
 */
function ItemHead({ data, item }: { data: unknown; item: string | undefined }): ReactNode {
  const snap = asRecord(asRecord(data)?.snapshot)
  const title = snap === null ? undefined : str(snap, 'title')
  const source = snap === null ? undefined : str(snap, 'source')
  const url = snap === null ? undefined : str(snap, 'url')
  const poster = snap === null ? undefined : str(snap, 'poster')
  if (title === undefined || title === item) {
    return item !== undefined ? <Muted>item {item}</Muted> : null
  }
  return (
    <div style={{ alignItems: 'flex-start', display: 'flex', gap: 8, minWidth: 0 }}>
      {poster !== undefined ? (
        <img
          src={poster}
          alt=""
          // 固定尺寸 + object-fit：封面比例千奇百怪（竖屏短视频 9:16、专辑封面 1:1），
          // 不裁就会把整张卡撑成一条。**加载失败自己消失**，不留一个破图占位。
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
          style={{ borderRadius: 6, flex: '0 0 auto', height: 48, objectFit: 'cover', width: 48 }}
        />
      ) : null}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <span
          style={{
            WebkitBoxOrient: 'vertical',
            WebkitLineClamp: 3,
            display: '-webkit-box',
            fontSize: 13,
            fontWeight: 500,
            overflow: 'hidden',
            overflowWrap: 'anywhere',
          }}
        >
          {title}
        </span>
        {source !== undefined || url !== undefined ? (
          <span style={{ alignItems: 'baseline', display: 'flex', gap: 6, minWidth: 0 }}>
            {source !== undefined ? <Muted>{source}</Muted> : null}
            {url !== undefined ? <DeepLink href={url}>原文</DeepLink> : null}
          </span>
        ) : null}
      </div>
    </div>
  )
}

/** 画面文字层（frames）的指路行。回执里有 `on_screen_text` 才画——**它在场就意味着这条视频
 *  的画面上另有一份字**（幻灯片/新闻条/字幕），正文里一个都没有。人也该看得见这件事，
 *  不能只讲给模型听。 */
const ON_SCREEN_LABEL: Record<string, string> = {
  queued: '画面文字·排队中',
  running: '画面文字·抽取中',
  done: '画面文字·已就绪',
  error: '画面文字·失败',
  // 「没抽」不是「抽了没料」。这一档写成"已就绪/没有字"，用户就无从知道该追问——而这层
  // 恰恰有四种「判为不抽」的正常结局（见 src/mcp/extract-frames-layer.ts 的 `probe`）。
  not_scanned: '画面文字·未抽取',
}

function OnScreenRow({ data }: { data: unknown }): ReactNode {
  const ptr = asRecord(asRecord(data)?.on_screen_text)
  if (ptr === null) return null
  const status = str(ptr, 'status')
  if (status === undefined) return null
  return <Badge text={ON_SCREEN_LABEL[status] ?? `画面文字·${status}`} tone={status === 'error' ? 'error' : 'muted'} />
}

/**
 * 画面上的字（frames 层）。**和转写分开画**：一个是"谁说了什么"，一个是"屏幕上写着什么"，
 * 混成一段读的人就分不清哪句是听来的、哪句是看来的。空/失败各自说人话，不留一张空块。
 */
function OnScreenText({ data }: { data: unknown }): ReactNode {
  const ptr = asRecord(asRecord(data)?.on_screen_text)
  if (ptr === null) return null
  const status = str(ptr, 'status')
  // 「没抽」照实说，并把理由带上——用户看到"没有字"和看到"判为纯口播所以没看"，
  // 会做的事完全不同（后者他可能想手动起一次）。
  if (status === 'not_scanned') return <Muted>没有抽取画面文字（{str(ptr, 'why') ?? '这一层判为不必抽'}）</Muted>
  if (status !== 'done') return null
  const text = str(ptr, 'text')
  if (text === undefined) return <Muted>逐帧看过了，画面上没有转写之外的字</Muted>
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <Muted>画面上的字</Muted>
      <div
        style={{
          borderLeft: '2px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.3))',
          fontSize: 13,
          lineHeight: '20px',
          maxHeight: 240,
          overflow: 'auto',
          overflowWrap: 'anywhere',
          paddingLeft: 8,
          whiteSpace: 'pre-wrap',
        }}
      >
        {text}
      </div>
    </div>
  )
}

export function ExtractCard({ block }: { block: ToolCallBlock }): ReactNode {
  const call = readToolCall(block)
  const item = typeof call.args?.item === 'string' ? call.args.item : undefined
  const full = useFullText(item)

  if (call.running) {
    return (
      <Card title="转成文字" badge={<Badge text="进行中" />}>
        <ItemHead data={call.data} item={item} />
      </Card>
    )
  }

  const result = asRecord(asRecord(call.data)?.result)
  const text = result === null ? undefined : str(result, 'text')
  const status = str(call.data, 'status')
  const branch = result === null ? undefined : str(result, 'branch')
  // 窄回执三格（extract-digest.ts）：长正文默认回带出处的要点摘要，不是全文——卡片必须如实
  // 标出来，否则用户会把摘要当全文读，footer 的字数也得改用全文长度而不是摘要长度。
  const digested = result?.digested === true
  const digestFailed = result?.digest_failed === true
  const fullTextChars = typeof result?.full_text_chars === 'number' ? result.full_text_chars : undefined

  // —— 还没落定的两档：**必须各有自己的样子** ——
  //
  // 这条工具天生要被调好几次（转写在跑要轮询，画面文字层在抽还要再轮询），所以这两档
  // 出现的次数比"跑完"那一档还多。少一档就会掉进下面的原文回落，把一整坨 JSON 摊在
  // 对话里——活体 2026-08-30 用户看到的就是这个：一轮五张卡，张张是 JSON。
  //
  // 判据用后端给的 `status`，**不是 `call.running`**：`call.running` 问的是"这次工具调用
  // 返回了没有"，早就返回了；还在跑的是它背后那条转换。两件事，别混。
  if (status === 'running' || status === 'queued') {
    const waiting = str(call.data, 'waiting_for') === 'on_screen_text'
    return (
      <Card title="转成文字" badge={<Badge text={waiting ? '等画面文字' : '转写中'} />}>
        <ItemHead data={call.data} item={item} />
        <Muted>
          {waiting
            ? '语音转写好了，屏幕上的字还在抽——这条的正文现在还不完整，抽完一起给。'
            : '正在把这条转成文字，稍等。'}
        </Muted>
      </Card>
    )
  }

  // 结构读不出来（形状变了 / 不是 JSON）→ 原文回落，绝不空卡。
  if (text === undefined) {
    return (
      <Card
        title="转成文字"
        badge={call.isError ? <Badge text="失败" tone="error" /> : status !== undefined ? <Badge text={status} /> : undefined}
      >
        <ItemHead data={call.data} item={item} />
        <FallbackText text={call.text} />
      </Card>
    )
  }

  // 「查看全文」取到之后整份显示(滚动容器兜着),digest 正文退居其后。
  const shown = full.fullText ?? text
  const truncated = full.fullText === undefined && text.length > PREVIEW_CHARS
  return (
    <Card
      title="转成文字"
      badge={
        <>
          {branch !== undefined ? <Badge text={BRANCH_LABEL[branch] ?? branch} /> : null}
          {digested ? <Badge text="要点摘要" /> : null}
          {digestFailed ? <Badge text="压缩失败·原文截断" tone="error" /> : null}
          <OnScreenRow data={call.data} />
        </>
      }
    >
      <ItemHead data={call.data} item={item} />
      {digested && fullTextChars !== undefined ? (
        <Muted>{`全文共 ${fullTextChars} 字，以下是要点${digestFailed ? '（压缩失败，以下为截断原文）' : ''}`}</Muted>
      ) : null}
      <div
        style={{
          fontSize: 13,
          lineHeight: '20px',
          maxHeight: 320,
          overflow: 'auto',
          overflowWrap: 'anywhere',
          whiteSpace: 'pre-wrap',
        }}
      >
        {truncated ? `${shown.slice(0, PREVIEW_CHARS)}…` : shown}
      </div>
      {digested && fullTextChars !== undefined
        ? null // digest 档的字数已经在上面那行 Muted 里说清楚了，不重复报摘要自身的截断字数
        : truncated
          ? <Muted>{`共 ${text.length} 字，上面是开头 ${PREVIEW_CHARS} 字`}</Muted>
          : null}
      {digested && item !== undefined && full.fullText === undefined ? (
        <button
          type="button"
          onClick={full.load}
          disabled={full.state === 'loading'}
          style={{
            alignSelf: 'flex-start',
            background: 'none',
            border: 'none',
            padding: 0,
            fontSize: 12,
            cursor: 'pointer',
            color: 'var(--muted-foreground, #888)',
            textDecoration: 'underline',
          }}
        >
          {full.state === 'loading' ? '取全文中…' : full.state === 'error' ? '取全文失败,点击重试' : '查看全文'}
        </button>
      ) : null}
      <OnScreenText data={call.data} />
    </Card>
  )
}
