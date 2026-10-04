/**
 * 用户消息那一格的渲染件（`conversation.chat.node` 的 `user` / `steering` 两个 key）。
 *
 * 气泡的样子**照抄 DSH 自己那份**，但用它的 token 重写，不借它的类名：
 * `.gdEzaW_bubble` 那串是 CSS module 的哈希名，DSH 每次构建都会变——借了就是在赌一个
 * 会变的名字，而它失效时不会报错，只会突然变成一坨没样式的字。量到的那份是：
 *
 * ```
 * bubble: background var(--dsw-specific-bubble); color var(--dsw-alias-label-primary);
 *         border-radius 22px; padding 10px 16px; font-size 16px; line-height 24px
 * stack:  flex column; align-items flex-end; max-width min(525px, 82%)
 * ```
 *
 * 里面画什么见 `UserMessage.tsx`；为什么要接这个座位见那份头注。
 */
import type { ReactNode } from 'react'
import { UserMessageBody, plainTextOf, type MessageNodeLike } from './UserMessage.tsx'
import { BubbleActions } from './BubbleActions.tsx'

/** 形状**从 `UserMessage.tsx` 引，不在这里再抄一遍**：抄第二份的代价刚踩过——两处各写各的
 *  `{ content }`，一起写错了一层（真身是 `node.data.content`），而两边互相印证、tsc 无话可说。 */
interface NodeProps {
  node?: MessageNodeLike
}

export function UserMessageNodeView({ node }: NodeProps): ReactNode {
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
      <div style={{ alignItems: 'flex-end', display: 'flex', flexDirection: 'column', maxWidth: 'min(525px, 82%)' }}>
        <div
          data-stream-user-bubble=""
          style={{
            background: 'var(--dsw-specific-bubble, rgba(127,127,127,0.16))',
            borderRadius: 22,
            color: 'var(--dsw-alias-label-primary, inherit)',
            fontSize: 16,
            lineHeight: '24px',
            maxWidth: '100%',
            overflowWrap: 'anywhere',
            padding: '10px 16px',
          }}
        >
          <UserMessageBody node={node ?? {}} />
        </div>
        {/* **坐了这个座位就得把这一行画回来。** 这是整行的座位，DSH 挂在里面的操作行
            （时间 + 复制）随接管一起消失，而且不报错——上一版就这么把它弄丢了。 */}
        <BubbleActions text={plainTextOf(node ?? {})} time={node?.data?.time} />
      </div>
    </div>
  )
}
