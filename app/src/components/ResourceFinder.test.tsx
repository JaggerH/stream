import { StrictMode } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ResourceFinder } from './ResourceFinder.tsx'
import type { NetdiskMountsView } from '../lib/types.ts'
import { api, type Connection } from '../lib/api.ts'

const conn = { baseUrl: 'http://x' } as Connection

const mountsView = (over: Partial<NetdiskMountsView> = {}): NetdiskMountsView => ({
  presets: [], mounts: [], alistReachable: true, searchableSourceTypes: ['magnet', 'ed2k', 'quark'], ...over,
})

const magnetRelease = {
  source: 'nyaa', title: 'Show S01E01 1080p', quality: '1080p' as const,
  sourceType: 'magnet' as const, coverage: { kind: 'unknown' as const },
  link: 'magnet:?xt=urn:btih:aaaa', parsed: true,
}
const baiduRelease = {
  source: 'pansou', title: 'Show 百度合集', quality: '1080p' as const,
  sourceType: 'baidu' as const, coverage: { kind: 'unknown' as const },
  link: 'https://pan.baidu.com/s/bbb', parsed: true,
  links: [{ url: 'https://pan.baidu.com/s/bbb', type: 'baidu' as const }],
}
const quarkRelease = (over: Partial<{ title: string; link: string }> = {}) => ({
  source: 'pansou', title: 'Show 夸克合集', quality: '1080p' as const,
  sourceType: 'quark' as const, coverage: { kind: 'unknown' as const },
  link: 'https://pan.quark.cn/s/aaa111', parsed: true, ...over,
})

/** Feed the panel an arbitrary release set. */
const streamOf = (releases: unknown[]) =>
  vi.spyOn(api, 'videoSearchStream').mockImplementation(async (_c, _q, _nsfw, onEvent) => {
    onEvent({ type: 'init', sources: [{ key: 'pansou', label: 'pansou' }] })
    onEvent({
      type: 'source', key: 'pansou',
      part: { shows: [], loose: releases as never },
      timing: { key: 'pansou', label: 'pansou', ms: 10, count: releases.length, dropped: 0, status: 'ok' },
    })
    onEvent({ type: 'done' })
  })

const alive = (files: string[] = ['黄 粱 一 梦']) =>
  ({ validity: 'alive' as const, files: files.map((name) => ({ name, is_dir: true, size: 0 })), netdisk: 'quark', pwd_id: 'aaa111' })
const dead = () => ({ validity: 'not-usable' as const, files: [], netdisk: 'quark', pwd_id: 'aaa111' })

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(api.netdisk, 'mounts').mockResolvedValue(mountsView())
  // default: verification says nothing — the existing suite is about filtering, not liveness
  vi.spyOn(api.netdisk, 'verifyShare').mockRejectedValue(new Error('501'))
  vi.spyOn(api, 'videoSearchStream').mockImplementation(async (_c, _q, _nsfw, onEvent) => {
    onEvent({ type: 'init', sources: [{ key: 'nyaa', label: 'nyaa' }] })
    onEvent({
      type: 'source', key: 'nyaa',
      part: { shows: [], loose: [magnetRelease, baiduRelease] },
      timing: { key: 'nyaa', label: 'nyaa', ms: 10, count: 2, dropped: 0, status: 'ok' },
    })
    onEvent({ type: 'done' })
  })
})

