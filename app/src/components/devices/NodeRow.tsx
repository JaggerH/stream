import { useState, type ReactNode } from 'react'
import type { NodeRow as Node } from '../../lib/api.ts'
import { nodeTitle } from './identities.ts'

/** 面板预置的两个环境（browser-identity D4）。环境是自由文本，这两个只是省得手打。 */
export const ENV_PRESETS = ['工作', '个人'] as const

const CUSTOM = '__custom'


/** 环境下拉的选项：预置两项 + 别的节点上已经在用的（去重，预置在前）。 */
export function environmentOptions(inUse: Iterable<string>): string[] {
  return [...new Set([...ENV_PRESETS, ...inUse])]
}

const ctl = 'rounded border border-[var(--acr-border-soft)] bg-transparent px-1.5 py-0.5 text-[11px]'

/**
 * 设备卡片下的一行浏览器：一个 Chrome profile 里的 Stream 扩展（browser-identity D1）。
 *
 * 名字可改（`label`，清空回到 profile 名）；环境是下拉——「未标」、预置的「工作」「个人」、别的节点上
 * 已在用的，外加「自定义…」现打一个。改动立刻 PATCH，失败由上层 toast 后端原话、再重读。
 *
 * `actions` 是这一行右侧的按钮（设为默认、撤销），由上层给：本机节点没有可撤销的配对，配对设备有。
 */
export function NodeRow({ node, fallbackName, environments, onPatch, actions }: {
  node: Node
  /** 节点没认领、也没起名时的显示名（配对绑定的名字）。 */
  fallbackName?: string
  /** 别的节点上在用的环境，进下拉。 */
  environments: string[]
  onPatch: (patch: { label?: string | null; environment?: string | null }) => void
  actions?: ReactNode
}) {
  const title = nodeTitle(node, fallbackName)
  const [renaming, setRenaming] = useState(false)
  const [customEnv, setCustomEnv] = useState(false)
  const options = environmentOptions([...environments, ...(node.environment ? [node.environment] : [])])

  return (
    <li className="space-y-1 text-[11px]">
      <div className="flex items-center gap-2">
        <span className={`size-1.5 shrink-0 rounded-full ${node.online ? 'bg-emerald-400' : 'bg-muted-foreground/40'}`} />
        {renaming ? (
          <input
            aria-label={`${title} 的名字`}
            autoFocus
            defaultValue={node.label ?? ''}
            placeholder={node.profileName ?? fallbackName ?? '名字'}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setRenaming(false)
              if (e.key !== 'Enter') return
              setRenaming(false)
              const v = e.currentTarget.value.trim()
              if (v !== (node.label ?? '')) onPatch({ label: v || null })
            }}
            onBlur={() => setRenaming(false)}
            className={`${ctl} min-w-0 flex-1`}
          />
        ) : (
          <span className="min-w-0 flex-1 truncate">
            {title}
            {/* 起了名字时 profile 名还要看得见：认领、唤起、运行记录里说的都是它。 */}
            {node.label && node.profileName && <span className="text-muted-foreground"> · {node.profileName}</span>}
            {node.profileDir && <span className="text-muted-foreground">（{node.profileDir}）</span>}
          </span>
        )}
        {!renaming && (
          <button type="button" aria-label={`${title} 改名`} onClick={() => setRenaming(true)} className="text-muted-foreground hover:text-foreground">
            改名
          </button>
        )}
        {customEnv ? (
          <input
            aria-label={`${title} 的环境`}
            autoFocus
            placeholder="环境名，回车保存"
            onKeyDown={(e) => {
              if (e.key === 'Escape') setCustomEnv(false)
              if (e.key !== 'Enter') return
              setCustomEnv(false)
              const v = e.currentTarget.value.trim()
              if (v && v !== node.environment) onPatch({ environment: v })
            }}
            onBlur={() => setCustomEnv(false)}
            className={`${ctl} w-28`}
          />
        ) : (
          <select
            aria-label={`${title} 的环境`}
            value={node.environment ?? ''}
            onChange={(e) => {
              const v = e.target.value
              if (v === CUSTOM) { setCustomEnv(true); return }
              onPatch({ environment: v || null })
            }}
            className={ctl}
          >
            <option value="">未标环境</option>
            {options.map((e) => <option key={e} value={e}>{e}</option>)}
            <option value={CUSTOM}>自定义…</option>
          </select>
        )}
        {node.isDefault && <span className="rounded bg-foreground/10 px-1.5">默认</span>}
        {actions}
      </div>
    </li>
  )
}
