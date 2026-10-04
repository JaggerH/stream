/**
 * 「点会话行」的截获层（`interceptSessionPick`）。
 *
 * 它是那个"再点一次收起对话栏"手势的唯一落点——会话名单是 DSH 画的，我们只能从
 * `uiWorkspace.openSession` 这一处知道用户点了哪行。钉住五件事：
 * 1. 点当前那条 → 报 `isCurrentRow: true`（手势的全部信息量就在这一位上）；
 * 2. 点别的 → 报 false；
 * 3. **无论哪种都照常转发**给原方法——我们只在旁边加布局，不改 DSH 的选中语义；
 * 4. "当前那条"**每次点击时现取**（存一次就冻住了第一下时的答案）；
 * 5. disposer 把方法还原干净（插件卸载/热重载不留残骸）。
 *
 * **这一层证不了活体成立**：DSH 哪天给行的 onClick 加上"已经是当前就不调"的守卫，
 * 这里全绿而手势静默失效。那一端只能靠人在工作台里点一下（见 session-pick.ts 头注）。
 */
import { expect, test, vi } from 'vitest'
import { interceptSessionPick, type SessionNavigationFace } from '../src/client/shell/session-pick.ts'

function makeNavigation(): SessionNavigationFace<string> & { opened: string[] } {
  const opened: string[] = []
  return {
    opened,
    openSession(id: string) { opened.push(id) },
  }
}

test('点当前高亮那条 → 报 isCurrentRow=true，且照常转发', () => {
  const navigation = makeNavigation()
  const onPick = vi.fn()
  interceptSessionPick(navigation, () => 's1', onPick)
  navigation.openSession('s1')
  expect(onPick).toHaveBeenCalledWith(true)
  expect(navigation.opened).toEqual(['s1'])
})

test('点别的会话 → 报 isCurrentRow=false，且照常转发', () => {
  const navigation = makeNavigation()
  const onPick = vi.fn()
  interceptSessionPick(navigation, () => 's1', onPick)
  navigation.openSession('s2')
  expect(onPick).toHaveBeenCalledWith(false)
  expect(navigation.opened).toEqual(['s2'])
})

test('一条都还没选中时（当前为 undefined）不会把点击误判成"点了当前那条"', () => {
  const navigation = makeNavigation()
  const onPick = vi.fn()
  interceptSessionPick(navigation, () => undefined, onPick)
  navigation.openSession('s1')
  expect(onPick).toHaveBeenCalledWith(false)
})

test('"当前那条"每次点击时现取——把判据存一次，第二下就会照着旧答案走', () => {
  const navigation = makeNavigation()
  const onPick = vi.fn()
  // 第一次点的时候高亮还在 s1，第二次已经切到 s2。取一次的实现会让第二次仍报 true，
  // 症状是"点刚切过去的那条，对话栏不收起来"——不报错。
  let current: string | undefined = 's1'
  interceptSessionPick(navigation, () => current, onPick)
  navigation.openSession('s1')
  expect(onPick).toHaveBeenLastCalledWith(true)
  current = 's2'
  navigation.openSession('s2')
  expect(onPick).toHaveBeenLastCalledWith(true)
  // 此刻再点 s1（已经不是当前那条了）必须报 false。
  navigation.openSession('s1')
  expect(onPick).toHaveBeenLastCalledWith(false)
  expect(navigation.opened).toEqual(['s1', 's2', 's1'])
})

test('disposer 把 openSession 还原干净，之后不再报', () => {
  const navigation = makeNavigation()
  const original = navigation.openSession
  const onPick = vi.fn()
  const stop = interceptSessionPick(navigation, () => 's1', onPick)
  stop()
  expect(navigation.openSession).toBe(original)
  navigation.openSession('s1')
  expect(onPick).not.toHaveBeenCalled()
  expect(navigation.opened).toEqual(['s1'])
})

test('包不上时吵一声——这个手势静默失效是唯一会没人知道的坏法', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    // 冻结对象模拟"写不进去"（服务被代理/冻结）：赋值静默失败。
    const navigation: SessionNavigationFace<string> = Object.freeze({
      openSession(_id: string) {},
    })
    const stop = interceptSessionPick(navigation, () => undefined, () => {})
    expect(warn).toHaveBeenCalled()
    expect(() => { stop() }).not.toThrow()
  } finally {
    warn.mockRestore()
  }
})
