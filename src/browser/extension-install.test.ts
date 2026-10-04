import { describe, it, expect, vi } from 'vitest'
import {
  installExtension,
  INSTALL_EXTENSION_RECIPE,
  INSTALL_EXTENSION_RECIPE_MAC,
  installRecipeFor,
  agentPlatform,
} from './extension-install.ts'
import {
  EXTENSIONS_TOOLBAR_BUTTON,
  PIN_BUTTON,
  UNPIN_BUTTON,
  DEV_MODE_TOGGLE,
  LOAD_UNPACKED_BUTTON,
  FOLDER_DIALOG_PATH_EDIT,
  FOLDER_DIALOG_CONFIRM,
  FOLDER_DIALOG_TITLES,
  EXTENSIONS_WINDOW_TITLES,
  OMNIBOX,
  BLANK_URL,
  EXTENSIONS_URL,
  FOLDER_PANEL_MESSAGE_MAC,
  CHROME_PROCESS_MAC,
} from './chrome-ext-page.ts'
import type { DesktopDriver, WindowInfo, AppMatch, A11yQuery } from '../replay/desktop-driver.ts'

const BLANK_WIN = 'about:blank - Google Chrome'
const EXT_WIN = '扩展程序 - Google Chrome'
const DLG_WIN = '选择扩展程序目录。'
const LOAD = LOAD_UNPACKED_BUTTON.names[0]
const TOGGLE = DEV_MODE_TOGGLE.names[0]
const PATH_EDIT = FOLDER_DIALOG_PATH_EDIT.names[0]
const CONFIRM = FOLDER_DIALOG_CONFIRM.names[0]
const OMNI = OMNIBOX.names[0]
const PIN = PIN_BUTTON.names[0]
const UNPIN = UNPIN_BUTTON.names[0]
const PUZZLE = EXTENSIONS_TOOLBAR_BUTTON.className
const DIR = 'C:\\data\\extension'
/** 「开发者模式」那个开关在扩展页上**恒在**（开着关着都在）——夹具必须照这个来，
 *  否则「等页面建好」那一步等不到东西。 */
const TOGGLE_ALWAYS = TOGGLE

/** 控件可以只有名字，也可以带 className（工具栏拼图按钮**只**认 className）。 */
type Ctl = string | { name?: string; className?: string }
const ctlName = (c: Ctl) => (typeof c === 'string' ? c : c.name)
const ctlClass = (c: Ctl) => (typeof c === 'string' ? undefined : c.className)

const win = (title: string, process = 'chrome.exe'): WindowInfo => ({
  id: title,
  process,
  title,
  foreground: false,
})

/**
 * 一个可编程的假 Chrome。**控件按窗口分组**——这不是装饰：文件夹对话框是一个独立的顶层窗口
 * （**但进程还是 chrome.exe**，实测——夹具必须照这个来，否则"按进程名就能把对话框排除掉"
 * 这个假前提会让一整类缺陷在测试里静默通过），所以"没换窗就找得到路径框"这种实现必须在这里露馅。
 */
