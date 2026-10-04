import { useEffect, useRef, useState, type ComponentType } from 'react'
import { BookmarkIcon, HeartIcon } from 'lucide-react'
import { toast } from '../acrylic/sonner.tsx'

import type { ItemActionIcon, ItemActionView } from '@item/actions.ts'
import { api, LOCAL, type ActionResult } from '../../lib/api.ts'
import { cn } from '../../lib/utils.ts'
import { Button } from '../acrylic/button.tsx'

const POLL_INTERVAL_MS = 800
const POLL_MAX_MS = 30_000

/**
 * 宿主词表里每个图标怎么画：图形 + 按下后的着色。`Record<ItemActionIcon, …>` 让类型逼着补——
 * 词表（`shared/item/actions.ts`）多一个图标而这里没跟上，typecheck 当场红，而不是按钮静默画不出来。
 */
const ICONS: Record<ItemActionIcon, { Icon: ComponentType<{ className?: string }>; pressed: string }> = {
  heart: { Icon: HeartIcon, pressed: 'fill-current text-rose-500' },
  bookmark: { Icon: BookmarkIcon, pressed: 'fill-current text-amber-500' },
}

/**
 * 条目上的可点动作（inbox 卡片 / 列表行 / 详情共用）。**画什么、点了跑哪条 recipe、带什么参数，全由
 * 包声明**——后端把 `stream.item.actions` 投影成 `item.actions`，这里只照着画，不认识任何站。
 *
 * 乐观 UI：点了先翻本地态，再走通用动作路由 `POST /api/recipes/action`（用户当场点的那一下就是
 * 二次确认，所以直接带 `confirmed:true`）；参数 = 声明的 `params` + `action`（未按下发 `toggle[0]`、
 * 已按下发 `toggle[1]`）。回 `running` 就按 `runId` 轮询到终态；**任何不是 `done` 的结局**（业务 /
 * 风控 / 登录墙 / 请求本身失败 / 等超时）都回滚 + toast。
 * **初始态已知限制**：列表只带总数、不带"我是否已按过"，所以一律按未按下起——点一次即以真实往返校正。
 * 计数乐观：只在本地态相对初始态变化时 ±1（响应形状不统一，不作权威回读）。
 */
export function ItemActionButtons({
  actions,
  counts,
  className,
  pollIntervalMs = POLL_INTERVAL_MS,
  pollMaxMs = POLL_MAX_MS,
}: {
  actions: readonly ItemActionView[]
  /** 按动作 id 的初始计数（有才显示数字）。 */
  counts?: Partial<Record<string, number>>
  className?: string
  /** 轮询节拍 / 上限，只给测试缩短用；产品默认 800ms / 30s。 */
  pollIntervalMs?: number
  pollMaxMs?: number
}) {
  const [pressed, setPressed] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)

  /**
   * 卸载信号：轮询循环最长跑 30s，而卡片随时会被滚出虚拟列表卸掉。卸载之后再 setState / toast 是
   * 对一个已经不在的组件说话——React 不报错、用户看到一条不知所属的 toast。cleanup 里 abort，
   * 循环在下一拍看到就静默退出（不回滚、不 toast：没人在看了）。
   */
  const aliveRef = useRef<AbortController | null>(null)
  useEffect(() => {
    const ctrl = new AbortController()
    aliveRef.current = ctrl
    return () => {
      ctrl.abort()
      aliveRef.current = null
    }
  }, [])
  const gone = () => aliveRef.current?.signal.aborted ?? true

  /** 等一拍；卸载时立刻醒（不然一个 800ms 的 timer 会把卸载后的那次 setState 拖到下一拍）。 */
  function tick(): Promise<void> {
    return new Promise((resolve) => {
      const signal = aliveRef.current?.signal
      if (!signal || signal.aborted) return resolve()
      const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, pollIntervalMs)
      function onAbort() { clearTimeout(t); resolve() }
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  /** 把动作路由的回执追到终态：`running` 就轮询 run，跑完后看 `result.status`。抛 = 没做成，message 给用户看。 */
  async function settle(first: ActionResult): Promise<void> {
    if (first.status === 'done') return
    if (first.status !== 'running' || !first.runId) throw new Error(first.reason ?? `动作没做成（${first.status}）`)
    const deadline = Date.now() + pollMaxMs
    while (Date.now() < deadline) {
      await tick()
      if (gone()) return
      const view = await api.actionRun(LOCAL, first.runId)
      if (gone()) return
      if (view.status === 'error') throw new Error(view.error ?? '执行没有正常收尾')
      if (view.status === 'done') {
        // run 跑完 ≠ 动作做成：两层状态，result.status 才是动作的成败。
        const result = view.result
        if (result?.status === 'done') return
        throw new Error(result?.reason ?? `动作没做成（${result?.status ?? '无回执'}）`)
      }
    }
    throw new Error('动作还没跑完，结果未知——去页面上核一眼再决定要不要再点一次')
  }

  async function toggle(a: ItemActionView) {
    if (busy) return
    const cur = !!pressed[a.id]
    const apply = (v: boolean) => setPressed((p) => ({ ...p, [a.id]: v }))
    apply(!cur) // 乐观
    setBusy(true)
    try {
      const first = await api.runAction(LOCAL, {
        sourceId: a.recipe,
        params: { ...a.params, action: cur ? a.toggle[1] : a.toggle[0] },
        confirmed: true,
      })
      await settle(first)
    } catch (e) {
      if (gone()) return
      apply(cur) // 回滚
      toast.error(`${a.label}失败`, { description: e instanceof Error ? e.message : '' })
    } finally {
      if (!gone()) setBusy(false)
    }
  }

  if (!actions.length) return null
  return (
    <>
      {actions.map((a) => {
        const on = !!pressed[a.id]
        const { Icon, pressed: pressedCls } = ICONS[a.icon]
        const base = counts?.[a.id]
        const shown = base == null ? null : base + (on ? 1 : 0)
        const name = on ? `取消${a.label}` : a.label
        return (
          <Button
            key={a.id}
            variant="neutral"
            size="small"
            aria-pressed={on}
            aria-label={name}
            title={name}
            className={className}
            onClick={(event) => {
              event.stopPropagation()
              void toggle(a)
            }}
          >
            <Icon className={cn(on && pressedCls)} />
            {shown}
          </Button>
        )
      })}
    </>
  )
}
