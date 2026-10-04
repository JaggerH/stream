/**
 * 「此刻显示在对话里的那条会话是哪条」——`currentMainSessionId`。
 *
 * 0.2.0 起没有现成答案（`SessionListState` 里那格 `current` 没了），我们从**引用计数**
 * 推：`retainedBy.mainView` 就是"中央对话视图"那一类，ui-workspace 自己的会话浏览器也读
 * 同一格（它的高亮与我们的判据必须永远一致，见 `current-session.ts` 头注）。
 *
 * 钉住四件事：
 * 1. 有 `mainView` 引用的那条被选中；
 * 2. **不是**名册第一条、也不是"最近"那条——目录顺序是用户的手动排序；
 * 3. 引用计数里只有别类来源的行不算数（比如只在某个子代理那儿被引用着）；
 * 4. 名册缺席/空/都无 `mainView` → `undefined`（调用方据此走"新开一条"那条路）。
 */
import { expect, test } from 'vitest'
import { currentMainSessionId } from '../src/client/current-session.ts'

/** 行：`retainedBy` 就是那份按来源分的引用计数。 */
function row(retainedBy: Record<string, number>) { return { retainedBy } }

function ctxOf(list: unknown): never {
  return { sessions: { list: { getSnapshot: () => list } } } as never
}

test('挑出被 mainView 引用着的那条', () => {
  const ctx = ctxOf({
    ids: ['a', 'b', 'c'],
    byId: { a: row({ gateway: 2 }), b: row({ mainView: 1 }), c: row({ controllerOperation: 1 }) },
  })
  expect(currentMainSessionId(ctx)).toBe('b')
})

test('名册第一条不等于当前那条（顺序是用户的手动排序）', () => {
  const ctx = ctxOf({
    ids: ['first', 'second'],
    byId: { first: row({ gateway: 1 }), second: row({ mainView: 1 }) },
  })
  expect(currentMainSessionId(ctx)).toBe('second')
})

test('只在别类来源下被引用着的行不算"当前"', () => {
  const ctx = ctxOf({
    ids: ['a', 'b'],
    byId: { a: row({ subagentView: 1 }), b: row({ gateway: 3 }) },
  })
  expect(currentMainSessionId(ctx)).toBeUndefined()
})

test('mainView 计数为 0（刚释放）也不算', () => {
  const ctx = ctxOf({ ids: ['a'], byId: { a: row({ mainView: 0 }) } })
  expect(currentMainSessionId(ctx)).toBeUndefined()
})

test('名册空 / 服务缺席 → undefined（调用方走"新开一条"）', () => {
  expect(currentMainSessionId(ctxOf({ ids: [], byId: {} }))).toBeUndefined()
  expect(currentMainSessionId({} as never)).toBeUndefined()
})

test('ids 里有、byId 里缺席的行被跳过而不是炸（目录与明细是两个快照）', () => {
  const ctx = ctxOf({ ids: ['ghost', 'real'], byId: { real: row({ mainView: 1 }) } })
  expect(currentMainSessionId(ctx)).toBe('real')
})