function fakeDriver(script: {
  /** 窗口标题 → 该窗口里存在的控件。空白窗口的地址栏是自动补的 */
  controls: Record<string, Ctl[]>
  /** 一开始就在的窗口；缺省只有空白页那个（扩展页要靠地址栏走过去） */
  windows?: string[]
  /** invoke 这个控件之后，多出这个窗口（模拟弹出对话框） */
  opensOnInvoke?: { control: string; window: string; process?: string }
  /** invoke 这个控件之后，往它所在的窗口里补上这些控件（模拟打开开发者模式） */
  revealsOnInvoke?: { control: string; window: string; controls: string[] }
  /** 空白窗口里的地址栏叫什么；`null` = 它不在（逼出"找不到地址栏"那条路） */
  omniboxName?: string | null
  setValue?: 'ok' | 'refused'
  /** 地址填了、回车了，页面就是不跳 */
  noNavigate?: boolean
}) {
  const calls: string[] = []
  let clock = 1_000_000
  const windows = new Map<string, string>() // title → process
  for (const t of script.windows ?? [BLANK_WIN]) windows.set(t, 'chrome.exe')
  const omni = script.omniboxName === undefined ? OMNI : script.omniboxName
  const controls: Record<string, Ctl[]> = Object.fromEntries(
    Object.entries(script.controls).map(([k, v]) => [k, [...v]]),
  )
  if (omni != null) controls[BLANK_WIN] = [...(controls[BLANK_WIN] ?? []), omni]
  let pendingUrl = ''
  let scope = ''

  const driver = {
    ensureApp: vi.fn(async (spec: unknown) => {
      calls.push(`ensureApp:${JSON.stringify(spec)}`)
      return { running: true, started: false, process: 'chrome.exe' }
    }),
    // **最新的窗口排在最前面**——真机上 `windows()` 走 EnumWindows，回来的是 z 序，刚弹出来
    // 的对话框在最前。按插入序返回会让"候选标题互相包含"这类缺陷在测试里被顺序掩盖掉：
    // 活体上那次误报（装完那一步匹配到了正在关闭的文件夹对话框）在旧夹具下是**绿的**，
    // 只因为扩展页窗口先被插进 Map。
    windows: vi.fn(async () => [...windows].reverse().map(([t, p]) => win(t, p))),
    focusApp: vi.fn(async (m: AppMatch) => {
      calls.push(`focusApp:${m.title ?? ''}`)
      return true
    }),
    scopeWindow: vi.fn(async (m: AppMatch) => {
      calls.push(`scopeWindow:${m.title ?? ''}`)
      scope = m.title ?? ''
      return win(scope)
    }),
    find: vi.fn(async (q: A11yQuery) => {
      // 名字和 className 都要匹配得上——**className 不能当没写**：工具栏那个拼图按钮只有
      // className 认得出来，把它忽略掉的话任何查询都会命中它，测试就再也证明不了顺序。
      const hit = (controls[scope] ?? []).find(
        (c) =>
          (q.name == null || ctlName(c) === q.name) &&
          (q.className == null || ctlClass(c) === q.className) &&
          (q.name != null || q.className != null),
      )
      return {
        elements: hit
          ? [{
              ref: `ref:${ctlName(hit) ?? ctlClass(hit)}`,
              role: q.role ?? 'Button',
              name: ctlName(hit) ?? '',
              className: ctlClass(hit) ?? '',
              rect: { x: 0, y: 0, w: 1, h: 1 },
            }]
          : [],
      }
    }),
    invoke: vi.fn(async (ref: string) => {
      calls.push(`invoke:${ref}`)
      const name = ref.replace(/^ref:/, '')
      if (script.opensOnInvoke?.control === name) {
        windows.set(script.opensOnInvoke.window, script.opensOnInvoke.process ?? 'chrome.exe')
      }
      if (script.revealsOnInvoke?.control === name) {
        const r = script.revealsOnInvoke
        controls[r.window] = [...(controls[r.window] ?? []), ...r.controls]
      }
      return { via: 'invoke' as const, confirmed: true }
    }),
    setValue: vi.fn(async (ref: string, text: string) => {
      calls.push(`setValue:${ref}=${text}`)
      if (script.setValue === 'refused') throw new Error('setValue failed on every pattern')
      pendingUrl = text
      return { via: 'value' as const, confirmed: true }
    }),
    type: vi.fn(async (text: string) => {
      calls.push(`type:${text}`)
      if (text === '\n') {
        if (pendingUrl === EXTENSIONS_URL && !script.noNavigate) {
          windows.delete(BLANK_WIN)
          windows.set(EXT_WIN, 'chrome.exe')
        }
        pendingUrl = ''
      } else pendingUrl = text
      return { via: 'coords' as const, confirmed: true }
    }),
    click: vi.fn(async () => { calls.push('click'); return { via: 'coords' as const } }),
    // 虚拟时钟：sleep 不花真时间但推着 `__now` 走——等窗口按墙钟超时，不给它时钟，"对话框始终
    // 不出现"那条就要真等满超时（CI 上 19.9s 撞 15s 上限）。
    sleep: vi.fn(async (ms: number) => { clock += ms }),
    __now: () => clock,
    readSubtree: vi.fn(async () => []),
    screenshot: vi.fn(async () => null),
    url: vi.fn(async () => 'app#win'),
    moveMouse: vi.fn(async () => ({})),
    scroll: vi.fn(async () => ({})),
    status: vi.fn(async () => {}),
  }
  return { calls, driver: driver as unknown as DesktopDriver, raw: driver }
}

