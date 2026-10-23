import type { NodeRow } from '../../lib/api.ts'
import { nodeTitle } from './NodeRow.tsx'

/**
 * 「Stream 在后台打开着的 profile」（browser-identity D8）。
 *
 * 按身份执行时目标 profile 没开，Stream 会经 Stream Desktop 静默加载它（不开窗）。执行完 Stream 关掉自己的
 * 标签与窗，profile 通常随之卸载、`woken_at` 清空；放不掉时（扩展断了、老扩展）它会一直加载到 Chrome 完全
 * 退出，而 Chrome 的界面里没有任何地方显示它。这一节是唯一能看见它的地方。
 *
 * 没有可做的动作：扩展 API 与命令行都没有「卸载某个 profile」，只能退出 Chrome。所以只列、只说明，
 * 不画按钮。一个都没有时整节不出现。
 */
export function WokenProfiles({ nodes, deviceName }: { nodes: NodeRow[]; deviceName: (deviceId: string) => string }) {
  const woken = nodes.filter((n) => n.wokenAt !== undefined).sort((a, b) => (b.wokenAt ?? 0) - (a.wokenAt ?? 0))
  if (woken.length === 0) return null
  return (
    <section className="space-y-1.5">
      <h3 className="text-[13px] font-semibold">Stream 在后台打开着的 profile</h3>
      <p className="text-[12px] leading-relaxed text-muted-foreground">
        这些 profile 是 Stream 为了执行任务在后台加载的，没有窗口。它们会在 Chrome 完全退出时卸载；要立刻卸载，就完全退出 Chrome（包括托盘里的后台进程）。
      </p>
      <ul className="space-y-1">
        {woken.map((n) => (
          <li key={n.nodeId} className="flex items-center gap-2 rounded-md border border-[var(--acr-border-soft)] px-2.5 py-1.5 text-[12px]">
            <span className={`size-1.5 shrink-0 rounded-full ${n.online ? 'bg-emerald-400' : 'bg-muted-foreground/40'}`} />
            <span className="min-w-0 flex-1 truncate">
              {nodeTitle(n)}
              {n.environment && <span className="text-muted-foreground"> · {n.environment}</span>}
            </span>
            <span className="text-[11px] text-muted-foreground">{deviceName(n.deviceId)}</span>
            <span className="text-[11px] text-muted-foreground">{new Date(n.wokenAt!).toLocaleString()} 唤起</span>
          </li>
        ))}
      </ul>
    </section>
  )
}
