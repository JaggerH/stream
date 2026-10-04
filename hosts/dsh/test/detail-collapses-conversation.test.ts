/**
 * 「打开一条详情 → 对话列自动让位，关掉详情 → 它自己回来」。
 *
 * 为什么要有它：这条联动是**两个 bundle 之间**的事——详情开在 panel bundle 里，对话列的
 * 几何住在壳的 controller 上，中间靠 itemContext 那份推送（`open` 非空 = 详情开着）接头。
 * 任何一环断了都不报错，只是"详情开出来挤成一条缝"，看起来像 CSS 没写好。
 *
 * 钉住的三件事，各自对应一种真实的误改：
 * 1. 让位与归位成对（只做前半 = 对话再也回不来）；
 * 2. **用户手动开合赢过自动归位**——详情开着时用户自己把对话叫回来，关详情不该再动它；
 * 3. 只认**边沿**不认电平：itemContext 在详情开着期间会因为列表刷新反复推同一个状态，
 *    照电平做会把用户手动叫回来的对话又收掉一次。
 */
import { expect, test } from 'vitest'
import { ShellLayoutController } from '../src/client/shell/layout-service.ts'

test('详情开 → 对话让位；详情关 → 对话回来', () => {
  const c = new ShellLayoutController()
  expect(c.getSnapshot().conversationOpen).toBe(true)
  c.setContentDetail(true)
  expect(c.getSnapshot().conversationOpen).toBe(false)
  c.setContentDetail(false)
  expect(c.getSnapshot().conversationOpen).toBe(true)
})

test('详情开之前对话本来就是收着的 → 关详情不擅自把它开出来', () => {
  const c = new ShellLayoutController()
  c.pickRow('conversation', true) // 点已高亮的会话行 = 收起对话栏
  expect(c.getSnapshot().conversationOpen).toBe(false)
  c.setContentDetail(true)
  c.setContentDetail(false)
  expect(c.getSnapshot().conversationOpen).toBe(false)
})

test('详情开着时用户手动把对话叫回来 → 关详情不再动它', () => {
  const c = new ShellLayoutController()
  c.setContentDetail(true)
  c.pickRow('conversation', true) // 用户接管：点会话行把它叫回来
  expect(c.getSnapshot().conversationOpen).toBe(true)
  c.setContentDetail(false)
  expect(c.getSnapshot().conversationOpen).toBe(true)
})

test('详情开着期间重复推同一个状态不再收第二次', () => {
  const c = new ShellLayoutController()
  c.setContentDetail(true)
  c.pickRow('conversation', true) // 用户叫回来
  c.setContentDetail(true)        // 列表刷新又推了一次「详情开着」
  expect(c.getSnapshot().conversationOpen).toBe(true)
})

test('对话 UI 要开工具详情列（右列占位者报告 track）→ 对话列跟着回来', () => {
  const c = new ShellLayoutController()
  c.setContentDetail(true)
  expect(c.getSnapshot().conversationOpen).toBe(false)
  // 0.2.0 起右列是**占位者报告**呈现方式（`openRightbar(track, fullscreen)`），不是命令式
  // 开合——所以这条断言的是"报告进来的那一刻，对话列跟着回来"，不是"我们替它把列开出来"。
  c.openRightbar(true, false)
  expect(c.getSnapshot()).toMatchObject({ conversationOpen: true, rightbarTrack: true, rightbarFullscreen: false })
})

test('右列占位者报告收起 → 两个标志位都归位', () => {
  const c = new ShellLayoutController()
  c.openRightbar(true, true)
  expect(c.getSnapshot()).toMatchObject({ rightbarTrack: true, rightbarFullscreen: true })
  c.closeRightbar()
  expect(c.getSnapshot()).toMatchObject({ rightbarTrack: false, rightbarFullscreen: false })
})

test('占位者两格都报 false（等价于收起）走的是同一条路，不留下"半开"的轨道', () => {
  const c = new ShellLayoutController()
  c.openRightbar(true, false)
  c.openRightbar(false, false)
  expect(c.getSnapshot()).toMatchObject({ rightbarTrack: false, rightbarFullscreen: false })
})

test('要把一句话发进对话（转成文字）→ 对话列露出来，且此后不再被自动收走', () => {
  const c = new ShellLayoutController()
  c.setContentDetail(true)
  expect(c.getSnapshot().conversationOpen).toBe(false)
  c.revealConversation()
  expect(c.getSnapshot().conversationOpen).toBe(true)
  // 露出来这一下和用户亲手点开关同权：详情关掉时不该再拿"我收的我放回去"那套动它。
  c.setContentDetail(false)
  expect(c.getSnapshot().conversationOpen).toBe(true)
})

test('对话列本来就开着 → revealConversation 什么都不改', () => {
  const c = new ShellLayoutController()
  c.revealConversation()
  expect(c.getSnapshot().conversationOpen).toBe(true)
})