/** 开发者模式已开着的常态：扩展页三个按钮齐、对话框由「加载未打包」点出来（同一个进程）。 */
const happyScript = {
  controls: { [EXT_WIN]: [TOGGLE_ALWAYS, LOAD], [DLG_WIN]: [PATH_EDIT, CONFIRM] },
  opensOnInvoke: { control: LOAD, window: DLG_WIN, process: 'chrome.exe' },
}

const baseDeps = (over: Record<string, unknown>) => ({
  extensionDir: DIR,
  // 钉死环境：这些用例给的是 Windows 路径，不该随跑测试的机器是不是 WSL 而走翻译分支
  isWsl: false,
  waitForConnected: vi.fn(async () => true),
  // 假 driver 的虚拟时钟（见 fakeDriver 的 sleep）
  now: (over.driver as { __now?: () => number } | undefined)?.__now,
  ...over,
}) as unknown as Parameters<typeof installExtension>[0]

describe('代装扩展', () => {
  it('是一条 desktop recipe，不是一套手写驱动代码', () => {
    expect(INSTALL_EXTENSION_RECIPE.kind).toBe('desktop')
    // 动作型：无物可读，所以既不带 observer 也不带 read（别为了过闸伪造一个）
    expect(INSTALL_EXTENSION_RECIPE.allowEmpty).toBe(true)
    expect(INSTALL_EXTENSION_RECIPE.observer).toBeUndefined()
    // 每一步都要能对用户说人话——blocked 的 reason 就是这一句
    expect(INSTALL_EXTENSION_RECIPE.steps.every((s) => !!s.label)).toBe(true)
  })

  it('开发者模式已经开着（「加载未打包」按钮在场）→ 不去点那个开关', async () => {
    const { driver, calls } = fakeDriver(happyScript)
    const out = await installExtension(baseDeps({ driver }))
    expect(out).toEqual({ status: 'connected' })
    expect(calls.some((c) => c.includes(TOGGLE))).toBe(false)
  })

  it('后端在 WSL 里、Chrome 在 Windows 侧 → 填进对话框的是翻译后的 \\\\wsl.localhost 路径，不是 /home/...', async () => {
    const { driver, calls } = fakeDriver(happyScript)
    const winDir = '\\\\wsl.localhost\\Ubuntu\\home\\jagger\\stream\\data\\extension'
    const out = await installExtension(baseDeps({
      driver,
      isWsl: true,
      translateToWindowsPath: (p: string) => (p === DIR ? winDir : undefined),
    }))
    expect(out).toEqual({ status: 'connected' })
    expect(calls.filter((c) => c.startsWith(`setValue:ref:${PATH_EDIT}=`))).toEqual([`setValue:ref:${PATH_EDIT}=${winDir}`])
  })

  it('不在 WSL 里 → 路径原样填，不翻译', async () => {
    const { driver, calls } = fakeDriver(happyScript)
    const out = await installExtension(baseDeps({ driver, isWsl: false, translateToWindowsPath: () => { throw new Error('must not be called') } }))
    expect(out).toEqual({ status: 'connected' })
    expect(calls).toContain(`setValue:ref:${PATH_EDIT}=${DIR}`)
  })

  it('WSL 路径翻不出来 → blocked，reason 指名是路径翻译那一步，对话框里一个字都不填', async () => {
    const { driver, calls } = fakeDriver(happyScript)
    const out = await installExtension(baseDeps({ driver, isWsl: true, translateToWindowsPath: () => undefined }))
    expect(out.status).toBe('blocked')
    expect((out as { reason: string }).reason).toContain('wslpath')
    expect(calls.some((c) => c.startsWith(`setValue:ref:${PATH_EDIT}=`))).toBe(false)
  })

  it('开发者模式没开 → 先点开关，再点「加载未打包」', async () => {
    const { driver, calls } = fakeDriver({
      controls: { [EXT_WIN]: [TOGGLE], [DLG_WIN]: [PATH_EDIT, CONFIRM] },
      revealsOnInvoke: { control: TOGGLE, window: EXT_WIN, controls: [LOAD] },
      opensOnInvoke: { control: LOAD, window: DLG_WIN, process: 'chrome.exe' },
    })
    const out = await installExtension(baseDeps({ driver }))
    expect(out).toEqual({ status: 'connected' })
    expect(calls.indexOf(`invoke:ref:${TOGGLE}`)).toBeLessThan(calls.indexOf(`invoke:ref:${LOAD}`))
  })

  it('点了开关仍然没有「加载未打包」→ blocked 且 reason 指名是哪一步（不许继续往下点）', async () => {
    const { driver, calls } = fakeDriver({ controls: { [EXT_WIN]: [TOGGLE] } })
    const out = await installExtension(baseDeps({ driver }))
    expect(out.status).toBe('blocked')
    expect((out as { reason: string }).reason).toContain(LOAD)
    // 判据是"扩展目录这串没被写到任何地方"——地址栏那一步本来就要打字，不能笼统断言没打过字
    expect(calls.some((c) => c.includes(DIR))).toBe(false)
  })

  it('路径写不进去（setValue 被拒）→ 退回键盘打字', async () => {
    const { driver, calls } = fakeDriver({ ...happyScript, setValue: 'refused' })
    const out = await installExtension(baseDeps({ driver }))
    expect(out).toEqual({ status: 'connected' })
    expect(calls.some((c) => c === `type:${DIR}`)).toBe(true)
  })

  it('对话框是独立顶层窗口——必须换窗过去，否则路径框根本找不到', async () => {
    const { driver, calls } = fakeDriver(happyScript)
    await installExtension(baseDeps({ driver }))
    const scoped = calls.indexOf(`scopeWindow:${DLG_WIN}`)
    expect(scoped).toBeGreaterThan(-1)
    expect(scoped).toBeLessThan(calls.indexOf(`invoke:ref:${CONFIRM}`))
  })

  it('对话框始终没出现 → blocked，reason 指名是它（不去在 Chrome 窗口里瞎找路径框）', async () => {
    const { driver } = fakeDriver({ controls: { [EXT_WIN]: [TOGGLE_ALWAYS, LOAD] } }) // 点了也不弹
    const out = await installExtension(baseDeps({ driver }))
    expect(out.status).toBe('blocked')
    expect((out as { reason: string }).reason).toContain('对话框')
  })

  it('Chrome 的窗口都没出现 → blocked，不去点别人的窗口', async () => {
    const { driver, calls } = fakeDriver({ controls: {}, windows: ['记事本'] })
    const out = await installExtension(baseDeps({ driver }))
    expect(out.status).toBe('blocked')
    expect(calls.some((c) => c.startsWith('invoke:'))).toBe(false)
  })

  /**
   * 这一条钉的是那个实测：**`chrome.exe chrome://extensions/` 开不出任何窗口**（Chrome 静默
   * 丢掉命令行上的 `chrome://`）。回退成"用启动参数打开扩展页"时，它必须变红——否则同一个坑
   * 会以"等窗口超时 + 一句指向界面语言的错误提示"的形状再来一次。
   */
  it('扩展页不许走命令行——启动参数只给普通地址，扩展页靠地址栏走过去', async () => {
    const { driver, calls, raw } = fakeDriver(happyScript)
    const out = await installExtension(baseDeps({ driver }))
    expect(out).toEqual({ status: 'connected' })
    expect(raw.ensureApp).toHaveBeenCalledWith({ args: [BLANK_URL], force: true })
    const wrote = calls.indexOf(`setValue:ref:${OMNI}=${EXTENSIONS_URL}`)
    expect(wrote).toBeGreaterThan(-1)
    expect(calls.indexOf('type:\n')).toBeGreaterThan(wrote)
  })

  it('地址栏找不到 → blocked，绝不把地址盲打给此刻有焦点的东西', async () => {
    const { driver, calls } = fakeDriver({ ...happyScript, omniboxName: null })
    const out = await installExtension(baseDeps({ driver }))
    expect(out.status).toBe('blocked')
    expect((out as { reason: string }).reason).toContain('地址栏')
    expect(calls.some((c) => c === `type:${EXTENSIONS_URL}`)).toBe(false)
  })

  it('地址填了也回车了，但扩展页没出来 → blocked，reason 说的是这一步', async () => {
    const { driver } = fakeDriver({ ...happyScript, noNavigate: true })
    const out = await installExtension(baseDeps({ driver }))
    expect(out.status).toBe('blocked')
    expect((out as { reason: string }).reason).toContain(EXTENSIONS_URL)
  })

  it('步骤都跑完但中继没连上 → needs-chrome-restart，不报「安装失败」', async () => {
    const { driver } = fakeDriver(happyScript)
    const out = await installExtension(baseDeps({ driver, waitForConnected: async () => false }))
    expect(out).toEqual({ status: 'needs-chrome-restart' })
  })

  /**
   * 接管指示条和 `Ctrl+Alt+Esc` 中止都挂在会话租约上，漏了这一层用户就会看着自己的 Chrome
   * 被人操作而屏幕上什么提示都没有。**租约由 `runDesktopRecipe` 从 driver 上取**（那是唯一
   * 的咽喉），所以这里钉的是"整趟确实经过了它"。
   */
  it('整趟裹在会话租约里——漏了就是一趟没人看得见的操作', async () => {
    const { driver, raw } = fakeDriver(happyScript)
    const withSession = vi.fn(<T,>(fn: () => Promise<T>) => fn())
    ;(raw as unknown as { withSession: unknown }).withSession = withSession
    await installExtension(baseDeps({ driver }))
    expect(withSession).toHaveBeenCalledTimes(1)
  })
})

