// app/src/research/ArtifactView.tsx — 把 view 的 DOM 渲染函数挂进 React 树的唯一入口。
// try/catch 在这一层:单个 view 抛错只画一行红字,绝不向上抛——抛出去会炸整棵树,而详情页上
// 还有另外几十张卡在正常显示。render() 可能返回一个 disposer(timeseries/backtest 的图表实例
// 要靠它释放);捕获返回值,在 effect cleanup 里调用它、再清空节点,并容忍 undefined。
import { useEffect, useRef, type ReactNode } from 'react'
import type { Artifact } from './artifact.ts'
import { getView } from './views/registry.ts'

export function ArtifactView({ artifact, theme }: { artifact: Artifact; theme: 'light' | 'dark' }): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (el === null) return
    el.textContent = ''
    let dispose: (() => void) | undefined
    try {
      dispose = getView(artifact.view)(el, artifact, theme) ?? undefined
    } catch (e) {
      el.textContent = `渲染失败:${e instanceof Error ? e.message : String(e)}`
      el.style.color = 'var(--dsw-alias-state-error-primary, #f87171)'
    }
    return () => {
      dispose?.()
      el.textContent = ''
    }
  }, [artifact, theme])
  return <div ref={ref} style={{ minHeight: 0 }} />
}
