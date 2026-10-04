/**
 * DSH 设置里的「Stream」分区——包/插件的安装启停、凭据、日志、更新，以及组件（Provider）行。
 *
 * **为什么这些东西在设置里，而不是在侧栏或某个频道里**：频道自己的配置已经回到频道里了
 * （各 Present 顶栏下的「配置」分页）。剩下这一堆是**全局**的：它们不属于任何一个频道，也不
 * 属于任何一次会话。侧栏回答的是"我要看什么"，把"我要装什么"混进去是语义错位；DSH 的设置
 * 里本来就住着它自己的插件清单，用户找这类东西的地方因此是一致的。
 *
 * 正文不在这个包里：它是 `panel-manage` 那份独立 IIFE bundle（Tailwind + acrylic 那一套住在
 * `app/`，这个插件包里没有那份 CSS，搬过来只会是没样式的骨架）。这里只负责给它一个容器、
 * 在分区卸载时收回去。同一套做法与主面板一致（见 `panel/host.ts`）。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { mountManageInto } from '../panel/manage-host.ts'
import { BACKEND_MISSING_MESSAGE } from '../backend.ts'

export function makeStreamSettingsSection(backend: string | undefined): () => ReactNode {
  return function StreamSettingsSection(): ReactNode {
    const containerRef = useRef<HTMLDivElement>(null)
    const [error, setError] = useState<string | undefined>(undefined)

    useEffect(() => {
      if (backend === undefined || containerRef.current === null) return
      let cancelled = false
      let mounted: { unmount: () => void } | undefined
      mountManageInto(containerRef.current, backend)
        .then((handle) => {
          // 分区在 bundle 还在路上时就被切走了：立刻收掉，别把一棵树挂进一个已经不在的容器。
          if (cancelled) { handle.unmount(); return }
          mounted = handle
        })
        .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
      return () => {
        cancelled = true
        // 延到微任务再卸：卸载常常是内层那棵树自己的一次事件触发的，站在调用栈里同步
        // unmount 会撞 "Attempted to synchronously unmount a root while React was already
        // rendering"（面板那几处同样的处理）。
        const toUnmount = mounted
        if (toUnmount !== undefined) queueMicrotask(() => { toUnmount.unmount() })
      }
    }, [])

    if (backend === undefined) {
      return <div style={{ padding: 24, fontSize: 13, opacity: 0.7 }}>{BACKEND_MISSING_MESSAGE}</div>
    }
    return (
      <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
        {/* 这里**不要**再加一条「Stream」标题——设置侧栏里那一格已经是这张面的名字，正文
            顶上再写一遍就是同一块屏幕上两个标题在争身份（「Agent 预设」那种 h2 试过，撤了）。 */}
        <div ref={containerRef} style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }} />
        {error !== undefined ? (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center', fontSize: 13, color: 'var(--dsw-alias-state-error-primary, #d33)' }}>
            运维页加载失败：{error}
          </div>
        ) : null}
      </div>
    )
  }
}
