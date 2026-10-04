/**
 * 8900 的独立正门——没有任何对话宿主时用户看到的那张脸。
 *
 * 钉的都是"没了就没人发现"的东西：主面板与管理面板两份 bundle 都真的被注入、挂载时
 * `manageWidth:false`（壳态宽度，否则面板把自己压成 420px 的侧栏）、明暗属性名与
 * `hostTheme.ts` 逐字相同（分家 = 独立页永远浅色，零报错）、取资源的请求不拿到一坨 HTML。
 */
import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { mountStandalonePage } from './standalone-page.ts'
import { HOST_DARK_ATTRIBUTE } from '../../app/src/panel/hostTheme.ts'

function app(): Hono {
  const a = new Hono()
  mountStandalonePage(a)
  return a
}

const html = { headers: { accept: 'text/html,application/xhtml+xml' } }

describe('独立正门', () => {
  it('浏览器来取 / → 200 + HTML', async () => {
    const res = await app().request('/', html)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
  })

  it('SPA 兜底：任意非后端路径都回这张页；后端自己的前缀不吞', async () => {
    expect((await app().request('/channels/abc', html)).status).toBe(200)
    for (const p of ['/api/x', '/_p/x', '/ws', '/panel/panel.js', '/assets/a.js']) {
      const res = await app().request(p, html)
      expect([p, res.status]).toEqual([p, 404])
    }
  })

  it('取资源的请求（不是 text/html）不拿 HTML，回 404 文本', async () => {
    const res = await app().request('/whatever.js')
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).not.toContain('text/html')
  })

  it('页面注入主面板与管理面板两份 bundle，并按壳态挂主面板', async () => {
    const body = await (await app().request('/', html)).text()
    expect(body).toContain('/panel/panel.js')
    expect(body).toContain('/panel/panel.css')
    expect(body).toContain('/panel/panel-manage.js')
    expect(body).toContain('/panel/panel-manage.css')
    expect(body).toContain('__streamPanel')
    expect(body).toContain('__streamPanelManage')
    expect(body).toContain('manageWidth: false')
  })

  // 脚本只装一次、全局对象此后一直在；样式表是另一个元素。早退如果排在 ensureStylesheet
  // 前面，那份 CSS 一旦不在就再也回不来——表现是整块无样式，零报错。
  it('ensureScript 先保证样式表在场，再走"已经装过"那条早退', async () => {
    const body = await (await app().request('/', html)).text()
    const fn = /const ensureScript = [\s\S]*?\n  \}\)\n/.exec(body)?.[0]
    expect(fn).toBeDefined()
    expect(fn!.indexOf('ensureStylesheet(file)')).toBeLessThan(fn!.indexOf('if (window[global])'))
  })

  // 这张页是一段自包含的 HTML 字符串：里面那段脚本**没有任何编译期检查**（tsc 只看见一个
  // 字符串），写坏一个符号就是整页空白 + 控制台一行 SyntaxError，而后端、测试、类型三处
  // 全绿。`new Function` 只解析不执行，正好当这道闸。
  it('内联脚本语法过得去（它不经任何编译期检查）', async () => {
    const body = await (await app().request('/', html)).text()
    const script = /<script>([\s\S]*?)<\/script>/.exec(body)?.[1]
    expect(script).toBeDefined()
    expect(() => new Function(script!)).not.toThrow()
  })

  // 导航是面板的第二个挂载点（`mountNav`），独立正门把它摆在左列。页面是一段自包含的
  // HTML 字符串，没有可渲染的运行时，所以这里只能对文本断言——它守的是"这一列真的挂上了"。
  it('左列挂面板的导航：有 #nav，内容页调 mountNav', async () => {
    const body = await (await app().request('/', html)).text()
    expect(body).toContain('id="nav"')
    expect(body).toContain('mountNav(nav')
  })

  // 顶栏没了：「Stream」标题、「管理」入口、明暗切换全在导航树自己的 footer 里。留着一条
  // 顶栏就是同一个动作有两个入口，而两处状态没人同步。
  it('没有顶栏——那几个入口都归导航的 footer', async () => {
    const body = await (await app().request('/', html)).text()
    expect(body).not.toContain('id="bar"')
    expect(body).not.toContain('tab-content')
    expect(body).not.toContain('tab-manage')
  })

  it('「管理」与明暗都经 footer 交给导航', async () => {
    const body = await (await app().request('/', html)).text()
    expect(body).toContain('footer: { onManage: openManage, theme }')
    expect(body).toContain('isDark: () => dark')
    expect(body).toContain('toggle: () => {')
  })

  // 管理是盖在内容上的一层，不是另一个页——内容区那棵树从头活到尾。切页那种做法每次
  // 「看一眼设置」都会把滚动位置、正在播的音频、展开的详情全丢掉，而且不报错。
  it('管理是一层弹层：有 #manage / #manage-root，关掉时卸载并清空，Escape 也关', async () => {
    const body = await (await app().request('/', html)).text()
    expect(body).toContain('id="manage"')
    expect(body).toContain('id="manage-root"')
    expect(body).toContain('manageMod?.unmount()')
    expect(body).toContain('manageRoot.replaceChildren()')
    expect(body).toContain("e.key === 'Escape'")
  })

  // 内容区只挂一次：整份脚本里不该出现任何"卸掉主面板/导航"的动作。
  it('内容区挂上就不再卸——没有 unmountNav，也没有对主面板的 unmount', async () => {
    const body = await (await app().request('/', html)).text()
    expect(body).not.toContain('unmountNav')
    expect(body).not.toContain('nav.replaceChildren()')
  })

  it('明暗属性名与 hostTheme.ts 逐字相同', async () => {
    const body = await (await app().request('/', html)).text()
    expect(body).toContain(HOST_DARK_ATTRIBUTE)
    expect(body).toContain('prefers-color-scheme')
    expect(body).toContain("localStorage")
  })

  it('color-scheme 跟主题属性走，不写 light dark（否则滚动条按系统偏好画，浅色下仍是深的）', async () => {
    const body = await (await app().request('/', html)).text()
    expect(body).not.toMatch(/color-scheme:\s*light dark/)
    expect(body).toContain(`:root:has(body[${HOST_DARK_ATTRIBUTE}]) { color-scheme: dark }`)
  })
})
