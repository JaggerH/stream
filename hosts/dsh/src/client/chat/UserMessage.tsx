/**
 * 用户消息气泡——**我们自己画**，为的是把里面的 Stream 引用画成卡片。
 *
 * ## 为什么敢接这个座位
 *
 * `conversation.chat.node` 是 keyed 槽，`user` / `steering` 两个 key 由 ui-conversation
 * 占着；同一格可以按 priority 叠，最低的那个渲染（见 ui-slots 的 `register` 文档）。
 * 接过来就意味着**用户消息长什么样从此归我们**，所以先量了一眼活体那个气泡的实际内容：
 *
 * ```
 * userRow > userStack > bubble > text     ← 就这四层，一个按钮都没有
 * ```
 *
 * 没有 fork / 复制 / 编辑那些附件（`ChatNodeOwnerProps.forkAt` 存在，但这一档没画出来），
 * 所以接过来的成本只有「一个气泡的样子」。**这一条要复核**：哪天 DSH 给用户消息加了行内
 * 操作，我们这份会把它吃掉，而且不会有任何一处报错——症状是"那个按钮没了"。
 *
 * ## 画什么
 *
 * 文本里认出 `「标题」(item:xxx)` / `「名字」(stream:xxx)`（文法见 `refs.ts`）→ 画成一枚
 * 卡片式的行内标记：标题正常字号，`(item:xxx)` 那半截画淡画小。
 *
 * **那半截不许省略。** 它不是装饰，是这段结构的全部——复制走的是 `textContent`，卡上
 * 不画 id，粘出去就只剩一个标题，谁也认不出是哪一条（详见 `refs.ts` 头注）。
 */
import type { CSSProperties, ReactNode } from 'react'
import { parseRefs, type RefSegment } from './refs.ts'
import { useRefSnapshot } from './ref-snapshots.ts'

/**
 * 原文那段字**永远留在 DOM 里，但可以不占地方**。
 *
 * 复制这件事有两条路，而它们取的东西不一样：复制按钮取的是消息 content（`plainTextOf`），
 * 拖选 + Ctrl-C 取的是**选区文本**——后者只认 DOM，而且**跳过 `user-select: none` 的部分**。
 * 所以卡片上那些好看的字全部 `user-select: none`，真正的 `「标题」(item:id)` 藏在这个夹子里
 * 参与选区。用 clip 而不是 `display: none`：后者会被选区和复制一起跳过，等于没写。
 */
const CLIPPED: CSSProperties = {
  clipPath: 'inset(50%)',
  height: 1,
  overflow: 'hidden',
  position: 'absolute',
  whiteSpace: 'nowrap',
  width: 1,
}

/** 卡片上的字不进选区——原文由上面那个夹子提供，两边都算进去就会复制出重复的标题。 */
const DECOR: CSSProperties = { userSelect: 'none' }

/**
 * 一枚行内引用。**拿得到显示身份就画成卡片**（封面 + 标题 + 来源），拿不到就退回纯文字标记
 * ——降级是这条路的常态，不是错误：内容被清掉了、后端地址没下发、`stream:` 那种非 item 的
 * 句柄，都会落在这一档，而那时文字里 id 还在，复制粘贴照样还原得回来。
 */