// ── 把图标钉到工具栏 ──
// 装完默认收在拼图菜单里，用户看不见。这三步是"锦上添花"——**跳过不算失败**，但也不能因为
// 假 driver 认不出控件就在测试里被静默跳过：那样这几步等于没有守卫。
describe('固定到工具栏', () => {
  const pinnable = {
    controls: {
      [EXT_WIN]: [TOGGLE_ALWAYS, LOAD, { className: PUZZLE }, PIN],
      [DLG_WIN]: [PATH_EDIT, CONFIRM],
    },
    opensOnInvoke: { control: LOAD, window: DLG_WIN, process: 'chrome.exe' },
  }

  it('装完之后点开拼图菜单、点「固定」、再把菜单收回去', async () => {
    const { driver, calls } = fakeDriver(pinnable)
    const out = await installExtension(baseDeps({ driver }))
    expect(out).toEqual({ status: 'connected' })
    // 拼图按钮走的是**坐标点击**（`fallbackClick`）——UIA invoke 点不开那个气泡，实测。
    // 所以这里数的是 click 不是 invoke；哪天有人把 fallbackClick 摘掉，这一条会变红。
    expect(calls.filter((c) => c === 'click').length).toBe(2) // 打开 + 收回
    expect(calls.indexOf(`invoke:ref:${PIN}`)).toBeGreaterThan(calls.indexOf('click'))
    // 固定必须发生在装完之后——菜单里那一行是装上了才有的
    expect(calls.indexOf(`invoke:ref:${PIN}`)).toBeGreaterThan(calls.indexOf(`invoke:ref:${CONFIRM}`))
  })

  /** 已经固定过时，同一个位置的按钮叫「取消固定…」。**再点一次就是取消固定**——比不做更糟。 */
  it('已经固定过 → 不点（否则就是把它取消固定）', async () => {
    const { driver, calls } = fakeDriver({
      ...pinnable,
      controls: { ...pinnable.controls, [EXT_WIN]: [TOGGLE_ALWAYS, LOAD, { className: PUZZLE }, UNPIN] },
    })
    const out = await installExtension(baseDeps({ driver }))
    expect(out).toEqual({ status: 'connected' })
    expect(calls.some((c) => c === `invoke:ref:${UNPIN}`)).toBe(false)
    expect(calls.some((c) => c === `invoke:ref:${PIN}`)).toBe(false)
  })

  it('界面语言不在候选表里（找不到「固定」）→ 照样报 connected，不因为外观拖垮安装', async () => {
    const { driver } = fakeDriver({
      ...pinnable,
      controls: { ...pinnable.controls, [EXT_WIN]: [TOGGLE_ALWAYS, LOAD, { className: PUZZLE }] },
    })
    expect(await installExtension(baseDeps({ driver }))).toEqual({ status: 'connected' })
  })
})

