/**
 * **升级闸门**（spec 2026-08-17 §5 条 4）。
 *
 * 当前钉住的是 **DSH 0.2.0-rc.2**（迁移记录：`44e770ae` 0.1.2-rc.1 → 本条）。
 *
 * 本包消费的 DSH 公共面共四个：`dsh-client-ui-slots` 的槽注册契约 + `dsh-client-ui-tool`
 * 声明的 `tool.call.toolview` 槽与它的 owner payload + `dsh-client-ui-sidebar` 声明的
 * `sidebar.footer.action` 槽（面板开关按钮挂在这里）。DSH 明说 preview 期会破坏性
 * 变更——所以版本钉死，升到 rc.7 时**先让这条测试红**，再决定适配还是把工作台入口置灰
 * （spec §5「破约处置」）。少了这道闸门的后果不是报错：`ctx.slots.inject` 在槽被改名/
 * 改形状时会**静默不生效**，开关按钮就这么从侧栏消失，没有任何一处会喊。
 *
 * 两层都要：运行时（导出还在不在、类还能不能注册）+ 类型（编译期，由 `tsc --noEmit` 跑）。
 * 只验其中一层会漏：类型改了运行时照跑，运行时改了类型可能还对得上。
 */
import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import * as slots from '@deepseek-ai/dsh-client-ui-slots'
import type {
  ComposedProps,
  EntryKeyOf,
  PropsRuntime,
  SlotComponent,
  SlotMap,
  SlotRenderer,
  SlotRendererHost,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallOwnerProps, ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SidebarFooterActionOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'

const require_ = createRequire(import.meta.url)
const PINNED = '0.2.0-rc.2'

describe('包身份：打包信封里的 id 必须等于包名', () => {
  it('tsdown 的 PACKAGE_ID 与 package.json 的 name 逐字相等', () => {
    // DSH 宿主按**包名**建条目、按包名认领 `window.__ModuleLoader__.load({ id })` 的注册。
    // 两个字符串分家的症状是 `bundle ... loaded without registering "<name>"`——响亮，
    // 但发生在别人机器上（改包名的人这边构建产物早就在缓存里）。所以在这里钉死。
    // 路径经 `require_.resolve` 拿（`import.meta.url` 在 vitest 的 transform 下不是 file:
    // URL），不信 cwd——AGENTS.md worktree 纪律第 2 条。
    const pkgPath = require_.resolve('../package.json')
    const name = (JSON.parse(readFileSync(pkgPath, 'utf8')) as { name: string }).name
    const config = readFileSync(join(dirname(pkgPath), 'tsdown.config.ts'), 'utf8')
    expect(config).toContain(`const PACKAGE_ID = '${name}'`)
  })
})

describe('DSH UI 插件 API —— 升级闸门', () => {
  it('钉住的四个包正好是 0.2.0-rc.2（版本一动，下面的断言全都失去意义）', () => {
    for (const pkg of [
      '@deepseek-ai/dsh-client-ui-slots',
      '@deepseek-ai/dsh-client-ui-tool',
      '@deepseek-ai/dsh-api-session-controller',
      '@deepseek-ai/dsh-client-ui-sidebar',
    ]) {
      const meta = require_(`${pkg}/package.json`) as { version: string }
      expect(meta.version, pkg).toBe(PINNED)
    }
  })

  it('slots 的公共运行时导出还在：SlotCore + resolveSlotLabel', () => {
    expect(typeof slots.SlotCore).toBe('function')
    expect(typeof slots.resolveSlotLabel).toBe('function')
  })

  it('SlotCore 仍有本包依赖的那几个方法', () => {
    const core = new slots.SlotCore()
    for (const method of ['register', 'entries', 'entriesOfSlot', 'spec', 'specDynamic', 'subscribe']) {
      expect(typeof (core as unknown as Record<string, unknown>)[method], method).toBe('function')
    }
  })

  it('keyed 注册的语义没变：注册进未声明的槽必须**抛**（这是我们赖以发现 key 打错的机制）', () => {
    const core = new slots.SlotCore()
    expect(() =>
      // 'root' 之外的槽由声明方（ui-tool）在装载时声明；裸 core 里没有，所以这里必须炸。
      (core as unknown as { register: (o: unknown, c: unknown) => void }).register(
        { name: 'tool.call.toolview', key: 'mcp__stream__extract' },
        () => null,
      ),
    ).toThrow()
  })

  it('a-priori 的 root 槽仍被 seed（声明机制本身还活着）', () => {
    const core = new slots.SlotCore()
    expect(core.specDynamic('root')).toBeDefined()
  })
})

// ── 类型层：下面每一行都是编译期断言，`tsc --noEmit` 是它们的执行器。──────────────

/** `tool.call.toolview` 仍在 SlotMap 里，且仍是 keyed / session。 */
type ToolViewEntry = SlotMap['tool.call.toolview']
const _kind: ToolViewEntry['kind'] = 'keyed'
const _scope: ToolViewEntry['scope'] = 'session'

/** owner payload 的必需成员仍在（卡片全靠 `block`），且 block 分两相（running / settled）。 */
//
// **0.2.0 改了形状**：节点从"一个带 `callView` 的块"换成了按 `kind`/`phase` 判别的联合
// （`ToolCallBlock = RunningToolCall | ToolResultNode`，running 那支再分
// `preparing` / `start`），而 owner 也多了 `phase` 这一格。所以这条断言不再能造一个
// 手写对象就过——必须造一个**相自洽**的（`phase: 'result'` + `ToolResultNode`）。
// 读数据的那一侧（`src/tool-result.ts`）从 0.1.2 起就是按 `kind`/`call` 结构读的，
// 没跟着名字跑，所以这次迁移没动它一行代码——差异只在这份类型断言。
const _owner: Pick<ToolCallOwnerProps, 'callId' | 'toolName' | 'block' | 'openFile' | 'phase'> = {
  callId: 'c1',
  toolName: 'mcp__stream__extract',
  phase: 'result',
  block: {
    kind: 'tool-result',
    seq: 1,
    time: 0,
    callId: 'c1',
    call: { name: 'mcp__stream__extract', argsRaw: '{}' },
    callTime: null,
    content: [],
    isError: false,
    subCalls: [],
  },
  openFile: () => {},
}

/** 组合出来的视图 props 仍然包含 owner 的 `block`。 */
type _ViewHasBlock = ToolCallViewProps['block']

/**
 * **卡片那一侧真的收得下**：owner 递来的 `block` 必须仍可赋给 `ToolCallBlock`。
 *
 * 卡片的入参是 `{ block: ToolCallBlock }`（见 `index.tsx` 的 `StreamCard`）。这条断的是
 * "两张契约对得上"——某天 DSH 把 owner 的 block 换成另一个联合、或 ToolCallBlock 从此
 * 两分家，这里就红了，而不是等到每张卡都画不出结果才被发现。
 */
const _cardBlock: ToolCallBlock = null as unknown as ToolCallViewProps['block']
type _RuntimeShare = PropsRuntime<'tool.call.toolview'>

/** keyed 槽的 key 域仍然是开放字符串（我们的 wire 名不在任何编译期枚举里）。 */
const _key: EntryKeyOf<'tool.call.toolview'> = 'mcp__stream__anything'

/** 注册位组件契约与四份 props 合成仍在。 */
type _Composed = ComposedProps<'tool.call.toolview', string, never, undefined, object>
type _Component = SlotComponent<_Composed>

/** 宿主装载渲染器的那两个接口仍在（DSH 侧装载 UI 插件的入口面）。 */
type _Renderer = SlotRenderer
type _RendererHost = SlotRendererHost

/** `sidebar.footer.action` 仍在 SlotMap 里，且仍是 list / root（面板开关按钮挂在这里）。 */
type FooterActionEntry = SlotMap['sidebar.footer.action']
const _footerKind: FooterActionEntry['kind'] = 'list'
const _footerScope: FooterActionEntry['scope'] = 'root'

/** owner payload 只携带列宽状态——按钮渲染 rail 图标还是 wide 行全靠这一个字段。 */
const _footerOwner: Pick<SidebarFooterActionOwnerProps, 'wide'> = { wide: true }

// 让上面的 const 有消费者，避免 noUnusedLocals 之类的规则把它们判成死代码。
describe('类型层断言已编译', () => {
  it('占位：真正的断言在编译期', () => {
    expect([_kind, _scope, _key, typeof _owner.openFile, _owner.phase, _footerKind, _footerScope, _footerOwner.wide])
      .toEqual(['keyed', 'session', 'mcp__stream__anything', 'function', 'result', 'list', 'root', true])
  })
})