describe('ResourceFinder', () => {
  it('默认按允许集过滤：百度未挂 → 百度结果不显示，磁力显示', async () => {
    render(<ResourceFinder conn={conn} query="Show" />)
    await waitFor(() => expect(screen.getByText('Show S01E01 1080p')).toBeTruthy())
    expect(screen.queryByText('Show 百度合集')).toBeNull()
  })

  it('「显示全部」打开 → 被过滤的重新出现', async () => {
    render(<ResourceFinder conn={conn} query="Show" />)
    await waitFor(() => expect(screen.getByText('Show S01E01 1080p')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /显示全部/ }))
    expect(screen.getByText('Show 百度合集')).toBeTruthy()
  })

  it('有结果被过滤掉 → 明确告知条数，不伪装成无结果', async () => {
    render(<ResourceFinder conn={conn} query="Show" />)
    await waitFor(() => expect(screen.getByText(/1 条被过滤/)).toBeTruthy())
  })

  it('AList 不可达 → 降级提示，允许集退到 magnet/ed2k', async () => {
    vi.spyOn(api.netdisk, 'mounts').mockResolvedValue(mountsView({ alistReachable: false, searchableSourceTypes: ['magnet', 'ed2k'] }))
    render(<ResourceFinder conn={conn} query="Show" />)
    await waitFor(() => expect(screen.getByText(/AList 不可达/)).toBeTruthy())
  })

  it('后端去重丢掉的条数照实说出来（timing.dropped 有人显示，不是白加的字段）', async () => {
    vi.spyOn(api, 'videoSearchStream').mockImplementation(async (_c, _q, _nsfw, onEvent) => {
      onEvent({ type: 'init', sources: [{ key: 'nyaa', label: 'nyaa' }] })
      onEvent({
        type: 'source', key: 'nyaa',
        part: { shows: [], loose: [magnetRelease] },
        timing: { key: 'nyaa', label: 'nyaa', ms: 10, count: 1, dropped: 3, status: 'ok' },
      })
      onEvent({ type: 'done' })
    })
    render(<ResourceFinder conn={conn} query="Show" />)
    await waitFor(() => expect(screen.getByText(/3 条重复已合并/)).toBeTruthy())
  })

  it('某源全是重复（count=0 且 dropped>0）→ 不谎报「无结果」', async () => {
    vi.spyOn(api, 'videoSearchStream').mockImplementation(async (_c, _q, _nsfw, onEvent) => {
      onEvent({ type: 'init', sources: [{ key: 'u3c3', label: 'u3c3' }] })
      onEvent({
        type: 'source', key: 'u3c3',
        part: { shows: [], loose: [] },
        timing: { key: 'u3c3', label: 'u3c3', ms: 10, count: 0, dropped: 2, status: 'empty' },
      })
      onEvent({ type: 'done' })
    })
    render(<ResourceFinder conn={conn} query="Show" />)
    await waitFor(() => expect(screen.getByText(/2 条重复已合并/)).toBeTruthy())
    expect(screen.queryByText(/没有找到资源/)).toBeNull()
  })

  it('真无结果 → 空态', async () => {
    vi.spyOn(api, 'videoSearchStream').mockImplementation(async (_c, _q, _nsfw, onEvent) => {
      onEvent({ type: 'init', sources: [] })
      onEvent({ type: 'done' })
    })
    render(<ResourceFinder conn={conn} query="Show" />)
    await waitFor(() => expect(screen.getByText(/没有找到资源/)).toBeTruthy())
  })

  it('分面树里的 release 也摊平进列表（不只看 loose）', async () => {
    vi.spyOn(api, 'videoSearchStream').mockImplementation(async (_c, _q, _nsfw, onEvent) => {
      onEvent({ type: 'init', sources: [{ key: 'btbtla', label: 'BT影视' }] })
      onEvent({
        type: 'source', key: 'btbtla',
        part: {
          shows: [{
            source: 'btbtla', title: 'Show 第一季', season: 1, total: 8,
            qualities: [{ quality: '1080p', releases: [magnetRelease], coverage: { total: 8, episodes: [1], missing: [], hasPack: false } }],
          }],
          loose: [],
        },
        timing: { key: 'btbtla', label: 'BT影视', ms: 10, count: 1, dropped: 0, status: 'ok' },
      })
      onEvent({ type: 'done' })
    })
    render(<ResourceFinder conn={conn} query="Show" />)
    await waitFor(() => expect(screen.getByText('Show S01E01 1080p')).toBeTruthy())
  })
})

