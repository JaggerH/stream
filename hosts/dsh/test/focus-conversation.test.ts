/**
 * 侧栏名单点一行 → 右边哪一栏开着（`pickRow`）。布局没有别的入口：分段开关已删，
 * 两栏的开合全由"点频道 / 点会话"这一个动作驱动。
 *
 * 钉住的六件事，各自对应一种真实的误改：
 * 1. 点已选中那行 = 收起它那一栏（那个"再点一次收起"的手势，没了它整个改动就白做）；
 * 2. **只剩一栏时不收**——否则两列全空就是白屏；
 * 3. 那一栏关着时点任意一行 = 把它打开（不然收起来之后回不去，成单行道）；
 * 4. 点的不是选中那行 → 布局纹丝不动（换频道/换会话是常态，不该抖布局）；
 * 5. streamOpen 跨刷新记住（localStorage）——收起主区是个粘住的选择；
 * 6. 亲手收/开过之后，详情联动不再自动动那一列（autoCollapsed 被清）。
 */
import { beforeEach, expect, test } from 'vitest'
import { ShellLayoutController } from '../src/client/shell/layout-service.ts'

beforeEach(() => { localStorage.clear() })

test('双栏下点已高亮的频道 → 收起 Stream 栏，对话留着', () => {
  const c = new ShellLayoutController()
  c.pickRow('stream', true)
  expect(c.getSnapshot()).toMatchObject({ streamOpen: false, conversationOpen: true })
})

test('双栏下点已高亮的会话 → 收起对话栏，Stream 留着', () => {
  const c = new ShellLayoutController()
  c.pickRow('conversation', true)
  expect(c.getSnapshot()).toMatchObject({ streamOpen: true, conversationOpen: false })
})

test('只剩一栏时再点它自己的高亮行 → 什么都不做（绝不两列全空）', () => {
  const onlyConversation = new ShellLayoutController()
  onlyConversation.pickRow('stream', true) // 收掉 Stream，只剩对话
  onlyConversation.pickRow('conversation', true) // 再想把对话也收掉
  expect(onlyConversation.getSnapshot()).toMatchObject({ streamOpen: false, conversationOpen: true })

  // 上半场把 streamOpen=false 写进了 localStorage，下半场要的是"两栏都开着"的干净起点。
  localStorage.clear()
  const onlyStream = new ShellLayoutController()
  onlyStream.pickRow('conversation', true) // 收掉对话，只剩 Stream
  onlyStream.pickRow('stream', true)
  expect(onlyStream.getSnapshot()).toMatchObject({ streamOpen: true, conversationOpen: false })
})

test('那一栏关着时点它的行 → 打开它（收起来不是单行道）', () => {
  const c = new ShellLayoutController()
  c.pickRow('stream', true) // Stream 收起
  c.pickRow('stream', false) // 点任意一条频道
  expect(c.getSnapshot()).toMatchObject({ streamOpen: true, conversationOpen: true })

  c.pickRow('conversation', true) // 对话收起
  c.pickRow('conversation', false)
  expect(c.getSnapshot()).toMatchObject({ streamOpen: true, conversationOpen: true })
})

test('点的不是高亮那行 → 布局纹丝不动', () => {
  const c = new ShellLayoutController()
  c.pickRow('stream', false)
  c.pickRow('conversation', false)
  expect(c.getSnapshot()).toMatchObject({ streamOpen: true, conversationOpen: true })
})

test('收起 Stream 栏跨实例记住：新建 controller 读回上次的 streamOpen', () => {
  const a = new ShellLayoutController()
  a.pickRow('stream', true)
  expect(new ShellLayoutController().getSnapshot().streamOpen).toBe(false)
  a.pickRow('stream', false) // 点频道把它放回来
  expect(new ShellLayoutController().getSnapshot().streamOpen).toBe(true)
})

test('revealStream 把主区放回来；已开着则什么都不做', () => {
  const c = new ShellLayoutController()
  c.pickRow('stream', true)
  expect(c.getSnapshot().streamOpen).toBe(false)
  c.revealStream()
  expect(c.getSnapshot().streamOpen).toBe(true)
  c.revealStream() // 幂等
  expect(c.getSnapshot().streamOpen).toBe(true)
})

test('什么都没收成的那一下，不算"用户接管"——详情的归位照常发生', () => {
  const c = new ShellLayoutController()
  c.setContentDetail(true) // 详情自动收走对话（autoCollapsed=true，只剩 Stream 一栏）
  c.pickRow('stream', true) // 想收 Stream：只剩一栏，收不动 → 这一下什么都没发生
  expect(c.getSnapshot().streamOpen).toBe(true)
  c.setContentDetail(false)
  // 如果那个 no-op 分支顺手清了 autoCollapsed，对话就再也回不来了——那是最难查的一种。
  expect(c.getSnapshot().conversationOpen).toBe(true)
})
