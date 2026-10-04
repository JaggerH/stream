import { describe, expect, it, vi } from 'vitest'
import {
  makeNetdiskRefSource,
  makeSubscriptionRefSource,
  netdiskRefText,
  splitDirQuery,
  subscriptionRefText,
  type RefStream,
} from '../src/client/input/reconcile-ref-sources.ts'
import type { CandidateRequest, InputTriggerPick } from '@deepseek-ai/dsh-client-ui-input-trigger/client'

const SESSION = { sessionId: 's1' } as never
// `drilled` / `action` 是 DSH 0.1.2 的下钻（面包屑）那套；这两个源不实现 `header`，
// 拿不到下钻，所以固定填「没下钻 / 就是一次落定」。
const req = (query: string): CandidateRequest =>
  ({ query, position: 'inline', drilled: false, signal: new AbortController().signal })
const pick = (name: string): InputTriggerPick =>
  ({ candidate: { name }, session: SESSION, position: 'inline', via: 'menu', action: 'pick', span: { start: 0, end: 1, draftRev: 1 } })

const STREAMS: RefStream[] = [
  { id: 'lizhi-user-z7o4v', label: '春典JARGON' },
  { id: 'lizhi-user-abc', label: '发发大王' },
]

describe('插进草稿的那串字', () => {
  // 光给名字模型还得再搜一次,同名近名会搜错——而整理动的是真文件。
  it('订阅同时带名字和 id', () => {
    expect(subscriptionRefText({ id: 'lizhi-user-z7o4v', label: '春典JARGON' }))
      .toBe('「春典JARGON」(stream:lizhi-user-z7o4v)')
  })

  it('目录就是路径本身', () => {
    expect(netdiskRefText('/quark/来自：分享/x')).toBe('/quark/来自：分享/x')
  })
})

describe('splitDirQuery —— 查询不带前导斜杠', () => {
  // 活体撞出来的：`@` 后面紧跟的 `/` 会被 DSH 自己的斜杠命令管线抢走（菜单弹的是
  // compact/export/model），所以路径必须从第一段目录名写起。这条守的就是那个形状。
  it('从目录名起写：`quark/` → 列 /quark 全部', () => {
    expect(splitDirQuery('quark/')).toEqual({ dir: '/quark', filter: '' })
  })

  it('末段当过滤词', () => {
    expect(splitDirQuery('quark/来自')).toEqual({ dir: '/quark', filter: '来自' })
  })

  it('不含斜杠 → 列挂载根，整串当过滤词', () => {
    expect(splitDirQuery('qua')).toEqual({ dir: '/', filter: 'qua' })
    expect(splitDirQuery('')).toEqual({ dir: '/', filter: '' })
  })

  it('多层照旧', () => {
    expect(splitDirQuery('quark/来自：分享/播客')).toEqual({ dir: '/quark/来自：分享', filter: '播客' })
  })

  // 手打或粘贴出前导斜杠时照收——同一件事，别为一个多余的斜杠给出空结果。
  it('带了前导斜杠也认', () => {
    expect(splitDirQuery('/quark/来自')).toEqual({ dir: '/quark', filter: '来自' })
  })
})

