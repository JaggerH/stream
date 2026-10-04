/**
 * `call` 步骤：recipe 中途问外面一件事，把答案绑成参数给后面的步骤用。
 *
 * 这一格是**外泄面**（它把用户屏幕上的东西送出这台机器），所以测试的重点不是"能不能跑通"，
 * 而是**三条边界各自真的有牙**：给不出目的地、送不出别的东西、没申报不许跑。每一条都单独
 * 一例，而且断言的是"被拒绝了"，不是"没崩"。
 */
import { describe, it, expect } from 'vitest'
import { runActions, RecipeGuardError, makeRandom, type PageDriver } from './actions.ts'
import type { RecipeAction } from './recipe.ts'

class ConsultDriver implements PageDriver {
  typed: Array<{ selector: string; text: string }> = []
  shots: string[] = []
  /** null = 这个选择器截不到东西（元素不在） */
  shotResult: string | null = 'BASE64PNG'

  async goto(): Promise<void> {}
  async scrollOnce(): Promise<void> {}
  async openItem(): Promise<void> {}
  async click(): Promise<boolean> { return true }
  async back(): Promise<void> {}
  async type(selector: string, text: string): Promise<boolean> {
    this.typed.push({ selector, text })
    return true
  }
  async submit(): Promise<boolean> { return true }
  async sleep(): Promise<void> {}
  async exists(): Promise<boolean> { return true }
  async moveMouse(): Promise<void> {}
  async shotOf(selector: string): Promise<string | null> {
    this.shots.push(selector)
    return this.shotResult
  }
}

/** 没有 shotOf 的驱动——边界 2 的另一半：不许退化成整页截图，要直说不支持。 */
class NoShotDriver extends ConsultDriver {
  shotOf = undefined as unknown as (selector: string) => Promise<string | null>
}

const harvest = { done: false, size: 0 }

const CONSULT: RecipeAction = {
  kind: 'call',
  service: 'ddddocr',
  path: '/ocr',
  input: { shotOf: '#imgValidCode' },
  from: 'text',
  bind: 'code',
}

function run(
  actions: RecipeAction[],
  opts: {
    driver?: PageDriver
    params?: Record<string, string>
    effects?: readonly string[]
    call?: (service: string, path: string, body: { image: string }) => Promise<unknown>
  } = {},
) {
  const driver = opts.driver ?? new ConsultDriver()
  return {
    driver,
    promise: runActions(actions, driver, makeRandom(1), harvest, {
      cookieDomain: 'example.com',
      params: opts.params ?? {},
      effects: opts.effects,
      call: opts.call,
    }),
  }
}

describe('call —— 三条边界各自有牙', () => {
  it('没在 meta.effects 里申报 send ⇒ 拒绝执行', async () => {
    const { promise } = run([CONSULT], {
      effects: ['write'], // 申报了别的，就是没申报这个
      call: async () => ({ text: '8Xk2' }),
    })
    await expect(promise).rejects.toThrow(RecipeGuardError)
    await expect(promise).rejects.toThrow(/meta\.effects/)
  })

  it('宿主没注入出口 ⇒ 硬失败，不是静默跳过', async () => {
    // 静默跳过最坏：后面那步会拿着一个没绑上的 {code} 去填表，看起来像"识别错了"。
    const { promise } = run([CONSULT], { effects: ['send'] })
    await expect(promise).rejects.toThrow(RecipeGuardError)
    await expect(promise).rejects.toThrow(/没有可用的出口/)
  })

  it('驱动不支持只截一个元素 ⇒ 直说不支持，不退化成整页', async () => {
    const { promise } = run([CONSULT], {
      driver: new NoShotDriver(),
      effects: ['send'],
      call: async () => ({ text: '8Xk2' }),
    })
    await expect(promise).rejects.toThrow(/shotOf/)
  })

  it('path 必须是路径不是地址 —— 这是"给不出 URL"那条边界的最后一格', async () => {
    for (const path of ['https://evil.example/collect', 'ocr', '//evil.example/collect']) {
      const { promise } = run([{ ...CONSULT, path }], {
        effects: ['send'],
        call: async () => ({ text: '8Xk2' }),
      })
      await expect(promise, path).rejects.toThrow(/call\.path/)
    }
  })
})

describe('call —— 走通那条路', () => {
  it('截图送出去、答案绑成参数、后面的步骤填得到', async () => {
    const seen: Array<{ service: string; path: string; image: string }> = []
    const params: Record<string, string> = {}
    const { driver, promise } = run(
      [CONSULT, { kind: 'type', selector: '#txtValidCode', text: '{code}' }],
      {
        params,
        effects: ['send'],
        call: async (service, path, body) => {
          seen.push({ service, path, image: body.image })
          return { text: '8Xk2' }
        },
      },
    )
    await promise
    // 送出去的只有那个元素那一块的图
    expect((driver as ConsultDriver).shots).toEqual(['#imgValidCode'])
    expect(seen).toEqual([{ service: 'ddddocr', path: '/ocr', image: 'BASE64PNG' }])
    // 绑进参数袋 ⇒ 后一步的 {code} 被真的填成了识别结果
    expect(params.code).toBe('8Xk2')
    expect((driver as ConsultDriver).typed).toEqual([{ selector: '#txtValidCode', text: '8Xk2' }])
  })

  it('嵌套字段用 getPath 语法取', async () => {
    const params: Record<string, string> = {}
    const { promise } = run([{ ...CONSULT, from: 'result.code' }], {
      params,
      effects: ['send'],
      call: async () => ({ result: { code: 'ZZ99' } }),
    })
    await promise
    expect(params.code).toBe('ZZ99')
  })

  it('元素不在 ⇒ 停，不拿一张空图去问', async () => {
    const driver = new ConsultDriver()
    driver.shotResult = null
    const { promise } = run([CONSULT], {
      driver,
      effects: ['send'],
      call: async () => ({ text: '8Xk2' }),
    })
    await expect(promise).rejects.toThrow(/取不到截图/)
  })

  it('答案里没有要的那一格 ⇒ 停，绝不让后面拿着没填的洞去操作页面', async () => {
    // 这一条是这组里最重要的：绑不上却继续走，表现是"填了个 {code} 字面量进输入框"，
    // 而站点只会说验证码错——排查时看起来像识别不准，实际是根本没识别。
    for (const answer of [{}, { text: '' }, { text: null }]) {
      const { promise } = run([CONSULT], {
        effects: ['send'],
        call: async () => answer,
      })
      await expect(promise, JSON.stringify(answer)).rejects.toThrow(/没有 "text"/)
    }
  })
})
