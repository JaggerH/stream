import { describe, it, expect } from 'vitest'
import { Context } from 'cordis'
import { createKernel, quiesceKernel } from './context.ts'

describe('kernel context', () => {
  it('runs effect disposers on dispose', async () => {
    const kernel = createKernel()
    let disposed = 0
    kernel.effect(() => () => { disposed++ })
    expect(disposed).toBe(0)
    await quiesceKernel(kernel)
    expect(disposed).toBe(1)
  })

  it('revokes a plugin-registered effect when the tree is disposed', async () => {
    const kernel = createKernel()
    let disposed = 0
    let applied = 0
    await kernel.plugin((ctx: Context) => {
      applied++
      ctx.effect(() => () => { disposed++ })
    })
    expect(applied).toBe(1)
    expect(disposed).toBe(0)
    await quiesceKernel(kernel)
    expect(disposed).toBe(1)
  })

  it('is the one and only cordis Context in the dependency graph', async () => {
    // 唯一性守卫（`pnpm ls cordis` 的纯代码等价物）：两份 cordis 副本会让 `instanceof` 失败，
    // 而症状是「服务注册上去了、inject 永远 PENDING」这种查不出来的静默错位。
    const { Context: Imported } = await import('cordis')
    expect(createKernel()).toBeInstanceOf(Imported)
    expect(Imported).toBe(Context)
  })
})
