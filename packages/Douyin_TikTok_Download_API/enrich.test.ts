import { describe, it, expect } from 'vitest'
import { makeEnrichers, type DouyinCommentsClient, type VideoCommentsPage } from './enrich.ts'
import { ValidationError } from '../../shared/package-sdk/errors.ts'

/** 活体容器（2026-09-19）一条评论的形状裁到映射用得上的字段。`create_time` 是 unix 秒。 */
const rawComment = {
  cid: '7687181035330667301',
  text: '这个要qoder会员才能免费吧？',
  create_time: 1789811309,
  digg_count: 4,
  ip_label: '广东',
  user: {
    nickname: 'PractiseMakeBetter',
    avatar_thumb: { url_list: ['', 'https://p3-pc.douyinpic.com/aweme/100x100/a.jpeg'] },
  },
}

function fakeClient(page: VideoCommentsPage, calls: unknown[][] = []): DouyinCommentsClient {
  return {
    videoComments: async (...a: unknown[]) => {
      calls.push(a)
      return page
    },
  }
}

describe('douyin-comments', () => {
  it('缺 vid → ValidationError（宿主翻 400）', async () => {
    const run = makeEnrichers(fakeClient({ comments: [], total: 0, cursor: 0, hasMore: false }))['douyin-comments']
    await expect(run({})).rejects.toBeInstanceOf(ValidationError)
  })

  it('正常页：字段映射沿用 cid / nickname / 第一条非空头像 / digg_count / ip_label / create_time（秒）；还有下一页 → cursor 是字符串', async () => {
    const calls: unknown[][] = []
    const run = makeEnrichers(fakeClient({ comments: [rawComment], total: 257, cursor: 30, hasMore: true }, calls))['douyin-comments']
    const e = (await run({ vid: '7686747731612576101' })) as {
      comments: Array<Record<string, unknown>>
      total: number
      cursor?: string
    }
    // 缺 cursor → 从 0 开始
    expect(calls).toEqual([['7686747731612576101', 0]])
    expect(e.comments).toEqual([
      {
        id: '7687181035330667301',
        author: 'PractiseMakeBetter',
        avatar: 'https://p3-pc.douyinpic.com/aweme/100x100/a.jpeg',
        text: '这个要qoder会员才能免费吧？',
        like: 4,
        ip: '广东',
        time: 1789811309,
      },
    ])
    expect(e.total).toBe(257)
    expect(e.cursor).toBe('30')
  })

  it('has_more 为 false → 不带 cursor（前端据「有没有 cursor」判还能不能翻页）', async () => {
    const run = makeEnrichers(fakeClient({ comments: [rawComment], total: 1, cursor: 1, hasMore: false }))['douyin-comments']
    const e = (await run({ vid: 'v1' })) as { cursor?: string }
    expect('cursor' in e).toBe(false)
  })

  it('翻页：`cursor` 传给容器；前端把上一页回的 cursor 当 `page` 递回来也认', async () => {
    const calls: unknown[][] = []
    const run = makeEnrichers(fakeClient({ comments: [], total: 257, cursor: 60, hasMore: true }, calls))['douyin-comments']
    await run({ vid: 'v1', cursor: '30' })
    await run({ vid: 'v1', page: '30' })
    await run({ vid: 'v1', cursor: 'garbage' })
    expect(calls).toEqual([['v1', 30], ['v1', 30], ['v1', 0]])
  })

  it('字段缺失时给安全默认（id 空串 / text 空串 / like 0），不抛', async () => {
    const run = makeEnrichers(fakeClient({ comments: [{}], total: 1, cursor: 1, hasMore: false }))['douyin-comments']
    const e = (await run({ vid: 'v1' })) as { comments: Array<Record<string, unknown>> }
    expect(e.comments[0]).toMatchObject({ id: '', text: '', like: 0 })
    expect(e.comments[0].author).toBeUndefined()
    expect(e.comments[0].avatar).toBeUndefined()
  })
})
