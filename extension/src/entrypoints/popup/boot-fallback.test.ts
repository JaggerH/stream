import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { showBootError, dismissWhenMounted } from './boot-fallback.ts'

const here = dirname(fileURLToPath(import.meta.url))
const html = readFileSync(join(here, 'index.html'), 'utf8')

/**
 * 这一组钉的是**「点了扩展图标什么都没弹」**那个缺陷本身。
 *
 * Chrome 把 action popup 的尺寸算成文档的尺寸，所以 `#root` 空着 ⇒ 340×0 ⇒ 屏幕上和
 * "根本没弹出来"一模一样。而 `#root` 空着是真实状态：dev 构建的每个 script 都指向 Vite
 * dev server，`pnpm dev` 没跑时它们全部加载失败，React 一行都不执行（实测 2026-09-08）。
 *
 * 所以 index.html **自己**必须带一份看得见的东西，且它不能依赖任何 JS——
 * 这几条断言就是那份不变量，删掉兜底或把它挪进 `#root` 都会当场变红。
 */
describe('popup 的静态兜底：JS 一行没跑也必须看得见', () => {
  it('#boot-fallback 存在，且在 #root 之外（在里面会被 React 挂载时清掉）', () => {
    expect(html).toContain('id="boot-fallback"')
    const rootAt = html.indexOf('<div id="root"></div>')
    expect(rootAt).toBeGreaterThan(-1) // #root 必须是空标签，兜底不能塞在它里面
    expect(html.indexOf('id="boot-fallback"')).toBeGreaterThan(rootAt)
  })

  it('整个 body 里只有一个 script，就是那个入口 —— 兜底不许依赖任何 JS', () => {
    // MV3 扩展页的 CSP 只允许 `script-src 'self'`：内联 script 会被直接拒掉。而"兜底本身
    // 需要 JS"恰好是这里最不能有的假设——JS 跑不起来正是它要罩的那个故障。
    const body = html.slice(html.indexOf('<body>'), html.indexOf('</body>'))
    expect(body.match(/<script/g)).toHaveLength(1)
    expect(body).toContain('<script type="module" src="./main.tsx">')
  })

  it('诊断段的延迟显示走 CSS 动画，不靠计时器', () => {
    expect(html).toMatch(/animation:\s*bf-in/)
    expect(html).toContain('@keyframes bf-in')
  })

  it('body 有非零 min-height —— 兜底万一也被摘了，弹窗仍然看得见', () => {
    expect(html).toMatch(/body\s*\{[^}]*min-height:\s*[1-9]/)
  })

  it('给报错留了落点', () => {
    expect(html).toContain('id="boot-error"')
  })
})

// ── 下面两组用手搓的极小 DOM 替身：本仓库的扩展测试跑在 node 环境（没有 jsdom，
//    而 worktree 里不许加依赖）。替身只实现被测代码真正用到的那几个成员。 ──

interface FakeEl {
  id: string
  textContent: string | null
  childElementCount: number
  removed?: boolean
  remove(): void
}

function fakeDoc(ids: Record<string, FakeEl>) {
  return { getElementById: (id: string) => ids[id] ?? null } as unknown as Document
}

function el(id: string, childElementCount = 0): FakeEl {
  const e: FakeEl = {
    id,
    textContent: '',
    childElementCount,
    remove() {
      e.removed = true
    },
  }
  return e
}

describe('showBootError', () => {
  it('把报错写进 #boot-error', () => {
    const slot = el('boot-error')
    showBootError(new TypeError('Failed to fetch dynamically imported module'), fakeDoc({ 'boot-error': slot }))
    expect(slot.textContent).toContain('TypeError')
    expect(slot.textContent).toContain('Failed to fetch')
  })

  it('多个报错追加而不是互相覆盖（module 加载失败会一口气发好几个）', () => {
    const slot = el('boot-error')
    const doc = fakeDoc({ 'boot-error': slot })
    showBootError('first', doc)
    showBootError('second', doc)
    expect(slot.textContent).toBe('first\nsecond')
  })

  it('兜底已被摘掉时什么都不做，不抛', () => {
    expect(() => showBootError('x', fakeDoc({}))).not.toThrow()
  })
})

describe('dismissWhenMounted', () => {
  let observers: { cb: () => void; disconnected: boolean }[]
  const RealMO = globalThis.MutationObserver

  beforeEach(() => {
    observers = []
    // @ts-expect-error 测试替身：只实现 observe/disconnect
    globalThis.MutationObserver = class {
      private rec: { cb: () => void; disconnected: boolean }
      constructor(cb: () => void) {
        this.rec = { cb, disconnected: false }
        observers.push(this.rec)
      }
      observe() {}
      disconnect() {
        this.rec.disconnected = true
      }
    }
  })
  afterEach(() => {
    globalThis.MutationObserver = RealMO
  })

  it('#root 已经有内容 ⇒ 立刻摘掉兜底', () => {
    const fallback = el('boot-fallback')
    dismissWhenMounted(fakeDoc({ root: el('root', 1), 'boot-fallback': fallback }))
    expect(fallback.removed).toBe(true)
    expect(observers).toHaveLength(0)
  })

  it('#root 还空着 ⇒ 先不摘，等真的长出东西才摘', () => {
    // 这一条是核心：判据必须是"DOM 真的有东西了"，不是"render() 调用返回了"——
    // createRoot().render() 是排期的，按调用返回就摘会摘出一个隐形弹窗的窗口期。
    const root = el('root', 0)
    const fallback = el('boot-fallback')
    dismissWhenMounted(fakeDoc({ root, 'boot-fallback': fallback }))
    expect(fallback.removed).toBeUndefined()

    observers[0].cb() // 一次无关的 mutation：还是空的，不能摘
    expect(fallback.removed).toBeUndefined()

    root.childElementCount = 1
    observers[0].cb()
    expect(fallback.removed).toBe(true)
    expect(observers[0].disconnected).toBe(true)
  })

  it('节点缺失时安静返回，不抛（React 已挂载后再调也是这条）', () => {
    expect(() => dismissWhenMounted(fakeDoc({}))).not.toThrow()
  })
})