describe('ResourceFinder — 源计时面板', () => {
  // 「哪几个源正在检索」不该等到有结果才可见:init 一到就全摆出来。
  it('init 一到就列出所有源，未完成的显示「计时中」', async () => {
    let emit: ((ev: any) => void) | null = null
    vi.spyOn(api, 'videoSearchStream').mockImplementation(async (_c, _q, _nsfw, onEvent) => {
      onEvent({ type: 'init', sources: [{ key: 'nyaa', label: 'Nyaa' }, { key: 'pansou', label: '盘搜' }] })
      await new Promise<void>((r) => { emit = (ev) => { onEvent(ev); r() } })
    })
    render(<ResourceFinder conn={conn} query="Show" />)
    await waitFor(() => expect(screen.getByText('Nyaa')).toBeTruthy())
    expect(screen.getByText('盘搜')).toBeTruthy()
    // 两个源都还没回 → 都是「计时中」
    expect(screen.getAllByText('计时中')).toHaveLength(2)
    expect(emit).toBeTruthy()
  })

  // 计时要「活着走」,不是停在 0.0s 等结果到了一跳。一个还在跑的源,它那行的秒数必须随时间涨——
  // 否则面板等于只在最后报一次数,中途完全不告诉你它在干活。
  const stayPending = () =>
    vi.spyOn(api, 'videoSearchStream').mockImplementation(async (_c, _q, _nsfw, onEvent, signal) => {
      onEvent({ type: 'init', sources: [{ key: 'nyaa', label: 'nyaa' }] })
      // 不发 source / done：源还在跑。被 abort 时像真 fetch 一样以 AbortError 拒绝。
      await new Promise<void>((_res, rej) => {
        signal?.addEventListener('abort', () => rej(new Error('AbortError')))
      })
    })

  const secsOf = (container: HTMLElement) => Number(container.textContent?.match(/(\d+\.\d+)s/)?.[1] ?? -1)

  it('未完成的源行走秒 —— 计时是活的,不是最后一跳', async () => {
    stayPending()
    const { container } = render(<ResourceFinder conn={conn} query="Show" />)
    await screen.findByText('计时中')
    expect(secsOf(container)).toBe(0)
    await waitFor(() => expect(secsOf(container)).toBeGreaterThanOrEqual(0.4), { timeout: 2000 })
  })

  // StrictMode 会把 effect 跑两遍：第一遍的搜索被 abort → promise 以 AbortError 拒绝 →
  // 那个 .catch 把**第二遍那个还活着的搜索**的 loading 关掉 → elapsedMs 走 `: 0` 分支 →
  // 每行永远 0.0s,只能等各自的 tm.ms 到达时一跳。被作废的旧运行绝不能写当前运行的 state。
  it('StrictMode 下被中止的旧搜索不得关掉活着那次的 loading（否则走秒死在 0.0s）', async () => {
    stayPending()
    const { container } = render(
      <StrictMode>
        <ResourceFinder conn={conn} query="Show" />
      </StrictMode>,
    )
    await screen.findByText('计时中')
    await waitFor(() => expect(secsOf(container)).toBeGreaterThanOrEqual(0.4), { timeout: 2000 })
  })

  it('源完成后行定格成结果数；空/错误显示对应状态', async () => {
    vi.spyOn(api, 'videoSearchStream').mockImplementation(async (_c, _q, _nsfw, onEvent) => {
      onEvent({ type: 'init', sources: [{ key: 'nyaa', label: 'Nyaa' }, { key: 'pansou', label: '盘搜' }] })
      onEvent({ type: 'source', key: 'nyaa', part: { shows: [], loose: [magnetRelease] }, timing: { key: 'nyaa', label: 'Nyaa', ms: 1200, count: 1, dropped: 0, status: 'ok' } })
      onEvent({ type: 'source', key: 'pansou', part: { shows: [], loose: [] }, timing: { key: 'pansou', label: '盘搜', ms: 800, count: 0, dropped: 0, status: 'empty' } })
      onEvent({ type: 'done' })
    })
    render(<ResourceFinder conn={conn} query="Show" />)
    await waitFor(() => expect(screen.getByText('1 条')).toBeTruthy())
    expect(screen.getByText('无结果')).toBeTruthy()
    expect(screen.getByText('1.2s')).toBeTruthy()
  })

  // 面板行是按钮 —— 看着能点就必须真能用,否则是个假affordance
  it('点源行 → 该源的结果被隐藏', async () => {
    render(<ResourceFinder conn={conn} query="Show" />)
    await waitFor(() => expect(screen.getByText('Show S01E01 1080p')).toBeTruthy())
    // 源名同时出现在计时面板按钮和每行的源徽章里 → 用面板行的 title 精准点它,别用歧义的 getByText
    fireEvent.click(screen.getByTitle('隐藏 nyaa 的结果'))
    await waitFor(() => expect(screen.queryByText('Show S01E01 1080p')).toBeNull())
    fireEvent.click(screen.getByTitle('恢复 nyaa 的结果'))
    await waitFor(() => expect(screen.getByText('Show S01E01 1080p')).toBeTruthy())
  })
})