/**
 * 窗口标题是**包含**匹配（`AppMatch.title`），所以两个 `window` 步骤的候选标题一旦互相包含，
 * 后一步就会匹配上前一步那个窗口——而两个窗口同时在场只发生在活体上，夹具很容易漏掉。
 * 这一条把那个不变量钉死，不依赖任何顺序。
 */
describe('窗口标题候选之间不许互相包含', () => {
  it('文件夹对话框的标题不能匹配上「扩展页窗口」的任何一个候选', () => {
    for (const dlg of FOLDER_DIALOG_TITLES) {
      for (const ext of EXTENSIONS_WINDOW_TITLES) {
        expect(`${dlg}。`.includes(ext), `「${dlg}」含着「${ext}」`).toBe(false)
      }
    }
  })
})

/**
 * macOS 那一条。这些是**真机实测逼出来的不变量**（2026-09-07 / Intel Mac / Chrome 152），
 * 每一条都对应一次真实的踩坑，记录见
 * `docs/superpowers/reports/2026-09-07-mac-desktop-install-verify.md`。
 *
 * **这里钉的是形状，不是行为。** 行为那一半没有单测：上面那个假 Chrome 是照 Windows 的形状
 * 搭的（对话框 = 另一个顶层窗口、控件按窗口分组），而 mac 这条恰恰在这两点上相反——
 * 面板是同一个窗口里的 sheet，路径框由**打字**而不是 invoke 唤出来。要覆盖行为就得给夹具
 * 加一条"打了字之后冒出控件"的路。**没加，所以这里如实只钉形状**——把它说出来，
 * 比让下一个人以为这条 recipe 有行为覆盖要好。它的行为证据在那份活体记录里。
 */
