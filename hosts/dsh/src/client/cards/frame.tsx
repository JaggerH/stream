/**
 * 五张卡共用的骨架。刻意只用**内联样式 + DSH 自己的 CSS 变量**（`--dsw-alias-*`，和
 * `dsh-client-ui-skill` 的行卡同一套），不引 CSS module：
 *   - 变量随工作台主题走，深浅色不用我们操心；
 *   - 不引 CSS module 就不需要复刻 DSH 内部的 tsdown CSS 插件（那是它 monorepo 私有的）。
 */
import type { ReactNode } from 'react'

/** 卡片外框：一行标题 + 正文。 */
export function Card({ title, badge, children }: { title: string; badge?: ReactNode; children: ReactNode }): ReactNode {
  return (
    <div
      data-stream-card={title}
      style={{
        border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.25))',
        borderRadius: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        margin: '4px 0',
        padding: '10px 12px',
      }}
    >
      <div style={{ alignItems: 'center', display: 'flex', gap: 8, minWidth: 0 }}>
        <span style={{ color: 'var(--dsw-alias-label-secondary, inherit)', fontSize: 14, fontWeight: 500 }}>{title}</span>
        {badge}
      </div>
      {children}
    </div>
  )
}

/** 状态角标（running / 报错 / 分支名）。 */
export function Badge({ text, tone = 'muted' }: { text: string; tone?: 'muted' | 'error' }): ReactNode {
  return (
    <span
      style={{
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.2))',
        borderRadius: 999,
        color:
          tone === 'error'
            ? 'var(--dsw-alias-state-error-primary, #d33)'
            : 'var(--dsw-alias-label-caption, inherit)',
        fontSize: 11,
        lineHeight: '16px',
        padding: '0 6px',
      }}
    >
      {text}
    </span>
  )
}

/**
 * 一条回 Stream 的深链。`target="_blank"` —— 工作台和 Stream 是两个面，别把工作台顶掉。
 *
 * `href` 可以是 `undefined`（后端地址没下发，见 `src/deep-links.ts`）：那时降级成不可点的
 * 纯文本，而**不是**一个指向别处的死链——点开一个 404 比看见一行灰字更难排查。
 */
export function DeepLink({ href, children }: { href: string | undefined; children: ReactNode }): ReactNode {
  if (href === undefined) {
    return (
      <span
        title="Stream 后端地址没有下发，暂时打不开"
        style={{ color: 'var(--dsw-alias-label-tertiary, #888)', fontSize: 13 }}
      >
        {children}
      </span>
    )
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      style={{ color: 'var(--dsw-alias-label-link, #4a90d9)', fontSize: 13, textDecoration: 'none' }}
    >
      {children}
    </a>
  )
}

/**
 * 数据读不出来时的最后一档：把原始文本原样摆出来。
 * **每张卡都必须有它** —— 结构变了要看得见原文，而不是看见一张空卡（更不能抛）。
 */
export function FallbackText({ text }: { text: string }): ReactNode {
  return (
    <pre
      data-stream-fallback=""
      style={{
        color: 'var(--dsw-alias-label-secondary, inherit)',
        fontSize: 12,
        margin: 0,
        maxHeight: 240,
        overflow: 'auto',
        overflowWrap: 'anywhere',
        whiteSpace: 'pre-wrap',
      }}
    >
      {text === '' ? '(无输出)' : text}
    </pre>
  )
}

/** 副文本（时间、作者、来源）。 */
export function Muted({ children }: { children: ReactNode }): ReactNode {
  return <span style={{ color: 'var(--dsw-alias-label-tertiary, inherit)', fontSize: 12 }}>{children}</span>
}