describe('ResourceFinder — 验活与转存', () => {
  it('活链显示文件数,文件名进 title(是不是我要的那个,看文件名最准)', async () => {
    streamOf([quarkRelease()])
    vi.spyOn(api.netdisk, 'verifyShare').mockResolvedValue(alive(['黄 粱 一 梦', '第二集']))
    render(<ResourceFinder conn={conn} query="Show" />)
    const badge = await screen.findByText('2 个文件')
    expect(badge.getAttribute('title')).toBe('黄 粱 一 梦\n第二集')
  })

  it('死链默认隐藏,但把条数说出来,并且能点开看', async () => {
    streamOf([quarkRelease()])
    vi.spyOn(api.netdisk, 'verifyShare').mockResolvedValue(dead())
    render(<ResourceFinder conn={conn} query="Show" />)
    // 行被藏起来,但不是假装没搜到
    await waitFor(() => expect(screen.queryByText('Show 夸克合集')).toBeNull())
    const toggle = await screen.findByText(/1 条已失效/)
    fireEvent.click(toggle)
    await waitFor(() => expect(screen.getByText('Show 夸克合集')).toBeTruthy())
    expect(screen.getByText('已失效')).toBeTruthy()
  })

  // 最要紧的一条:没接的网盘 ≠ 死链。把"我们没检查过"显示成"已失效"是撒谎。
  it('验活不可用(501/网络故障)时不标死链,也不隐藏该行', async () => {
    streamOf([quarkRelease()])
    vi.spyOn(api.netdisk, 'verifyShare').mockRejectedValue(new Error('501 no verify provider'))
    render(<ResourceFinder conn={conn} query="Show" />)
    await waitFor(() => expect(screen.getByText('Show 夸克合集')).toBeTruthy())
    expect(screen.queryByText('已失效')).toBeNull()
    expect(screen.queryByText(/条已失效/)).toBeNull()
  })

  // 501 那条的孪生:后端说 unknown(夸克限流/5xx/网络故障 → 我们没查成)同样不是判决。
  // 它和 501 唯一的区别是失败发生在后端,对这条链的无知程度一模一样。
  it('后端 unknown(没查成) ≠ 死链:不标死、不隐藏、不给转存', async () => {
    streamOf([quarkRelease()])
    vi.spyOn(api.netdisk, 'verifyShare').mockResolvedValue({ validity: 'unknown', files: [], netdisk: 'quark', pwd_id: 'aaa111' })
    const { container } = render(<ResourceFinder conn={conn} query="Show" />)
    // 等验活真的落定(转圈消失)再断言——否则这些断言在 checking 阶段就会假绿
    await waitFor(() => expect(container.querySelector('.animate-spin')).toBeNull())
    expect(screen.getByText('Show 夸克合集')).toBeTruthy()
    expect(screen.queryByText('已失效')).toBeNull()
    expect(screen.queryByText(/条已失效/)).toBeNull()
    // 没查成的链不该给转存按钮——转存一条我们都没验过的链是在赌
    expect(screen.queryByText('转存')).toBeNull()
  })

  it('需登录 ≠ 死链:单独标注,行不隐藏', async () => {
    streamOf([quarkRelease()])
    vi.spyOn(api.netdisk, 'verifyShare').mockResolvedValue({ validity: 'needs-login', files: [], netdisk: 'quark', pwd_id: 'aaa111' })
    render(<ResourceFinder conn={conn} query="Show" />)
    await waitFor(() => expect(screen.getByText('需登录')).toBeTruthy())
    expect(screen.getByText('Show 夸克合集')).toBeTruthy()
  })

  it('活链才给转存按钮,点了带 link + 提取码调后端', async () => {
    streamOf([quarkRelease({ link: 'https://pan.quark.cn/s/aaa111' })])
    vi.spyOn(api.netdisk, 'verifyShare').mockResolvedValue(alive())
    const saveShare = vi.spyOn(api.netdisk, 'saveShare').mockResolvedValue({ saved: true, stage: 'done', message: '分享-转存', dest: 'From Stream', file_count: 1 })
    render(<ResourceFinder conn={conn} query="Show" />)
    const btn = await screen.findByLabelText('转存 Show 夸克合集')
    fireEvent.click(btn)
    await waitFor(() => expect(saveShare).toHaveBeenCalledWith(conn, { link: 'https://pan.quark.cn/s/aaa111', passcode: undefined }))
  })

  // 从作品详情页进来(带 work.ref)→ 转存走「自动绑定」闭环:带 bind 调后端,绑定成功后
  // 通知详情页刷新。这一步是「转存→能播」闭环的接线,没它就得手动去建绑定。
  it('带作品 ref 时,转存带 bind + 绑定成功后回调刷新', async () => {
    streamOf([quarkRelease({ link: 'https://pan.quark.cn/s/aaa111' })])
    vi.spyOn(api.netdisk, 'verifyShare').mockResolvedValue(alive())
    const saveShare = vi.spyOn(api.netdisk, 'saveShare').mockResolvedValue({
      saved: true, stage: 'done', message: '分享-转存', dest: 'From Stream/流浪地球2', file_count: 1,
      binding: { id: 'map_1', dirPath: '/quark/From Stream/流浪地球2', total: 1, matched: 1, unaired: 0, playable: [{ leftKey: 'tmdb:842675', title: '流浪地球2' }] },
    })
    const onBound = vi.fn()
    const work = { ref: { id: '842675', media: 'tv' as const, title: '流浪地球2' } }
    render(<ResourceFinder conn={conn} query="流浪地球2" work={work} onBound={onBound} />)
    fireEvent.click(await screen.findByLabelText('转存 Show 夸克合集'))
    await waitFor(() => expect(saveShare).toHaveBeenCalledWith(conn, {
      link: 'https://pan.quark.cn/s/aaa111', passcode: undefined, bind: work.ref,
    }))
    await waitFor(() => expect(onBound).toHaveBeenCalled())
  })

  // 绑定报错(比如夸克建目录失败)不该谎报成功刷新——转存本身可能成了,但没配上就没得播。
  it('绑定返回 error 时不触发刷新', async () => {
    streamOf([quarkRelease({ link: 'https://pan.quark.cn/s/aaa111' })])
    vi.spyOn(api.netdisk, 'verifyShare').mockResolvedValue(alive())
    vi.spyOn(api.netdisk, 'saveShare').mockResolvedValue({
      saved: true, stage: 'done', message: '分享-转存', dest: 'From Stream/x',
      binding: { error: 'AList 不可达' },
    })
    const onBound = vi.fn()
    const saveShare = vi.spyOn(api.netdisk, 'saveShare')
    render(<ResourceFinder conn={conn} query="x" work={{ ref: { id: '1', media: 'movie', title: 'x' } }} onBound={onBound} />)
    fireEvent.click(await screen.findByLabelText('转存 Show 夸克合集'))
    await waitFor(() => expect(saveShare).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 20)) // 让转存后的 onBound? 有机会触发(它不该)
    expect(onBound).not.toHaveBeenCalled()
  })

  it('死链不给转存按钮 —— 对一条打不开的链提供「转存」是骗点击', async () => {
    streamOf([quarkRelease()])
    vi.spyOn(api.netdisk, 'verifyShare').mockResolvedValue(dead())
    render(<ResourceFinder conn={conn} query="Show" />)
    fireEvent.click(await screen.findByText(/1 条已失效/)) // 先显示出来
    await waitFor(() => expect(screen.getByText('Show 夸克合集')).toBeTruthy())
    expect(screen.queryByLabelText('转存 Show 夸克合集')).toBeNull()
  })

  it('磁力链不发验活请求 —— 它没有"存活"这回事可查', async () => {
    streamOf([magnetRelease])
    const verify = vi.spyOn(api.netdisk, 'verifyShare').mockResolvedValue(alive())
    render(<ResourceFinder conn={conn} query="Show" />)
    await waitFor(() => expect(screen.getByText('Show S01E01 1080p')).toBeTruthy())
    expect(verify).not.toHaveBeenCalled()
  })
})
