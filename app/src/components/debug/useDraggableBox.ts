import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { animate } from 'motion/react'

export interface BoxPos { x: number; y: number }

/** 松手后按指数衰减把手势"扔"出去的落点（Designing Fluid Interfaces 的原式，不是课本的 v²/2a）。 */
function project(velocity: number, decelerationRate = 0.998): number {
  return (velocity / 1000) * decelerationRate / (1 - decelerationRate)
}

/** 越界后越拖越沉，而不是硬顶住——硬停读起来像"卡死了"，渐进阻力读起来像"到头了"。 */
function rubberband(overshoot: number, dimension: number, constant = 0.55): number {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot))
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v))
}

/**
 * 可拖拽浮窗的手感：按下即跟手（1:1，尊重抓取偏移）、越界回弹、松手带着速度投掷并吸附到最近的
 * 屏幕横边，全程可打断。
 *
 * 为什么值得单独写：原来的实现只有 1:1 跟随——松手即停。那是"能拖"，不是"跟手"；iOS 的画中画
 * 窗口是同一个交互，甩一下它会顺着飞出去并贴边。三件事缺一不可：投掷落点(project)、边界软阻力
 * (rubberband)、以及把释放速度交接给 spring 的初速度（否则拖拽与动画之间有一道可见的接缝）。
 *
 * 减少动态效果(prefers-reduced-motion)时直接跳到终点，不做投掷。
 */
export function useDraggableBox({
  storageKey,
  margin = 16,
  /** 至少要露出多少像素，免得整块被拖出屏幕外找不回来。 */
  keepVisible = { x: 80, y: 40 },
}: {
  storageKey: string
  margin?: number
  keepVisible?: { x: number; y: number }
}) {
  const [pos, setPos] = useState<BoxPos | null>(() => {
    try {
      const raw = localStorage.getItem(storageKey)
      return raw ? (JSON.parse(raw) as BoxPos) : null
    } catch {
      return null
    }
  })

  const grab = useRef<{ dx: number; dy: number; w: number; h: number } | null>(null)
  const samples = useRef<{ x: number; y: number; t: number }[]>([])
  const running = useRef<ReturnType<typeof animate>[]>([])
  const reduced = useRef(false)

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    reduced.current = mq.matches
    const onChange = () => { reduced.current = mq.matches }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  const stopAnimations = useCallback(() => {
    for (const a of running.current) a.stop()
    running.current = []
  }, [])

  const onPointerDown = useCallback((e: ReactPointerEvent) => {
    const box = (e.currentTarget as HTMLElement).parentElement
    if (!box) return
    // 抓住一个正在飞的窗口就应该立刻停在它当下的位置，而不是等它飞完——可打断是第一原则。
    stopAnimations()
    const rect = box.getBoundingClientRect()
    grab.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top, w: rect.width, h: rect.height }
    samples.current = [{ x: e.clientX, y: e.clientY, t: e.timeStamp }]
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }, [stopAnimations])

  const onPointerMove = useCallback((e: ReactPointerEvent) => {
    const g = grab.current
    if (!g) return
    samples.current.push({ x: e.clientX, y: e.clientY, t: e.timeStamp })
    if (samples.current.length > 5) samples.current.shift()

    const maxX = window.innerWidth - keepVisible.x
    const maxY = window.innerHeight - keepVisible.y
    const rawX = e.clientX - g.dx
    const rawY = e.clientY - g.dy
    const soft = (raw: number, lo: number, hi: number, dim: number) => {
      if (raw < lo) return lo + rubberband(raw - lo, dim)
      if (raw > hi) return hi + rubberband(raw - hi, dim)
      return raw
    }
    setPos({
      x: soft(rawX, 0, maxX, window.innerWidth),
      y: soft(rawY, 0, maxY, window.innerHeight),
    })
  }, [keepVisible.x, keepVisible.y])

  const onPointerUp = useCallback((e: ReactPointerEvent) => {
    const g = grab.current
    grab.current = null
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId) } catch { /* 已释放 */ }
    if (!g) return

    // 速度取最近两个采样点（px/s）。用一小段历史而不是单帧差，免得最后一帧的抖动主导方向。
    const s = samples.current
    const first = s[0]
    const last = s[s.length - 1]
    const dt = last && first ? Math.max(1, last.t - first.t) : 1
    const vx = last && first ? ((last.x - first.x) / dt) * 1000 : 0
    const vy = last && first ? ((last.y - first.y) / dt) * 1000 : 0

    const maxX = window.innerWidth - g.w - margin
    const maxY = window.innerHeight - g.h - margin
    const cur = { x: last ? last.x - g.dx : 0, y: last ? last.y - g.dy : 0 }

    // 投掷落点决定贴哪一边——不是从"松手那一刻的位置"就近判，而是从"这一甩要去哪儿"判。
    const projectedX = cur.x + project(vx)
    const projectedCenter = projectedX + g.w / 2
    const targetX = projectedCenter < window.innerWidth / 2 ? margin : maxX
    const targetY = clamp(cur.y + project(vy), margin, Math.max(margin, maxY))
    const target = { x: clamp(targetX, margin, Math.max(margin, maxX)), y: targetY }

    const persist = () => {
      try { localStorage.setItem(storageKey, JSON.stringify(target)) } catch { /* 隐私模式 */ }
    }

    if (reduced.current) {
      setPos(target)
      persist()
      return
    }

    // X / Y 各跑一条 spring：合成一条 2D spring 会在两轴速度不同时失步。
    // damping 0.8 / response 0.4 —— 手势自带动量，这里该有一点点过冲（对齐 --acr-spring-bounce）。
    const spring = { type: 'spring', bounce: 0.2, duration: 0.4 } as const
    running.current = [
      animate(cur.x, target.x, { ...spring, velocity: vx, onUpdate: (v) => setPos((p) => ({ x: v, y: p?.y ?? target.y })) }),
      animate(cur.y, target.y, { ...spring, velocity: vy, onUpdate: (v) => setPos((p) => ({ x: p?.x ?? target.x, y: v })) }),
    ]
    persist()
  }, [margin, storageKey])

  useEffect(() => stopAnimations, [stopAnimations])

  return { pos, setPos, dragHandlers: { onPointerDown, onPointerMove, onPointerUp } }
}