function RefChip({ seg }: { seg: Extract<RefSegment, { kind: 'item' | 'stream' }> }): ReactNode {
  const snap = useRefSnapshot(seg.kind === 'item' ? seg.id : '')
  const literal = `「${seg.label}」(${seg.kind}:${seg.id})`
  const frame: CSSProperties = {
    background: 'var(--dsw-alias-fill-l2, rgba(127,127,127,0.12))',
    border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.2))',
    borderRadius: 8,
  }

  if (snap === undefined) {
    // 纯文字那一档：结构本体照旧看得见（画淡画小），因为这时没有别的东西替它说明「引的是谁」。
    return (
      <span data-stream-ref={seg.kind} title={`${seg.kind}:${seg.id}`} style={{ ...frame, borderRadius: 6, padding: '1px 6px', whiteSpace: 'normal' }}>
        <span style={{ fontWeight: 500 }}>{`「${seg.label}」`}</span>
        <span style={{ color: 'var(--dsw-alias-label-tertiary, #888)', fontSize: '0.85em' }}>
          {`(${seg.kind}:${seg.id})`}
        </span>
      </span>
    )
  }

  const meta = snap.source
  return (
    <span
      data-stream-ref={seg.kind}
      data-stream-ref-card=""
      title={`${seg.kind}:${seg.id}`}
      style={{ ...frame, alignItems: 'flex-start', display: 'inline-flex', gap: 8, maxWidth: '100%', padding: 4, verticalAlign: 'middle' }}
    >
      <span style={CLIPPED}>{literal}</span>
      {snap.poster !== undefined ? (
        <img
          src={snap.poster}
          alt=""
          // 固定尺寸 + object-fit：封面比例千奇百怪（竖屏短视频 9:16、专辑封面 1:1），
          // 不裁就会把整行撑歪。**加载失败自己消失**，不留破图——同 ExtractCard 的 ItemHead。
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
          style={{ ...DECOR, borderRadius: 6, flex: '0 0 auto', height: 40, objectFit: 'cover', width: 40 }}
        />
      ) : null}
      <span style={{ ...DECOR, display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
        <span
          style={{
            WebkitBoxOrient: 'vertical',
            WebkitLineClamp: 3,
            display: '-webkit-box',
            fontSize: 14,
            fontWeight: 500,
            lineHeight: '18px',
            overflow: 'hidden',
            overflowWrap: 'anywhere',
          }}
        >
          {snap.title}
        </span>
        {meta !== undefined ? (
          <span style={{ color: 'var(--dsw-alias-label-tertiary, #888)', fontSize: 12, lineHeight: '16px' }}>{meta}</span>
        ) : null}
      </span>
    </span>
  )
}

/** 一段纯文本里的引用全部画成标记，其余原样。 */
export function RichText({ text }: { text: string }): ReactNode {
  const segs = parseRefs(text)
  return (
    <>
      {segs.map((seg, i) =>
        seg.kind === 'text'
          ? <span key={i}>{seg.text}</span>
          : <RefChip key={i} seg={seg} />)}
    </>
  )
}

/**
 * 消息节点上我们读的那几格。
 *
 * **正文在 `node.data.content`，不在 `node.content`。** 槽递过来的是
 * `ChatNode<Kind> = ChatConversationViewNode & { kind, data }`——`data` 才是那条
 * `UserMessageNode`（DSH 自己的 `UserMessageNodeView` 第一行就是 `const data = node.data`）。
 *
 * 这一格写错过一次，代价值得记：读成 `node.content` 恒 undefined → blocks 恒空 →
 * **气泡的壳、圆角、配色全画对，里面一个字都没有**，零报错。而 tsc 全绿、单测全绿——
 * 因为契约声明（当时是本地手抄的 `chat/slot-contract.d.ts`，那份 `owner: Record<string, unknown>`）、
 * 渲染件、单测夹具**三样都是照同一个错假设写的**。自己写的契约校验自己写的代码，等于没校验。
 * （那份手抄副本在迁到 0.2.0 时删了——`conversation.chat.node` 现在由
 * `@deepseek-ai/dsh-client-ui-chat` 声明，我们直接 import 真身。）
 * 唯一能抓到它的是去看活着的那一页。
 */
export interface MessageNodeLike {
  data?: { content?: readonly unknown[]; time?: number }
}

/**
 * 这条消息的原文（text 块拼起来）——复制按钮送进剪贴板的就是它。
 *
 * **不能拿 DOM 的 textContent 顶替**：气泡里引用是画成标记的，而复制出去必须逐字等于当初
 * 发出去那一句，粘到另一个对话里才还原得回同一张卡。同 DSH 的 `contentParts().text`。
 */
export function plainTextOf(node: MessageNodeLike): string {
  const blocks = Array.isArray(node?.data?.content) ? node.data.content : []
  return blocks
    .map((raw) => {
      const b = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
      return b.type === 'text' && typeof b.text === 'string' ? b.text : ''
    })
    .join('')
}

/**
 * 一条用户消息。
 *
 * 图片块**必须照画**：气泡是我们接管的，漏掉它就是"用户发的图不见了"，而且不报错。
 * 这里只画 DSH 已经解析好的那份 URL；解析不出来的块留一个看得见的占位，不静静吞掉。
 * @param node - DSH 递过来的消息节点（正文在它的 `data.content`）。
 */
export function UserMessageBody({ node }: { node: MessageNodeLike }): ReactNode {
  const blocks = Array.isArray(node?.data?.content) ? node.data.content : []
  // 一条内容都取不出来 → **不许画一个空气泡**。空气泡和"渲染件读错了那一格"长得一模一样，
  // 而后者正是这里踩过的坑：静默的空是这条路上最坏的失败形状，宁可露一句难看的话。
  if (blocks.length === 0) {
    return <span style={{ color: 'var(--dsw-alias-label-tertiary, #888)' }}>[这条消息没有可显示的内容]</span>
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, whiteSpace: 'pre-wrap' }}>
      {blocks.map((raw, i) => {
        const b = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
        if (b.type === 'text' && typeof b.text === 'string') return <RichText key={i} text={b.text} />
        if (b.type === 'image') {
          const src = typeof b.url === 'string' ? b.url : typeof b.dataUrl === 'string' ? b.dataUrl : undefined
          return src !== undefined
            ? <img key={i} src={src} alt="" style={{ borderRadius: 6, maxWidth: '100%' }} />
            : <span key={i} style={{ color: 'var(--dsw-alias-label-tertiary, #888)' }}>[图片]</span>
        }
        // 不认识的块类型（DSH 的 ContentBlockMap 是可扩展的）——**留个痕迹**，
        // 静静跳过等于把用户发的东西吞了。
        return <span key={i} style={{ color: 'var(--dsw-alias-label-tertiary, #888)' }}>{`[${String(b.type ?? '?')}]`}</span>
      })}
    </div>
  )
}
