/**
 * 用户气泡下面那一行操作（时间 + 复制）。
 *
 * ## 为什么这个文件必须存在
 *
 * 接管 `conversation.chat.node` 的 `user` 这一格是**整行**的座位，不是"气泡里那段文字"的
 * 座位——`conversation.*` 这一族里根本没有更窄的那个（槽名全表在 ui-conversation 的
 * `contract/slots.d.ts`）。所以坐下去的那一刻，DSH 挂在这一行里的东西全归我们画；漏掉的
 * 不会报错，只会**消失**。
 *
 * 这不是假想：上一版只画了气泡本身，用户消息的复制按钮**当场就没了**，而 tsc、160 条测试、
 * 我自己在活体上的 DOM 快照三处都没喊——快照是在接管**之后**拍的，看到的正是我删完的样子
 * （用自己的产物当基线量自己，量出来永远是对的）。
 *
 * ## 与 DSH 那份的对应关系
 *
 * 照 `MessageIconActions`（ui-conversation）在 `clock: 'start'` + 无 `onBranch` 那一档的形状：
 * 时间在左、复制在右，复制成功后打勾 1 秒。分支按钮不画——DSH 给用户消息也没给。
 * 图标与剪贴板都用它自己的原语（`IconCopyOutlineRegular` / `writeClipboard`），保证跟对话里其他
 * 行是同一套视觉与同一套剪贴板行为。
 *
 * **复制的是原文，不是屏幕上的字。** 引用在气泡里画成了标记（`「标题」(item:xxx)`，后半截
 * 画淡），但复制出去必须逐字等于当初发出去那一句——粘到另一个对话里才能还原成同一张卡。
 * 所以这里拿的是 content 里的 text 块，不是 DOM 的 textContent。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { IconCheckOutlineRegular, IconCopyOutlineRegular, Tooltip, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'

/** `1756612800000` → `11:35`。DSH 那份还会按"今天/昨天"变花样并吃 i18n，我们只留时分——
 *  借它那套 `formatMessageClock` 要把整条 locale 契约拖进本包，不值当。 */
function clockOf(time: number | undefined): string | undefined {
  if (typeof time !== 'number' || !Number.isFinite(time)) return undefined
  const d = new Date(time)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * 一行操作。
 * @param text - 复制出去的原文（消息的 text 块拼起来）。空串时不画复制按钮——
 *   给一个复制了等于没复制的按钮，比没有更糟。
 * @param time - 消息时刻（epoch ms）；拿不到就不画时间。
 */
export function BubbleActions({ text, time }: { text: string; time?: number | undefined }): ReactNode {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | null>(null)
  const alive = useRef(true)
  useEffect(() => () => {
    // 卸载之后别再 setState：这一行会随会话滚动被回收，而 writeClipboard 是异步的。
    alive.current = false
    if (timer.current !== null) clearTimeout(timer.current)
  }, [])

  const onCopy = useCallback(() => {
    if (copied) return
    void writeClipboard(text).then((ok: boolean) => {
      if (!ok || !alive.current) return
      setCopied(true)
      timer.current = window.setTimeout(() => {
        timer.current = null
        if (alive.current) setCopied(false)
      }, 1000)
    })
  }, [copied, text])

  const stamp = clockOf(time)
  if (stamp === undefined && text === '') return null
  return (
    <div
      data-stream-bubble-actions=""
      style={{ alignItems: 'center', display: 'flex', gap: 6, justifyContent: 'flex-end', minHeight: 24 }}
    >
      {stamp !== undefined && (
        <span style={{ color: 'var(--dsw-alias-label-tertiary, #888)', fontSize: 12 }}>{stamp}</span>
      )}
      {text !== '' && (
        <Tooltip label={copied ? '已复制' : '复制'} side="bottom">
          <button
            type="button"
            aria-label={copied ? '已复制' : '复制'}
            onClick={onCopy}
            style={{
              alignItems: 'center',
              background: 'none',
              border: 'none',
              borderRadius: 6,
              color: 'var(--dsw-alias-label-tertiary, #888)',
              cursor: 'pointer',
              display: 'flex',
              padding: 4,
            }}
          >
            {copied ? <IconCheckOutlineRegular /> : <IconCopyOutlineRegular />}
          </button>
        </Tooltip>
      )}
    </div>
  )
}
