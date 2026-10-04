/**
 * `@` 引用源的三件事：候选按什么顺序出、pick 插进去的是什么、**发出去的那段文字长什么样**。
 *
 * 第三件是这条链路真正的判据——`codec.serialize` 的返回值会被逐字拼进发给模型的 prompt，
 * 它错了就是"引用了但模型什么也没看见"，而且没有任何一处会报错。
 */
import { describe, expect, it } from 'vitest'
import { ItemContextStore, type PanelItemRef } from '../src/client/panel/item-context-store.ts'
import {
  makeStreamRefSource,
  serializeItemRef,
  STREAM_REF_SOURCE_NAME,
} from '../src/client/input/stream-ref-source.ts'
import type { CandidateRequest, ClientSessionContext, InputTriggerPick } from '@deepseek-ai/dsh-client-ui-input-trigger/client'

const SESSION = { sessionId: 's1' } as unknown as ClientSessionContext

// `drilled` / `action` 是 DSH 0.1.2 的下钻（面包屑）那套；本源不实现 `header`，
// 拿不到下钻，所以固定填「没下钻 / 就是一次落定」。
function req(query: string): CandidateRequest {
  return { query, position: 'inline', drilled: false, signal: new AbortController().signal }
}

function pick(name: string): InputTriggerPick {
  return {
    candidate: { name },
    session: SESSION,
    position: 'inline',
    via: 'menu',
    action: 'pick',
    span: { start: 0, end: 1, draftRev: 0 },
  }
}

const ITEM = (over: Partial<PanelItemRef> & { id: string }): PanelItemRef => ({
  title: `标题-${over.id}`,
  ...over,
})

describe('这个源只提供 codec，不进 `@` 菜单', () => {
  // 内容是无限的(时间线里成千上万条),摆进 `@` 菜单就是让用户在一个选不完的列表里翻找。
  // 指着一条内容说"引用它"的入口是右键菜单——他正看着那条,零歧义、零翻找。
  it('候选恒空，手边有多少条都不出', async () => {
    const store = new ItemContextStore()
    store.set({ open: ITEM({ id: 'b' }), recent: [ITEM({ id: 'a' }), ITEM({ id: 'c' })] })
    expect(await makeStreamRefSource(store).candidates(SESSION, req(''))).toEqual([])
    expect(await makeStreamRefSource(store).candidates(SESSION, req('标题'))).toEqual([])
  })

  // **注销掉不是"少一组候选",是让已经插进草稿的引用在发送时找不到序列化器**——
  // 表现是"引用了但模型什么也没看见",而且没有任何一处会报错。
  it('但仍然注册在 `@` 上、且带着 codec：右键插进去的引用靠它转成文字', () => {
    const source = makeStreamRefSource(new ItemContextStore())
    expect(source.trigger).toBe('@')
    expect(source.name).toBe(STREAM_REF_SOURCE_NAME)
    expect(source.codec).toBeDefined()
  })

  it('pick 恒 undefined——菜单里没有我们的候选，被调到就说明那条不是我们出的', () => {
    expect(makeStreamRefSource(new ItemContextStore()).onPick(pick('查无此条'))).toBeUndefined()
  })
})

describe('serialize —— 模型真正看到的那几行', () => {
  it('正文随附，不用等模型自己去调工具', () => {
    const text = serializeItemRef(
      ITEM({ id: 'i1', title: '标题', author: '作者', streamId: 's', url: 'https://e/1', excerpt: '正文内容' }),
      'i1',
    )
    expect(text).toContain('<stream-item id="i1">')
    expect(text).toContain('标题：标题')
    expect(text).toContain('作者：作者')
    expect(text).toContain('来源：s')
    expect(text).toContain('链接：https://e/1')
    expect(text).toContain('正文内容')
    expect(text).toContain('</stream-item>')
    // 没截断就不该出现截断话术——凭空说"到此截断"会诱导模型多跑一次 extract。
    expect(text).not.toContain('正文到此截断')
  })

  it('截断了就明写，并给出加深入口——不写的话模型拿半截当全文', () => {
    const text = serializeItemRef(ITEM({ id: 'i2', excerpt: '前半截', truncated: true }), 'i2')
    expect(text).toContain('正文到此截断')
    expect(text).toContain('extract({item:"i2"})')
  })

  it('没有正文（图集/音视频）→ 明说要现取，并给 id', () => {
    const text = serializeItemRef(ITEM({ id: 'i3' }), 'i3')
    expect(text).toContain('extract({item:"i3"})')
    expect(text).not.toContain('正文：')
  })

  it('面板里已经找不到这条 → 照样交出 id，不抛错', async () => {
    const store = new ItemContextStore()
    const source = makeStreamRefSource(store)
    // 抛错会被 ui-conversation 当成阻断，整条消息发不出去——而"引用的那条不在手边"
    // 完全是正常的（切了频道 / 刷新过）。
    const text = await source.codec!.serialize('gone', new AbortController().signal)
    expect(text).toContain('<stream-item id="gone">')
    expect(text).toContain('extract({item:"gone"})')
  })

  it('取的是发送那一刻的快照，不是插入那一刻的', async () => {
    const store = new ItemContextStore()
    store.set({ open: ITEM({ id: 'i4', excerpt: '旧的' }), recent: [] })
    const source = makeStreamRefSource(store)
    store.set({ open: ITEM({ id: 'i4', excerpt: '新的' }), recent: [] })
    const text = await source.codec!.serialize('i4', new AbortController().signal)
    expect(text).toContain('新的')
    expect(text).not.toContain('旧的')
  })
})

describe('store', () => {
  it('正在看的那条即使不在 recent 里也找得到——详情可以从别处打开', () => {
    const store = new ItemContextStore()
    store.set({ open: ITEM({ id: 'deep' }), recent: [ITEM({ id: 'a' })] })
    expect(store.find('deep')?.id).toBe('deep')
  })

  it('clear 之后不再报"你正在看 X"', () => {
    const store = new ItemContextStore()
    store.set({ open: ITEM({ id: 'a' }), recent: [ITEM({ id: 'a' })] })
    store.clear()
    expect(store.get()).toEqual({ open: null, recent: [], fullscreen: false })
    expect(store.find('a')).toBeUndefined()
  })
})