describe('订阅这一组', () => {
  const src = (rows = STREAMS) => makeSubscriptionRefSource(() => Promise.resolve(rows))

  it('按名字或 id 过滤，pick 出带 id 的那串字', async () => {
    const s = src()
    expect((await s.candidates(SESSION, req('春典'))).map((c) => c.name)).toEqual(['春典JARGON'])
    expect(s.onPick(pick('春典JARGON'))).toEqual({ text: '「春典JARGON」(stream:lizhi-user-z7o4v)' })

    expect((await s.candidates(SESSION, req('z7o4v'))).map((c) => c.name)).toEqual(['春典JARGON'])
  })

  // 两组同时出候选只会让菜单更难挑;打出 `/` 那一刻用户明显在写路径。
  // **判据是"含不含 /"不是"以 / 开头"**——路径查询不带前导斜杠,按开头判会让这一组在
  // `@quark/来自` 时还硬挤在菜单里。
  it('查询里出现斜杠就整组让位，且一次后端都不发', async () => {
    const list = vi.fn(() => Promise.resolve(STREAMS))
    const s = makeSubscriptionRefSource(list)
    expect(await s.candidates(SESSION, req('quark/来自'))).toEqual([])
    expect(await s.candidates(SESSION, req('/quark'))).toEqual([])
    expect(list).not.toHaveBeenCalled()
  })

  it('没有斜杠的普通词照常出候选（和网盘那组并存，各是各的分组）', async () => {
    const s = src()
    expect((await s.candidates(SESSION, req('春典'))).map((c) => c.name)).toEqual(['春典JARGON'])
  })

  // 行名回查表里没有 = 这个候选不是我们出的。插一个指向空气的引用比不插坏得多。
  it('不认识的候选返回 undefined，让管线走默认落点', async () => {
    const s = src()
    await s.candidates(SESSION, req(''))
    expect(s.onPick(pick('别人家的候选'))).toBeUndefined()
  })

  it('重名的订阅在行名上缀 id——否则 pick 会回查到错的那条', async () => {
    const dup: RefStream[] = [{ id: 'a', label: '同名' }, { id: 'b', label: '同名' }]
    const s = src(dup)
    const names = (await s.candidates(SESSION, req(''))).map((c) => c.name)
    expect(names).toEqual(['同名', '同名（b）'])
    expect(s.onPick(pick('同名（b）'))).toEqual({ text: '「同名」(stream:b)' })
  })
})

describe('网盘目录这一组', () => {
  const dirs = ['来自：分享', 'From Stream', '更新']
  const src = () => makeNetdiskRefSource(() => Promise.resolve(dirs))

  it('列上一层、按末段过滤，行名与插入的都是全路径', async () => {
    const s = src()
    const rows = await s.candidates(SESSION, req('quark/来自'))
    expect(rows.map((c) => c.name)).toEqual(['/quark/来自：分享'])
    expect(s.onPick(pick('/quark/来自：分享'))).toEqual({ text: '/quark/来自：分享' })
  })

  // 同一个菜单里 /quark/更新 与 /aliyun/更新 可以同时在;只拿末段当行名就会回查到错的那个。
  it('行名用全路径，不是末段', async () => {
    const s = src()
    const rows = await s.candidates(SESSION, req('quark/'))
    expect(rows.map((c) => c.name)).toEqual(['/quark/来自：分享', '/quark/From Stream', '/quark/更新'])
  })

  // 空查询要能列出挂载根——否则用户打完 `@` 看不到任何网盘入口,只能靠记忆盲敲盘名。
  it('空查询列挂载根', async () => {
    const s = makeNetdiskRefSource(() => Promise.resolve(['quark', 'aliyun']))
    expect((await s.candidates(SESSION, req(''))).map((c) => c.name)).toEqual(['/quark', '/aliyun'])
  })

  it('根目录下不拼出双斜杠', async () => {
    const s = makeNetdiskRefSource(() => Promise.resolve(['quark']))
    expect((await s.candidates(SESSION, req('qua'))).map((c) => c.name)).toEqual(['/quark'])
  })
})

describe('三组共存', () => {
  // 同一个触发字符下分组名必须唯一,重名注册会抛——而它们都注册在同一个 `@` 上。
  it('两个新源的分组名互不相同，也不撞已有的内容源', () => {
    const a = makeSubscriptionRefSource(() => Promise.resolve([]))
    const b = makeNetdiskRefSource(() => Promise.resolve([]))
    expect(new Set([a.name, b.name, 'stream']).size).toBe(3)
    expect(a.trigger).toBe('@')
    expect(b.trigger).toBe('@')
  })
})