describe('代装扩展（macOS）', () => {
  it('darwin 走 mac 那条；其余（含 WSL 下的 win32、Linux）走 UIA 那条', () => {
    expect(installRecipeFor('darwin')).toBe(INSTALL_EXTENSION_RECIPE_MAC)
    expect(installRecipeFor('win32')).toBe(INSTALL_EXTENSION_RECIPE)
    expect(installRecipeFor('linux')).toBe(INSTALL_EXTENSION_RECIPE)
  })

  // WSL 下后端在 Linux 里、agent 却是 Windows 版——照 process.platform 挑会选出一条
  // 给 Linux 的 recipe，而 Linux 根本没有后端。
  it('WSL：agent 平台算成 win32，不是 linux', () => {
    expect(agentPlatform('linux', true)).toBe('win32')
    expect(agentPlatform('linux', false)).toBe('linux')
    expect(agentPlatform('darwin', false)).toBe('darwin')
  })

  it('每一步都有 label——这条流程的 blocked 是直接给用户看的', () => {
    expect(INSTALL_EXTENSION_RECIPE_MAC.steps.every((s) => !!s.label)).toBe(true)
  })

  it('动作型 recipe：allowEmpty 且不伪造 observer', () => {
    expect(INSTALL_EXTENSION_RECIPE_MAC.allowEmpty).toBe(true)
    expect(INSTALL_EXTENSION_RECIPE_MAC.observer).toBeUndefined()
  })

  // 实测：文件选择面板是 Chrome 窗口里的一个 AXSheet，**不在 AXWindows 里**——换不过去。
  // 照 Windows 那条抄一个「换到对话框窗口」的步骤过来，表现是等窗口直到超时。
  it('绝不试图换到「文件夹对话框窗口」——mac 上那是个 sheet，不是窗口', () => {
    for (const s of INSTALL_EXTENSION_RECIPE_MAC.steps) {
      if (s.kind !== 'window') continue
      for (const t of s.match.titleAnyOf ?? []) {
        for (const dlg of FOLDER_DIALOG_TITLES) {
          expect(t.includes(dlg), `mac recipe 不该有对话框窗口步骤，却有「${t}」`).toBe(false)
        }
      }
    }
  })

  // 实测：macOS 的文件面板上没有路径输入框。敲一个 `/` 唤出「前往文件夹」是唯一的门；
  // 少了它，下一步找 PathTextField 必然空手，而报出来的话会指向"面板没开"——指错方向。
  it('填路径之前必须先敲一个 / 把「前往文件夹」唤出来', () => {
    const steps = INSTALL_EXTENSION_RECIPE_MAC.steps
    const pathIdx = steps.findIndex((s) => s.kind === 'type' && s.text === '{dir}')
    expect(pathIdx).toBeGreaterThan(0)
    const slash = steps.findIndex((s) => s.kind === 'type' && s.text === '/' && !s.query)
    expect(slash, '没有那一步裸敲 /').toBeGreaterThan(-1)
    expect(slash).toBeLessThan(pathIdx)
  })

  // 面板第一次弹出要几秒。早敲的那个 / 会打进它后面的网页里，而这一步照样"成功"。
  it('敲 / 那一步挂着「等面板建好」的前置条件', () => {
    const slash = INSTALL_EXTENSION_RECIPE_MAC.steps.find((s) => s.kind === 'type' && s.text === '/')
    expect(slash?.require?.query).toEqual(FOLDER_PANEL_MESSAGE_MAC)
  })

  // 路径盲打会进到碰巧有焦点的东西里，然后确认按钮把一个错的目录装进去。
  it('填路径那一步 requireTarget——定位不到就停手，绝不盲打', () => {
    const step = INSTALL_EXTENSION_RECIPE_MAC.steps.find((s) => s.kind === 'type' && s.text === '{dir}')
    expect(step && step.kind === 'type' && step.requireTarget).toBe(true)
  })

  // `AppMatch.process` 是全等匹配。写成 chrome.exe 的表现是「没有窗口匹配」。
  it('进程名是「Google Chrome」，一处都不许留 chrome.exe', () => {
    expect(JSON.stringify(INSTALL_EXTENSION_RECIPE_MAC)).not.toContain('chrome.exe')
    expect(INSTALL_EXTENSION_RECIPE_MAC.app.process).toBe(CHROME_PROCESS_MAC)
  })

  // mac 后端对 AX 开头的 role 原样透传；写成 UIA 那套中性词也能跑，但表是照真机 dump 抄的。
  // 这一条防的是"从 Windows 那条复制粘贴过来忘了改 role"——那会让 find 用错的 role 去搜。
  it('所有 role 都是原生 AX 名', () => {
    const roles: string[] = []
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) return v.forEach(walk)
      if (v && typeof v === 'object') {
        for (const [k, val] of Object.entries(v)) {
          if (k === 'role' && typeof val === 'string') roles.push(val)
          else walk(val)
        }
      }
    }
    walk(INSTALL_EXTENSION_RECIPE_MAC.steps)
    expect(roles.length).toBeGreaterThan(0)
    for (const r of roles) expect(r.startsWith('AX'), `role「${r}」不是 AX 名`).toBe(true)
  })
})
